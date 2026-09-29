// 本文件协调规划、串行开发、隔离评估和真实验收，所有状态只由调度器更新。
import { phasePrompt, employeePrompt } from './prompts.mjs';
import { validatePlan, validateWork, validateEvaluation, validateDispatch } from './protocol.mjs';
import { assignEmployee, executionTimeoutMs, requireTeam, team, validateAssignments, eligibleEmployees, taskCapability } from './employees.mjs';
import { DeliveryManager, deliveryInstruction, deliveryRepairInstruction } from './delivery.mjs';
import { instructionKind } from './context.mjs';
import { currentBlocker } from '../public/context-state.js';

class Interrupted extends Error {}

export class Orchestrator {
  // constructor 注入持久化、Git 和运行模块，便于通过模拟宿主验证调度行为。
  constructor({ store, git, runtime, retryDelayMs = 1000, delivery = null, leasePool = null, repositoryLock = null, mergeLock = null }) {
    this.store = store; this.git = git; this.runtime = runtime; this.controls = new Map(); this.retryDelayMs = retryDelayMs; this.steering = new Set();
    this.delivery = delivery || new DeliveryManager({ store, git, runtime });
    Object.assign(this, { leasePool, repositoryLock, mergeLock });
  }

  // start 为项目建立唯一调度上下文，旧轮次退出前禁止重入。
  start(id, { deliveryRepair = false } = {}) {
    if (this.delivery.jobs.has(id)) throw new Error('请等待交付构建完成后再执行项目');
    if (this.teamBuilder?.jobs.has(id)) throw new Error('God 正在搭建团队，请等待或取消');
    const project = this.store.project(id);
    if (!project) throw new Error('项目不存在');
    requireTeam(project);
    if (!project.active_goal_id) throw new Error('请先在项目中提出需求');
    if (deliveryRepair && project.status !== 'completed') throw new Error('项目正在开发或等待处理，请在项目中继续执行交付任务');
    if (!deliveryRepair && project.status === 'completed') throw new Error('本次目标已完成，请提出新的需求');
    if (!deliveryRepair && project.resume_phase === 'execute' && project.settings.confirmationMode === 'manual' && !project.plan_approved) throw new Error('请先在拆解预览中确认计划');
    if (this.controls.has(id)) throw new Error('项目仍在运行或停止中');
    for (const { process_id: pid } of this.store.interruptedProcesses(id)) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) throw new Error(`上次运行的进程 ${pid} 仍存在，请确认并停止该进程后继续，避免同时修改源码。`);
    }
    if (this.store.questions(id).some((question) => question.answer === null)) throw new Error('请先回答当前问题');
    // 用户点击准备交付即补充同一目标的交付任务，由负责人分配员工并沿用开发、验收和修复循环。
    if (deliveryRepair) {
      const instruction = deliveryRepairInstruction(project);
      this.store.instruction(id, instruction, 'repair');
      this.store.repair(id, instruction, '准备可使用的项目预览与交付');
      if (project.settings.delivery) this.store.saveDelivery(id, undefined);
      this.store.update(id, { resume_phase: 'execute', plan_approved: 1 });
      this.store.event(id, 'delivery.assigned', '已交给项目负责人安排员工准备交付，构建失败将继续修复');
    }
    const control = { id, abort: new AbortController(), cancelled: false, handles: new Set(), busyEmployees: new Set(), interrupted: new Set(), timer: null, evaluation: null, directive: null, work: null, workRun: null, feedback: '', evalFailures: 0 };
    this.controls.set(id, control);
    this.store.update(id, { status: !deliveryRepair && project.resume_phase === 'plan' ? 'planning' : 'running', failures: 0, next_evaluation: null,
      summary: deliveryRepair ? '项目负责人正在安排员工准备预览与交付。' : project.resume_phase === 'plan' ? '规划 Agent 正在分析目标、拆解任务与制定测试项目。' : '正在恢复未完成任务，已有源码与记录已保留。' });
    this.store.event(id, 'project.started', '开始持续执行目标');
    control.promise = this.drive(control).catch((error) => {
      if (!(error instanceof Interrupted)) {
        this.store.update(id, { status: 'blocked', summary: error.message });
        this.store.event(id, 'project.error', error.stack || error.message);
      }
    }).finally(async () => {
      clearTimeout(control.timer);
      control.cancelled = true; control.abort.abort();
      for (const handle of control.handles) handle.stop();
      if (control.evaluation) await control.evaluation;
      this.store.update(id, { next_evaluation: null });
      if (!control.pausing) this.controls.delete(id);
    });
  }

  // approve 将人工确认记录落库，再启动开发；普通继续接口无法绕过确认。
  approve(id) {
    const project = this.store.project(id);
    if (!project || project.status !== 'awaiting_approval' || this.controls.has(id)) throw new Error('计划尚未准备好确认，请稍后再试');
    this.store.update(id, { plan_approved: 1 });
    this.store.event(id, 'plan.approved', '用户确认任务拆解与测试项目，开始实现');
    this.start(id);
  }

  // pause 停止所属进程树并等待退出，然后保存源码检查点。
  async pause(id) {
    const control = this.controls.get(id);
    if (!control) return;
    if (control.pausePromise) return control.pausePromise;
    control.pausing = true;
    // settlePause 在检查点保存完成前保留项目锁，避免继续请求与暂停清理同时写入。
    control.pausePromise = (async () => {
      control.cancelled = true; control.abort.abort();
      control.retryWake?.();
      clearTimeout(control.timer);
      this.store.event(id, 'project.pausing', '正在停止 Agent 与测试进程');
      for (const handle of control.handles) handle.stop();
      await control.promise;
      for (const task of this.store.tasks(id)) if (task.status === 'running') this.store.task(task.id, 'pending', '运行已暂停');
      for (const check of this.store.checks(id)) if (check.status === 'running') this.store.check(check.id, 'pending', check.output);
      try { await this.git.checkpoint(id, 'chore: checkpoint before pause'); }
      catch (error) { this.store.event(id, 'git.checkpoint_failed', error.message); }
      this.store.update(id, { status: 'paused', summary: '已暂停，源码和执行记录已保留。', next_evaluation: null });
      this.store.event(id, 'project.paused', '已暂停执行');
      this.controls.delete(id);
    })();
    return control.pausePromise;
  }

  // close 关闭服务时等待全部项目停止，防止数据库先于回调关闭。
  async close() { await this.teamBuilder?.close(); await this.delivery.close(); await Promise.all([...this.controls.keys()].map((id) => this.pause(id))); }

  // steer 等待当前进程安全退出后保存补充要求，再按原目标恢复执行。
  async steer(id, content, goalId, kind = 'requirement') {
    kind = instructionKind(content, kind);
    if (this.store.project(id)?.status === 'awaiting_approval') throw new Error('请先确认计划');
    if (this.steering.has(id)) throw new Error('正在处理上一条补充指令，请稍后再发送');
    const project = this.store.project(id);
    if (!project) throw new Error('项目不存在');
    if (project.status === 'completed') throw new Error('项目已完成，请新建目标开始新的工作');
    if (this.store.questions(id).some((question) => question.answer === null)) throw new Error('请先回答待处理问题，再补充执行指令');
    this.steering.add(id);
    try {
      await this.pause(id);
      if (this.store.project(id).status === 'completed') throw new Error('项目已经完成，补充指令未发送');
      this.store.instruction(id, content, kind);
      if (kind === 'requirement') this.store.requestReplan(id, '收到补充要求，负责人将结合已有成果更新任务与验收条件。');
      else if (kind === 'repair' && this.store.tasks(id).length && this.store.tasks(id).every(task => task.status === 'done')) this.store.repair(id, content);
      this.start(id);
    } finally { this.steering.delete(id); }
  }

  // assertActive 阻止已暂停轮次继续修改项目状态。
  assertActive(control) { if (control.cancelled) throw new Interrupted('执行已暂停'); }

  // context 发送结构化状态与必要证据，完整日志保留在数据库，避免逐轮重复注入工具输出。
  context(id) {
    const project = this.store.project(id), delivery = this.delivery.snapshot(id), release = delivery.release;
    const latestRun = this.store.latestContextRun(id);
    return JSON.stringify({ projectId: id, goalId: project.active_goal_id, status: project.status, resumePhase: project.resume_phase, latestRun,
      currentBlocker: currentBlocker({ ...project, latestRun }), requirementSnapshot: this.store.requirementSnapshot(id),
      projectName: project.name, repository: this.git.paths(id).repo, mainBranch: project.main_branch,
      goal: project.goal, summary: project.summary.slice(0, 1200), platform: process.platform, projectContext: project.settings.context || '',
      delivery: { configSource: delivery.configSource, savedConfig: delivery.config,
        repositoryConfig: '读取当前工作目录的 goalhub.delivery.json；历史构建快照不代表当前文件。',
        responsibility: '员工维护仓库文件；调度器负责构建、端口选择与发布。无需用户提供 GoalHub 地址或修改面板。',
        building: delivery.building, lastBuild: release ? { status: release.status, commit: release.commit, preview: release.preview, port: release.port,
          evidence: release.log.slice(-1800), note: '仅为历史构建证据，修改后的文件由下次构建验证。' } : null },
      employees: team(project).map(employee => ({ id: employee.id, name: employee.name, position: employee.position, capabilities: employee.capabilities, enabled: employee.enabled, isLead: employee.isLead, busy: !!this.leasePool?.busy(`${id}:${employee.id}`) })),
      tasks: this.store.tasks(id).map(task => ({ id: task.id, title: task.title, status: task.status, requiredCapability: task.required_capability, assignee: task.assignee, depends_on: task.depends_on,
        check_ids: task.check_ids, ...(task.status !== 'done' ? { description: task.description, done_when: task.done_when } : {}), result: task.result.slice(-1000) })),
      checks: this.store.checks(id).map(check => ({ id: check.id, title: check.title, command: check.command, expectation: check.expectation, status: check.status,
        checked_at: check.checked_at, output: check.output.slice(check.status === 'passed' ? -400 : -2500) })),
      questions: this.store.questions(id).map(({ id, prompt, details, answer, created_at, answered_at }) => ({ id, prompt, details, answer, created_at, answered_at })),
      instructions: this.store.instructions(id).map(({ id, content, kind, created_at, resolved_at, task_id }) => ({ id, content, kind, created_at, resolved_at, task_id })), recentEvents: [] });
  }

  // agent 保存提示词和流事件，统一处理超时、主动中断和真实退出错误。
  async agent(control, role, cwd, input, working = false, employeeId = '') {
    this.assertActive(control);
    const project = this.store.project(control.id), employee = assignEmployee(this.store, project, role, employeeId);
    const timeoutMs = executionTimeoutMs(employee);
    input = employeePrompt(input, employee, project);
    if (control.busyEmployees.has(employee.id)) throw new Error('同一员工的上一轮执行尚未结束');
    const assignment = { employeeId: employee.id, name: employee.name, role, capability: role === 'developer' ? taskCapability(this.store.tasks(control.id).find(task => task.status === 'running') || {}) : role === 'planner' ? 'planning' : 'review', waiting: !!this.leasePool?.busy(`${control.id}:${employee.id}`) };
    control.assignments ||= new Map(); control.assignments.set(employee.id, assignment);
    const releaseEmployee = this.leasePool ? await this.leasePool.acquire(`${control.id}:${employee.id}`, control.abort.signal) : null;
    assignment.waiting = false;
    if (control.cancelled) { releaseEmployee?.(); throw new Interrupted('执行已暂停'); }
    const runId = this.store.beginRun(control.id, role, input, employee);
    control.busyEmployees.add(employee.id);
    let handle, timer, timedOut = false;
    try {
      handle = await this.runtime.host({ hostType: employee.hostType, model: employee.model, reasoningEffort: employee.reasoningEffort, cwd, input,
        sessionId: ['planner', 'coordinator', 'developer'].includes(role) ? this.store.employeeSession(control.id, role, employee.configKey) : '',
        onTelemetry: (value) => this.store.telemetry(runId, value),
        onEvent: (type, content) => this.store.event(control.id, `agent.${type}`, content, runId),
        onSession: (session) => this.store.session(runId, session) });
      control.handles.add(handle);
      this.store.process(runId, handle.pid);
      if (working) { control.work = handle; control.workRun = runId; }
      if (control.cancelled || (working && control.directive)) { control.interrupted.add(runId); handle.stop(); }
      timer = setTimeout(() => { timedOut = true; handle.stop(); }, timeoutMs);
      const result = await handle.done;
      if (control.cancelled || control.interrupted.has(runId)) {
        this.store.finishRun(runId, 'interrupted', result.finalMessage || result.error || '已中断');
        throw new Interrupted('评估或用户请求中断当前轮次');
      }
      if (timedOut || result.error || result.code !== 0) {
        if (result.finalMessage) this.store.event(control.id, 'agent.failed_output', result.finalMessage, runId);
        throw new Error(timedOut ? 'Agent 执行超时，已请求停止进程树' : result.error || `Agent 退出码 ${result.code}`);
      }
      this.store.finishRun(runId, 'completed', result.finalMessage || '');
      this.store.event(control.id, 'agent.finished', result.finalMessage || 'Agent 未返回最终回复', runId);
      return result.finalMessage || '';
    } catch (error) {
      if (!(error instanceof Interrupted)) {
        this.store.finishRun(runId, 'failed', error.message);
        this.store.event(control.id, 'agent.failed', error.message, runId);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      control.busyEmployees.delete(employee.id); releaseEmployee?.(); control.assignments.delete(employee.id);
      control.handles.delete(handle);
      control.interrupted.delete(runId);
      if (control.workRun === runId) { control.work = null; control.workRun = null; }
    }
  }

  // schedule 使用单次计时器，保证同一项目只有一个定时评估。
  schedule(control) {
    if (control.cancelled || control.timer || control.evaluation) return;
    const delay = this.store.project(control.id).settings.evaluationMinutes * 60000;
    this.store.update(control.id, { next_evaluation: new Date(Date.now() + delay).toISOString() });
    control.timer = setTimeout(() => { control.timer = null; this.launchEvaluation(control); }, delay);
    control.timer.unref?.();
  }

  // evaluateNow 允许用户立即触发一次进度检查。
  evaluateNow(id) {
    const control = this.controls.get(id);
    if (!control || this.store.project(id).status !== 'running') throw new Error('项目处于执行中时才能评估');
    if (control.evaluation || control.directive) return;
    clearTimeout(control.timer); control.timer = null;
    this.launchEvaluation(control);
  }

  // launchEvaluation 在隔离目录检查进度，修复或提问时停止当前写入进程。
  launchEvaluation(control) {
    if (control.cancelled || control.evaluation || control.directive) return;
    // 负责人亲自执行任务时不并发启动同一员工的评估，下一次事件再检查进度。
    const leader = team(this.store.project(control.id)).find(employee => employee.enabled && employee.isLead);
    if (control.busyEmployees.has(leader?.id) || this.leasePool?.busy(`${control.id}:${leader?.id}`)) { this.schedule(control); return; }
    this.store.update(control.id, { next_evaluation: null });
    control.evaluation = this.evaluate(control, false).then((result) => {
      control.evalFailures = 0;
      if (control.cancelled) return;
      if (['repair', 'needs_input'].includes(result.action)) {
        control.directive = result;
        if (control.work) { control.interrupted.add(control.workRun); control.work.stop(); }
      }
    }).catch((error) => {
      if (control.cancelled || error instanceof Interrupted) return;
      this.store.event(control.id, 'evaluation.error', error.message);
      if (++control.evalFailures >= 3) {
        control.directive = { action: 'needs_input', summary: '进度检查连续失败，需要处理执行环境。', questions: [{
          question: '进度检查无法正常运行，执行环境已做哪些处理？',
          context: `负责人正在检查当前任务进展，评估调用连续失败。最近错误：${error.message.slice(0, 400)}`,
          reason: '在检查恢复前，系统无法可靠判断当前进度。需要依据实际错误处理环境后再继续。',
          options: [], recommendation: '', answerHint: '请说明已修复的登录、网络或配置问题；若尚未处理，请补充你观察到的现象。',
        }] };
        if (control.work) { control.interrupted.add(control.workRun); control.work.stop(); }
      }
    }).finally(() => { control.evaluation = null; if (!control.cancelled && !control.directive) this.schedule(control); });
  }

  // evaluate 评估只读取已提交的独立快照，返回建议而不直接完成项目。
  async evaluate(control, final) {
    this.assertActive(control);
    const directory = await this.git.review(control.id);
    try {
      const prompt = phasePrompt(final ? 'final-review' : 'evaluator', { context: this.context(control.id) });
      const result = validateEvaluation(await this.agent(control, final ? 'final-review' : 'evaluator', directory, prompt));
      this.store.event(control.id, final ? 'evaluation.final' : 'evaluation.result', JSON.stringify(result));
      return result;
    } finally { await this.git.removeReview(control.id, directory); }
  }

  // dispatch 让负责人为新增修复或失效任务选择真实员工，分配结果和原因持久化。
  async dispatch(control, task, cwd) {
    if (control.evaluation) await control.evaluation;
    this.assertActive(control);
    if (control.directive) throw new Interrupted('先处理负责人的进度反馈');
    const prompt = phasePrompt('coordinator', { context: this.context(control.id), task });
    const result = validateDispatch(await this.agent(control, 'coordinator', cwd, prompt, true));
    this.assertActive(control);
    if (result.needsInput) { this.ask(control, result.questions, result.summary); return null; }
    validateAssignments(this.store.project(control.id), { tasks: [{ ...task, assignee: result.assignee }] });
    this.store.reviseChecks(control.id, result.checkUpdates, { taskId: task.id, source: 'coordinator' });
    this.store.assignTask(control.id, task.id, result.assignee, result.summary);
    return { ...task, assignee: result.assignee };
  }

  // ask 暂停业务循环直到所有必要问题都得到回答。
  ask(control, questions, summary) {
    this.store.ask(control.id, questions);
    this.store.update(control.id, { status: 'waiting_input', summary, next_evaluation: null });
    this.store.event(control.id, 'input.required', questions.map(question => typeof question === 'string' ? question : JSON.stringify(question)).join('\n'));
  }

  // failed 连续无法推进三轮时保存明确阻断，避免无反馈地反复消耗模型调用。
  async failed(control, error) {
    this.assertActive(control);
    const failures = this.store.project(control.id).failures + 1;
    this.store.update(control.id, { failures, summary: error.message });
    this.store.event(control.id, 'execution.retry', `第 ${failures} 次未能推进：${error.message}`);
    if (failures >= 3) {
      this.store.update(control.id, { status: 'blocked', summary: `连续三轮未能推进：${error.message}。自动执行已停止，请查看失败原因，处理问题或补充修复要求后重试。` });
      return false;
    }
    await new Promise((resolve) => { const timer = setTimeout(resolve, this.retryDelayMs * failures); control.retryWake = () => { clearTimeout(timer); resolve(); }; });
    control.retryWake = null;
    return !control.cancelled;
  }

  // test 执行规划中保存的验收命令，流输出和最终退出码都记录到 SQLite。
  async test(control, check, cwd, employeeId = '') {
    this.assertActive(control);
    // 任务验收由任务员工负责，最终验收由负责人负责，记录实际采用的配置快照。
    const project = this.store.project(control.id);
    const employee = assignEmployee(this.store, project, employeeId ? 'developer' : 'final-review', employeeId);
    const timeoutMs = executionTimeoutMs(employee);
    const runId = this.store.beginRun(control.id, 'test', check.command, employee);
    this.store.event(control.id, 'test.timeout-policy', `验收员工：${employee.name}；处理时限：${employee.timeoutMinutes} 分钟；来源：员工配置`, runId);
    this.store.check(check.id, 'running', '');
    let handle, timer, timedOut = false, output = '';
    try {
      handle = await this.runtime.command(check.command, cwd, (kind, line) => {
        this.store.event(control.id, `test.${kind}`, line, runId);
        output = (output + line + '\n').slice(-200000);
      });
      control.handles.add(handle); this.store.process(runId, handle.pid); control.work = handle; control.workRun = runId;
      if (control.cancelled || control.directive) { control.interrupted.add(runId); handle.stop(); }
      timer = setTimeout(() => { timedOut = true; handle.stop(); }, timeoutMs);
      const result = await handle.done;
      if (control.cancelled || control.interrupted.has(runId)) {
        this.store.finishRun(runId, 'interrupted', output);
        this.store.check(check.id, 'pending', output);
        throw new Interrupted('验收已中断');
      }
      const passed = !timedOut && !result.error && result.code === 0;
      output += `\n退出码：${result.code}${timedOut ? `；执行超时（${employee.name}，员工时限 ${employee.timeoutMinutes} 分钟）` : ''}${result.error ? `；${result.error}` : ''}`;
      this.store.check(check.id, passed ? 'passed' : 'failed', output);
      this.store.finishRun(runId, passed ? 'completed' : 'failed', output);
      this.store.event(control.id, passed ? 'test.passed' : 'test.failed', `${check.title}\n${output}`, runId);
      return passed;
    } catch (error) {
      if (!(error instanceof Interrupted)) { this.store.check(check.id, 'failed', error.message); this.store.finishRun(runId, 'failed', error.message); }
      throw error;
    } finally {
      clearTimeout(timer); control.handles.delete(handle); control.interrupted.delete(runId);
      if (control.workRun === runId) { control.work = null; control.workRun = null; }
    }
  }

  // drive 持续处理尚未完成的任务，并将测试失败与评估建议送回开发 Agent。
  async drive(control) {
    const id = control.id;
    const releaseRepository = this.repositoryLock ? await this.repositoryLock.acquire(id, control.abort.signal) : null;
    let paths;
    try { paths = await this.git.ensure(this.store.project(id)); } finally { releaseRepository?.(); }
    while (this.store.project(id).resume_phase === 'plan') {
      this.assertActive(control);
      try {
        const prompt = phasePrompt('planner', { context: this.context(id) });
        const plan = validatePlan(await this.agent(control, 'planner', paths.work, prompt, true));
        this.assertActive(control);
        if (plan.needsInput) { this.ask(control, plan.questions, plan.summary); return; }
        if (!plan.requirements) throw new Error('规划缺少当前有效需求 requirements，请按上下文来源整理范围后返回完整计划');
        validateAssignments(this.store.project(id), plan);
        this.store.plan(id, plan);
        this.store.event(id, 'plan.created', JSON.stringify(plan));
        if (this.store.project(id).settings.confirmationMode === 'manual') {
          this.store.update(id, { status: 'awaiting_approval', plan_approved: 0 });
          this.store.event(id, 'plan.awaiting_approval', '拆解预览已生成，等待人工确认后开始实现');
          return;
        }
        this.store.update(id, { plan_approved: 1 });
        this.store.event(id, 'plan.approved', '根据用户选择自动确认计划，开始实现');
      } catch (error) { if (error instanceof Interrupted || !await this.failed(control, error)) return; }
    }
    this.store.update(id, { status: 'running' });
    this.schedule(control);
    while (!control.cancelled) {
      let task;
      try {
        if (control.directive) {
          const directive = control.directive; control.directive = null;
          await this.git.checkpoint(id, 'chore: checkpoint before evaluator intervention');
          this.assertActive(control);
          if (directive.action === 'needs_input') { this.ask(control, directive.questions, directive.summary); return; }
          this.store.reviseChecks(id, directive.checkUpdates, { source: 'evaluator' });
          control.feedback = directive.repair;
          if (this.store.tasks(id).every((item) => item.status === 'done')) this.store.repair(id, directive.repair);
          else {
            const interruptedTask = this.store.tasks(id).find(item => item.status !== 'done');
            if (interruptedTask) this.store.clearAssignment(interruptedTask.id);
          }
          this.store.update(id, { summary: directive.summary });
          this.schedule(control);
        }
        const tasks = this.store.tasks(id);
        task = tasks.find(item => item.status !== 'done' && item.depends_on.every(key => tasks.some(dependency => dependency.id === key && dependency.status === 'done')));
        if (!task && tasks.some(item => item.status !== 'done')) throw new Error('任务依赖尚未完成或无效，无法继续执行');
        if (!task) {
          const releaseMerge = this.mergeLock ? await this.mergeLock.acquire(id, control.abort.signal) : null;
          try {
            this.assertActive(control);
            if (this.mergeLock) {
              try { await this.git.integrate(id); }
              catch (error) {
                this.store.repair(id, `并发目标合并产生冲突：${error.message}。保留双方功能，修复冲突标记；不要自行提交或切换分支，平台将完成合并。`, '修复并发合并冲突');
                this.store.update(id, { status: 'running' });
                if (!await this.failed(control, error)) return;
                continue;
              }
            }
            clearTimeout(control.timer); control.timer = null;
            if (control.evaluation) await control.evaluation;
            clearTimeout(control.timer); control.timer = null;
            if (control.directive) continue;
            this.store.update(id, { status: 'verifying', next_evaluation: null });
            let passed = true;
            for (const check of this.store.checks(id)) if (!await this.test(control, check, paths.work)) passed = false;
            await this.git.checkpoint(id, 'test: checkpoint final verification');
            this.assertActive(control);
            if (!passed) {
              this.store.repair(id, '最终验收未通过。读取失败测试输出，修复源码并保持已有功能。');
              this.store.update(id, { status: 'running' });
              if (!await this.failed(control, new Error('最终验收失败，已生成修复任务'))) return;
              this.schedule(control); continue;
            }
            const result = await this.evaluate(control, true);
            this.assertActive(control);
            if (result.action === 'complete') {
              let release;
              try { release = await this.delivery.prepare(id, paths.work, control); }
              catch (error) {
                if (control.cancelled) return;
                this.store.repair(id, `交付未通过：${error.message}。请检查 goalhub.delivery.json、构建日志、预览或安装包。${deliveryInstruction}`, '补齐可使用的项目交付');
                this.store.update(id, { status: 'running', summary: `交付未完成：${error.message}` });
                if (!await this.failed(control, error)) return;
                this.schedule(control); continue;
              }
              this.assertActive(control);
              await this.git.complete(id);
              this.assertActive(control);
              this.delivery.publish(release);
              this.store.update(id, { status: 'completed', summary: result.summary, failures: 0 });
              this.store.event(id, 'project.completed', `全部任务、测试与交付验证通过，源码已合并至 ${this.store.project(id).main_branch}。可在交付面板预览或下载安装包。`);
              return;
            }
            if (result.action === 'needs_input') { this.ask(control, result.questions, result.summary); return; }
            this.store.reviseChecks(id, result.checkUpdates, { source: 'final-review' });
            this.store.repair(id, result.repair || result.summary);
            this.store.update(id, { status: 'running', summary: result.summary });
            this.schedule(control); continue;
          } finally { releaseMerge?.(); }
        }
        if (!eligibleEmployees(this.store.project(id), task).length) {
          this.store.update(id, { status: 'blocked', summary: `任务「${task.title}」缺少具备 ${taskCapability(task)} 能力的启用员工，请配置员工能力后继续` });
          return;
        }
        if (!eligibleEmployees(this.store.project(id), task).some(employee => employee.id === task.assignee)) {
          task = await this.dispatch(control, task, paths.work);
          if (!task) return;
        }
        // 优先分给空闲且能力相同的员工，保留已有分配以避免不必要的交接。
        if (this.leasePool?.busy(`${id}:${task.assignee}`)) {
          const available = eligibleEmployees(this.store.project(id), task).find(employee => !this.leasePool.busy(`${id}:${employee.id}`));
          if (available) { this.store.assignTask(id, task.id, available.id, '原员工忙碌，调度到同能力空闲员工'); task = { ...task, assignee: available.id }; }
        }
        // 同一负责人不能同时执行任务与评估，已有评估先结束并处理其反馈。
        if (team(this.store.project(id)).some(employee => employee.id === task.assignee && employee.isLead) && control.evaluation) await control.evaluation;
        this.assertActive(control);
        if (control.directive) continue;
        this.store.update(id, { status: 'running' });
        this.store.task(task.id, 'running', task.result, true);
        this.store.invalidate(id);
        const prompt = phasePrompt('developer', { context: this.context(id), task, feedback: control.feedback });
        const result = validateWork(await this.agent(control, 'developer', paths.work, prompt, true, task.assignee));
        this.assertActive(control);
        await this.git.checkpoint(id, `feat: ${task.title}`);
        this.assertActive(control);
        if (control.directive) { this.store.task(task.id, 'pending', result.summary); continue; }
        if (result.status === 'needs_input') { this.store.task(task.id, 'blocked', result.summary); this.ask(control, result.questions, result.summary); return; }
        this.store.reviseChecks(id, result.checkUpdates, { taskId: task.id, source: task.assignee });
        // 首次可修复失败沿用已分配员工，重复失败才请求负责人重新分工。
        if (result.status === 'retry') {
          this.store.task(task.id, 'pending', result.summary);
          if (task.attempts >= 1) this.store.clearAssignment(task.id);
          if (!await this.failed(control, new Error(result.summary))) return;
          continue;
        }
        let passed = true;
        for (const check of this.store.checks(id).filter((item) => task.check_ids.includes(item.id))) if (!await this.test(control, check, paths.work, task.assignee)) passed = false;
        this.assertActive(control);
        this.store.task(task.id, passed ? 'done' : 'pending', result.summary);
        if (!passed) {
          control.feedback = '验收未通过。读取 checks 中当前命令及失败输出；若是命令错误，必须通过 checkUpdates 提交替换命令和原因，不能只在摘要中建议修改。保持原验收目标和断言。';
          if (task.attempts >= 1) this.store.clearAssignment(task.id);
          if (!await this.failed(control, new Error(`任务「${task.title}」验收失败`))) return;
        } else {
          control.feedback = '';
          this.store.resolveRepairs(id, task.id, result.resolvedRepairIds);
          this.store.update(id, { failures: 0, summary: result.summary });
          this.store.event(id, 'task.completed', JSON.stringify({ taskId: task.id, title: task.title, employeeId: task.assignee }));
        }
      } catch (error) {
        if (task) this.store.task(task.id, 'pending', error.message);
        if (control.cancelled) return;
        if (error instanceof Interrupted) continue;
        if (task) this.store.clearAssignment(task.id);
        if (task) try { await this.git.checkpoint(id, `chore: preserve failed attempt for ${task.title}`); } catch (checkpointError) { this.store.event(id, 'git.checkpoint_failed', checkpointError.message); }
        if (!await this.failed(control, error)) return;
      }
    }
  }
}

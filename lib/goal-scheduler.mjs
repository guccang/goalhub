// 本文件提供项目多目标队列、员工互斥与合并串行化；每个目标复用独立的执行引擎。
import { Orchestrator } from './orchestrator.mjs';
import { team, requireTeam } from './employees.mjs';
import { steerParallel } from './task-control.mjs';
import { TaskSlots } from './execution-policy.mjs';
import { instructionKind } from './context.mjs';

// KeyLock 按资源名公平排队，取消等待不会占用员工或阻塞后续任务。
export class KeyLock {
  // constructor 初始化资源等待队列。
  constructor() { this.queues = new Map(); }
  // busy 返回资源是否正被占用。
  busy(key) { return !!this.queues.get(key)?.length; }
  // acquire 等待资源并返回一次性释放函数。
  acquire(key, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('执行已暂停'));
      const queue = this.queues.get(key) || []; this.queues.set(key, queue);
      const item = { granted: false };
      // release 释放当前或尚未获得的队列项。
      const release = () => {
        const index = queue.indexOf(item); if (index < 0) return;
        queue.splice(index, 1); signal?.removeEventListener('abort', cancel);
        if (!queue.length) this.queues.delete(key); else if (index === 0) queue[0].grant();
      };
      // cancel 仅取消尚未进入临界区的请求，持有者退出时自行释放。
      const cancel = () => { if (!item.granted) { release(); reject(new Error('执行已暂停')); } };
      // grant 唤醒队首并交付资源所有权。
      item.grant = () => { item.granted = true; signal?.removeEventListener('abort', cancel); resolve(release); };
      queue.push(item); signal?.addEventListener('abort', cancel, { once: true });
      if (queue.length === 1) item.grant();
    });
  }
}

export class GoalScheduler {
  // constructor 队列状态保存在目标快照中，不创建额外项目或重复恢复交付状态。
  constructor({ store, git, runtime, retryDelayMs = 1000 }) {
    Object.assign(this, { store, git, runtime, retryDelayMs });
    this.base = new Orchestrator({ store, git, runtime, retryDelayMs }); this.delivery = this.base.delivery;
    this.engines = new Map(); this.controls = new Map(); this.steering = new Set();
    this.taskSlots = new TaskSlots(); this.leases = new KeyLock(); this.repositories = new KeyLock(); this.merges = this.repositories; this.closing = false; this.wakeTimers = new Map();
  }
  // engine 为目标创建固定的存储与工作目录，绝不切换其他目标的 active_goal_id。
  engine(id, goalId = this.store.project(id)?.active_goal_id) {
    if (!goalId) throw new Error('请先添加目标');
    const key = `${id}:${goalId}`;
    if (!this.engines.has(key)) {
      const store = this.store.forGoal(id, goalId); store.goalProjectId = id;
      const git = this.git.forGoal(store, goalId), delivery = Object.create(this.delivery);
      Object.assign(delivery, { store, git });
      const engine = new Orchestrator({ store, git, runtime: this.runtime, delivery, retryDelayMs: this.retryDelayMs, leasePool: this.leases, repositoryLock: this.repositories, mergeLock: this.merges, taskSlots: this.taskSlots });
      engine.teamBuilder = this.teamBuilder; this.engines.set(key, engine);
    }
    return this.engines.get(key);
  }
  // state 对外显示并发容量和等待顺序，启用负责人也可承担开发任务。
  state(id) {
    const capacity = team(this.store.project(id)).filter(item => item.enabled).length;
    const goals = this.store.goals(id), running = [...this.engines.values()].filter(engine => engine.controls.has(id)).length;
    const assignments = [...this.engines.values()].filter(engine => engine.controls.has(id)).flatMap(engine => {
      const project = engine.store.project(id);
      return [...(engine.controls.get(id).assignments?.values() || [])].map(assignment => ({ goalId: project.active_goal_id, employeeId: assignment.employeeId, waiting: assignment.waiting,
        label: `${project.goal.slice(0, 30)}：${assignment.waiting ? '等待' : ({development:'正在开发',testing:'正在测试',design:'正在设计',planning:'正在规划',review:'正在审查',documentation:'正在编写文档',coordination:'正在协调'}[assignment.capability] || '正在执行') + ' · '}${assignment.name}` }));
    });
    return { capacity, running, assignments, waiting: goals.filter(goal => goal.status === 'queued').map(goal => ({ id: goal.id, title: goal.title })), awaitingApproval: goals.filter(goal => goal.status === 'awaiting_approval').map(goal => ({ id: goal.id, title: goal.title })) };
  }
  // isGoalActive 查询单个目标，避免其他目标运行时禁用此目标的操作。
  isGoalActive(id, goalId) { return this.engines.get(`${id}:${goalId || this.store.project(id)?.active_goal_id}`)?.controls.has(id) || false; }
  // refresh 汇总项目运行状态，兼容员工管理和办公室的项目级运行锁。
  refresh(id) {
    const engine = [...this.engines.values()].find(item => item.controls.has(id));
    if (engine) this.controls.set(id, engine.controls.get(id)); else this.controls.delete(id);
  }
  // start 将目标加入队列，等待中的目标重复启动不会产生重复执行。
  start(id, options = {}) {
    if (this.steering.has(id) && !options.fromControl) throw new Error('正在处理用户指令，请等待完成');
    const engine = this.engine(id, options.goalId), project = engine.store.project(id);
    if (engine.controls.has(id)) throw new Error('目标仍在运行或停止中');
    requireTeam(project);
    if (project.status === 'completed' && !options.deliveryRepair) throw new Error('目标已完成，请添加新目标');
    if (options.deliveryRepair) { this.launch(id, engine, options); return; }
    if (engine.store.questions(id).some(question => question.answer === null)) throw new Error('请先回答当前问题');
    if (project.resume_phase === 'execute' && project.settings.confirmationMode === 'manual' && !project.plan_approved) throw new Error('请先确认计划');
    engine.store.update(id, { status: 'queued' }); this.pump(id);
  }
  // launch 注册正在运行的目标，退出时释放槽位并自动启动下一项。
  launch(id, engine, options = {}) {
    engine.start(id, options); this.refresh(id);
    const control = engine.controls.get(id);
    control.promise.finally(() => { this.refresh(id); if (!this.closing) this.pump(id); });
  }
  // pump 按创建顺序填充空位，构建阶段结束后由目标完成回调继续调度。
  pump(id) {
    if (this.closing) return;
    if (this.delivery.jobs.has(id) || this.teamBuilder?.jobs.has(id)) {
      if (!this.wakeTimers.has(id) && this.store.goals(id).some(goal => goal.status === 'queued')) {
        const timer = setTimeout(() => { this.wakeTimers.delete(id); this.pump(id); }, 500);
        timer.unref?.(); this.wakeTimers.set(id, timer);
      }
      return;
    }
    const { capacity, running } = this.state(id); let free = capacity - running;
    for (const goal of this.store.goals(id).filter(goal => goal.status === 'queued')) {
      if (free <= 0) break;
      const engine = this.engine(id, goal.id);
      if (engine.controls.has(id)) continue;
      try { this.launch(id, engine); free--; }
      catch (error) { engine.store.update(id, { status: 'blocked', summary: error.message }); }
    }
  }
  // recoverQueues 仅恢复排队目标，异常退出的运行目标仍需人工继续。
  recoverQueues() { for (const project of this.store.list()) this.pump(project.id); }
  // pause 暂停指定目标；未指定时暂停整个项目和等待队列。
  async pause(id, goalId) {
    const goals = goalId ? [{ id: goalId }] : this.store.goals(id).filter(goal => goal.status !== 'completed');
    for (const goal of goals) {
      const engine = this.engine(id, goal.id);
      if (engine.store.project(id).status === 'queued') engine.store.update(id, { status: 'paused' });
    }
    await Promise.all(goals.map(goal => this.engine(id, goal.id).pause(id))); this.refresh(id);
  }
  // setConfirmationMode 按用户选择保存项目默认值，自动模式复用已生成计划并送入队列。
  setConfirmationMode(id, mode) {
    if (!['auto', 'manual'].includes(mode)) throw new Error('确认方式无效');
    const project = this.store.project(id);
    if (!project) throw new Error('项目不存在');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(JSON.stringify({ ...project.settings, confirmationMode: mode }), id);
      for (const goal of this.store.goals(id).filter(goal => goal.status !== 'completed')) {
        const scoped = this.store.forGoal(id, goal.id), snapshot = scoped.project(id);
        snapshot.settings.confirmationMode = mode;
        if (mode === 'auto' && snapshot.status === 'awaiting_approval') {
          snapshot.plan_approved = 1; snapshot.status = 'queued';
          scoped.event(id, 'plan.approved', '按用户设置自动确认已有计划，等待员工空位后继续执行');
        }
        this.store.db.prepare('UPDATE goals SET snapshot=?,updated_at=? WHERE id=?').run(JSON.stringify(snapshot), new Date().toISOString(), goal.id);
        scoped.update(id, { status: snapshot.status, plan_approved: snapshot.plan_approved });
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.pump(id);
  }

  // approve 确认当前目标的计划后进入容量受限的等待队列。
  approve(id, goalId) {
    const engine = this.engine(id, goalId);
    if (engine.store.project(id).status !== 'awaiting_approval') throw new Error('计划尚未准备好确认');
    engine.store.update(id, { plan_approved: 1 }); this.start(id, { goalId });
  }
  // evaluateNow 将人工检查路由到选中的目标。
  evaluateNow(id, goalId) { this.engine(id, goalId).evaluateNow(id); }
  // steer 先暂停指定目标，再保存补充任务，恢复时仍遵循容量限制。
  async steer(id, content, goalId, kind = 'requirement') {
    kind = instructionKind(content, kind);
    const engine = this.engine(id, goalId), project = engine.store.project(id);
    if (project.settings.executionMode === 'parallel') return steerParallel(this, id, content, goalId, kind);
    if (['completed', 'awaiting_approval'].includes(project.status)) throw new Error('请先处理当前目标状态');
    if (this.steering.has(id)) throw new Error('正在处理上一条补充指令');
    if (engine.store.questions(id).some(question => question.answer === null)) throw new Error('请先回答当前问题');
    this.steering.add(id);
    try {
      await this.pause(id, project.active_goal_id);
      if (engine.store.project(id).status === 'completed') throw new Error('目标已经完成，补充指令未发送');
      engine.store.instruction(id, content, kind);
      if (kind === 'requirement') engine.store.requestReplan(id, '收到补充要求，负责人将结合已有成果更新任务与验收条件。');
      else if (kind === 'repair' && engine.store.tasks(id).length && engine.store.tasks(id).every(task => task.status === 'done')) engine.store.repair(id, content);
      this.start(id, { goalId: project.active_goal_id, fromControl: true });
    }
    finally { this.steering.delete(id); }
  }
  // controlTask 暂停目标后原子控制单个任务，再恢复其余可执行任务。
  async controlTask(id, goalId, taskId, action) {
    if (this.steering.has(id)) throw new Error('正在处理用户指令');
    const engine = this.engine(id, goalId), goal = engine.store.project(id);
    if (goal.settings.executionMode !== 'parallel') throw new Error('单任务控制需要模块并行模式');
    const task = engine.store.tasks(id).find(item => item.id === taskId);
    if (!task || task.status === 'done' || task.status === 'cancelled') throw new Error('任务不存在或已结束');
    if (!['pause', 'cancel', 'resume'].includes(action)) throw new Error('任务控制动作无效');
    const active = engine.controls.has(id);
    this.steering.add(id);
    try {
      await this.pause(id, goal.active_goal_id);
      engine.store.controlTask(id, taskId, action);
      if (active || action === 'resume') this.start(id, { goalId: goal.active_goal_id, fromControl: true });
    } finally { this.steering.delete(id); }
  }

  // context 预览和执行读取同一目标视图。
  context(id) { return this.store.project(id)?.active_goal_id ? this.engine(id).context(id) : this.base.context(id); }
  // close 先关闭队列入口再停止全部子进程，保留排队记录。
  async close() {
    this.closing = true; for (const timer of this.wakeTimers.values()) clearTimeout(timer); this.wakeTimers.clear(); await this.teamBuilder?.close();
    await Promise.all([...this.engines.values()].map(engine => Promise.all([...engine.controls.keys()].map(id => engine.pause(id)))));
    await Promise.allSettled(this.inputQueues?.values() || []);
    await this.delivery.close(); this.controls.clear();
  }
}

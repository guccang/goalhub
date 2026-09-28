// 本文件把 GoalHub 的真实轮次映射为 Munder Difflin 办公室角色，不生成模拟工作进度。
import { effectiveLanguage } from './languages.mjs';
import { team, duties } from './employees.mjs';
export const officeRoles = Object.freeze([
  { id: 'planner', name: '项目经理', kind: 'employee', character: 'michael', station: '经理办公室', description: '理解目标、澄清需求、拆解任务，并制定验收标准。', runRoles: ['planner'] },
  { id: 'developer', name: '软件工程师', kind: 'employee', character: 'jim', station: '研发工位', description: '实现功能、修改代码，结合测试结果修复问题。', runRoles: ['developer'] },
  { id: 'evaluator', name: '技术主管', kind: 'employee', character: 'dwight', station: '技术审查席', description: '定期检查进度、审查技术阻塞，并提出修复要求。', runRoles: ['evaluator'] },
  { id: 'quality', name: '质量工程师', kind: 'employee', character: 'pam', station: '质量工位', description: '在最终验收阶段分析测试与交付证据，确认完成标准及遗漏问题。', runRoles: ['final-review'] },
  { id: 'test', name: '测试工作站', kind: 'facility', station: '测试工作站', description: '执行自动化测试命令，保存输出和真实退出码；这是工具设施，不代表员工正在工作。', runRoles: ['test'] },
]);

// questionOwner 从最后的提问轮次识别实际需要用户输入的角色。
function questionOwner(project, latestRuns, roles) {
  if (project.status !== 'waiting_input') return null;
  const latest = latestRuns.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return latest?.employee_id || roles.find((role) => role.runRoles.includes(latest?.role))?.id || roles.find(role => role.role === (project.resume_phase === 'plan' ? 'planner' : 'developer'))?.id;
}

// buildOfficeSnapshot 以数据库和调度锁共同判断角色状态，并提供可审计的消息连线。
export function buildOfficeSnapshot(store, orchestrator, id) {
  const project = store.project(id);
  if (!project) return null;
  const active = orchestrator.controls.has(id);
  // 员工名单来自当前项目，测试设施始终独立存在；默认 ID 保持旧记录兼容。
  const roles = [...team(project).map(employee => ({ ...officeRoles.find(role => role.runRoles.includes(employee.role)), ...employee, effectiveLanguage: effectiveLanguage(project, employee), title: duties[employee.role].name })), officeRoles.find(role => role.id === 'test')];
  const runs = roles.map(role => role.kind === 'facility' ? store.latestRoleRun(id, role.runRoles) : store.employeeRun(id, role));
  const owner = questionOwner(project, runs, roles), tasks = store.tasks(id), checks = store.checks(id);
  const currentTask = tasks.find((task) => task.status === 'running') || tasks.find((task) => task.status === 'pending');
  const actors = roles.map((role, index) => {
    const run = runs[index];
    let state = 'idle';
    if (active && run?.status === 'running') state = 'working';
    else if (owner === role.id || (project.status === 'blocked' && run?.status === 'failed')) state = 'blocked';
    else if (project.status === 'paused' && run) state = 'paused';
    else if (run?.status === 'completed') state = 'success';
    else if (run?.status === 'failed') state = 'error';
    if (project.status === 'blocked' && role.enabled && role.role === (project.resume_phase === 'plan' ? 'planner' : 'developer')) state = 'blocked';
    const events = run ? store.runEvents(run.id, 30) : [];
    const lastOutput = [...events].reverse().find((event) => !['agent.diagnostic', 'agent.turn.started', 'agent.thread.started'].includes(event.kind));
    const activity = state === 'working'
      ? (role.role === 'developer' && currentTask ? currentTask.title : role.id === 'test' ? checks.find((check) => check.status === 'running')?.title || '执行验收命令' : role.role === 'final-review' ? '核对测试证据与最终交付' : role.role === 'planner' ? '澄清目标并制定执行计划' : '检查进度与技术阻塞')
      : state === 'blocked' ? project.summary : state === 'paused' ? '进度已保存，等待继续' : state === 'success' ? '最近一轮已结束' : '等待任务分配';
    return { ...role, runRoles: undefined, state, activity, run: run ? { id: run.id, role: run.role, status: run.status, created_at: run.created_at, finished_at: run.finished_at, session_id: run.session_id, executor: run.executor ? JSON.parse(run.executor) : null } : null,
      recentOutput: lastOutput?.content.slice(-600) || '', events: events.map((event) => ({ ...event, content: event.content.slice(-8000) })) };
  });
  const transitions = {
    'plan.created': ['planner', 'developer', '任务已拆解'],
    'task.completed': ['developer', 'test', '任务已通过验收'],
    'evaluation.result': ['evaluator', 'developer', '进度评估结果'],
    'evaluation.final': ['quality', 'planner', '质量验收结果'],
    'input.required': [owner || 'developer', 'human', '需要用户输入'],
    'input.answer': ['human', project.resume_phase === 'plan' ? 'planner' : 'developer', '用户已回答'],
    'control.steer': ['human', project.resume_phase === 'plan' ? 'planner' : 'developer', '补充执行指令'],
    'test.failed': ['test', 'developer', '测试失败，需要修复'],
    'project.completed': ['quality', 'human', '目标已完成'],
  };
  const messages = store.officeEvents(id, Object.keys(transitions), 25).map((event) => {
    const [from, to, label] = transitions[event.kind];
    // 职责交接映射到当前负责的员工，员工 ID 不再等同于固定职责。
    const resolve = value => actors.find(actor => actor.id === value)?.id || actors.find(actor => actor.role === (value === 'quality' ? 'final-review' : value) && actor.enabled)?.id || value;
    return { id: event.id, from: resolve(from), to: resolve(to), label, created_at: event.created_at, kind: event.kind };
  });
  return { projectId: id, status: project.status, active, actors, messages, questionOwner: owner,
    progress: { done: tasks.filter((task) => task.status === 'done').length, total: tasks.length, passed: checks.filter((check) => check.status === 'passed').length, checks: checks.length },
    instructions: store.instructions(id), synchronizedAt: new Date().toISOString() };
}

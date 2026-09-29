// 本文件将项目员工与真实轮次映射到办公室，人物身份与运行阶段分别维护。
import { inputContext, progressEvents } from '../public/work-progress.js';
import { effectiveLanguage } from './languages.mjs';
import { team } from './employees.mjs';

const facility = { id: 'test', name: '测试工作站', kind: 'facility', station: '测试工作站', description: '执行自动化验收命令，保存输出和真实退出码。' };
const activities = { 'issue-review': '主管判断问题归属并安排处理', 'team-builder': '根据项目目标搭建团队', planner: '理解目标并分配项目任务', coordinator: '根据结果重新分配任务', evaluator: '检查进度与阻断', 'final-review': '核对验收证据与交付结果', developer: '执行分配的任务' };

// buildOfficeSnapshot 依据执行员工编号显示实时状态，固定职责不再决定人物或工位。
export function buildOfficeSnapshot(store, orchestrator, id) {
  const project = store.project(id);
  if (!project) return null;
  const active = orchestrator.controls.has(id), employees = team(project), leader = employees.find(employee => employee.isLead && employee.enabled);
  const goalIds = orchestrator.state ? store.goals(id).filter(goal => goal.status !== 'completed').map(goal => goal.id) : [project.active_goal_id];
  const tasks = goalIds.flatMap(goalId => store.tasks(id, goalId)), checks = goalIds.flatMap(goalId => store.checks(id, goalId));
  const members = [...employees.map(employee => ({ ...employee, kind: 'employee', title: employee.position || '尚未定义职位', description: employee.instructions, station: employee.isLead ? '负责人办公室' : '项目工位', effectiveLanguage: effectiveLanguage(project, employee) })), facility];
  const runs = members.map(member => member.kind === 'facility' ? store.latestRoleRun(id, ['test']) : store.employeeRun(id, member));
  // 失败只代表仍在推进的目标的最新轮次；后续轮次已接手时保留日志，但撤销旧告警。
  const currentFailures = new Set(project.status === 'completed' ? [] : goalIds.map(goalId => store.latestContextRun(id, goalId)).filter(run => run?.status === 'failed').map(run => run.id));
  const latest = runs.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const owner = ['waiting_input', 'awaiting_approval'].includes(project.status) ? latest?.employee_id || leader?.id : null;
  const actors = members.map((member, index) => {
    const run = runs[index], currentTask = tasks.find(task => task.assignee === member.id && task.status === 'running');
    const currentFailure = run?.status === 'failed' && currentFailures.has(run.id);
    let state = 'idle';
    if ((active || orchestrator.teamBuilder?.jobs.has(id) && run?.role === 'team-builder') && run?.status === 'running') state = 'working';
    else if (owner === member.id || project.status === 'blocked' && (member.isLead || currentFailure)) state = 'blocked';
    else if (project.status === 'paused' && run) state = 'paused';
    else if (run?.status === 'completed') state = 'success';
    else if (currentFailure) state = 'error';
    const events = run ? store.runEvents(run.id, 100) : [];
    // 验收进程没有个人计划，沿用同一任务版本最近一次员工上报，不跨任务取计划。
    const planSteps = run?.plan_steps || (run?.task_id ? store.db.prepare("SELECT plan_steps FROM runs WHERE task_id=? AND task_version=? AND employee_id=? AND plan_steps IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(run.task_id, run.task_version, member.id)?.plan_steps : null);
    const lastOutput = [...events].reverse().find(event => !['agent.diagnostic', 'agent.turn.started', 'agent.thread.started'].includes(event.kind));
    const activity = state === 'working' ? currentTask?.title || (member.id === 'test' ? checks.find(check => check.status === 'running')?.title || '执行验收命令' : activities[run?.role] || '执行任务')
      : state === 'blocked' ? project.status === 'awaiting_approval' ? '计划已就绪，等待确认' : project.status === 'blocked' ? '团队处理执行问题，暂无需要用户澄清的需求' : project.summary : state === 'paused' ? '进度已保存，等待继续' : state === 'success' ? '最近一轮已结束' : member.enabled === false ? '未参与执行' : '等待任务分配';
    return { ...member, role: run?.role || (member.isLead ? 'planner' : 'developer'), state, activity,
      context: run ? inputContext(run.input) : {}, progress: [...progressEvents(events), ...(planSteps ? [{ category: 'plan', title: '员工本轮工作计划', text: '', steps: JSON.parse(planSteps), at: run.created_at }] : [])],
      run: run ? { id: run.id, role: run.role, status: run.status, created_at: run.created_at, finished_at: run.finished_at, session_id: run.session_id, executor: run.executor ? JSON.parse(run.executor) : null } : null,
      recentOutput: lastOutput?.content.slice(-600) || '', events: events.map(event => ({ ...event, content: event.content.slice(-8000) })) };
  });
  const labels = { 'plan.created': '负责人已拆解并分配任务', 'task.assigned': '负责人重新分配任务', 'task.completed': '任务已通过验收', 'evaluation.result': '负责人进度检查', 'evaluation.final': '负责人核对交付', 'input.required': '需要用户输入', 'input.answer': '用户已回答', 'control.steer': '补充执行要求', 'test.failed': '测试失败，需要修复', 'project.completed': '目标已完成' };
  const messages = store.officeEvents(id, Object.keys(labels), 25).map(event => {
    let from = leader?.id || 'human', to = 'human';
    let detail = null;
    try { detail = JSON.parse(event.content); } catch { /* 普通文本事件不包含结构化分配。 */ }
    if (event.kind === 'task.assigned') { from = detail?.from || from; to = detail?.to || to; }
    else if (event.kind === 'plan.created') to = detail?.tasks?.[0]?.assignee || from;
    else if (event.kind === 'task.completed') { from = detail?.employeeId || from; to = leader?.id || 'human'; }
    else if (event.kind === 'test.failed') { from = 'test'; to = leader?.id || 'human'; }
    else if (['input.answer', 'control.steer'].includes(event.kind)) { from = 'human'; to = leader?.id || 'human'; }
    else if (event.kind === 'input.required') from = owner || from;
    else if (event.kind.startsWith('evaluation.')) to = from;
    return { id: event.id, from, to, label: labels[event.kind], created_at: event.created_at, kind: event.kind };
  });
  return { projectId: id, status: active && project.status === 'completed' ? 'running' : project.status, active, actors, messages, questionOwner: owner,
    progress: { done: tasks.filter(task => task.status === 'done').length, total: tasks.length, passed: checks.filter(check => check.status === 'passed').length, checks: checks.length },
    instructions: store.instructions(id), synchronizedAt: new Date().toISOString() };
}

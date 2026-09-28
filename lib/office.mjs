// 本文件把 GoalHub 的真实轮次映射为 Munder Difflin 办公室角色，不生成模拟工作进度。
export const officeRoles = Object.freeze([
  { id: 'planner', name: '规划员', character: 'michael', station: '规划室', description: '理解目标，拆解任务并制定验收项目。', runRoles: ['planner'] },
  { id: 'developer', name: '开发员', character: 'jim', station: '开发工位', description: '在项目 worktree 中开发，修复失败的测试。', runRoles: ['developer'] },
  { id: 'evaluator', name: '评估员', character: 'dwight', station: '评估室', description: '独立检查进度、阻断问题和最终交付。', runRoles: ['evaluator', 'final-review'] },
  { id: 'test', name: '测试执行器', character: 'pam', station: '验收台', description: '运行规划中的测试命令，记录输出与真实退出码。', runRoles: ['test'] },
]);

// questionOwner 从最后的提问轮次识别实际需要用户输入的角色。
function questionOwner(project, latestRuns) {
  if (project.status !== 'waiting_input') return null;
  const latest = latestRuns.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return officeRoles.find((role) => role.runRoles.includes(latest?.role))?.id || (project.resume_phase === 'plan' ? 'planner' : 'developer');
}

// buildOfficeSnapshot 以数据库和调度锁共同判断角色状态，并提供可审计的消息连线。
export function buildOfficeSnapshot(store, orchestrator, id) {
  const project = store.project(id);
  if (!project) return null;
  const active = orchestrator.controls.has(id);
  const runs = officeRoles.map((role) => store.latestRoleRun(id, role.runRoles));
  const owner = questionOwner(project, runs), tasks = store.tasks(id), checks = store.checks(id);
  const currentTask = tasks.find((task) => task.status === 'running') || tasks.find((task) => task.status === 'pending');
  const actors = officeRoles.map((role, index) => {
    const run = runs[index];
    let state = 'idle';
    if (active && run?.status === 'running') state = 'working';
    else if (owner === role.id || (project.status === 'blocked' && run?.status === 'failed')) state = 'blocked';
    else if (project.status === 'paused' && run) state = 'paused';
    else if (run?.status === 'completed') state = 'success';
    else if (run?.status === 'failed') state = 'error';
    if (project.status === 'blocked' && role.id === (project.resume_phase === 'plan' ? 'planner' : 'developer')) state = 'blocked';
    const events = run ? store.runEvents(run.id, 30) : [];
    const lastOutput = [...events].reverse().find((event) => !['agent.diagnostic', 'agent.turn.started', 'agent.thread.started'].includes(event.kind));
    const activity = state === 'working'
      ? (role.id === 'developer' && currentTask ? currentTask.title : role.id === 'test' ? checks.find((check) => check.status === 'running')?.title || '执行验收命令' : role.id === 'evaluator' && run?.role === 'final-review' ? '执行最终交付评估' : '正在处理当前轮次')
      : state === 'blocked' ? project.summary : state === 'paused' ? '进度已保存，等待继续' : state === 'success' ? '最近一轮已结束' : '等待任务分配';
    return { ...role, runRoles: undefined, state, activity, run: run ? { id: run.id, role: run.role, status: run.status, created_at: run.created_at, finished_at: run.finished_at, session_id: run.session_id } : null,
      recentOutput: lastOutput?.content.slice(-600) || '', events: events.map((event) => ({ ...event, content: event.content.slice(-8000) })) };
  });
  const transitions = {
    'plan.created': ['planner', 'developer', '任务已拆解'],
    'task.completed': ['developer', 'test', '任务已通过验收'],
    'evaluation.result': ['evaluator', 'developer', '进度评估结果'],
    'evaluation.final': ['evaluator', 'planner', '最终评估结果'],
    'input.required': [owner || 'developer', 'human', '需要用户输入'],
    'input.answer': ['human', project.resume_phase === 'plan' ? 'planner' : 'developer', '用户已回答'],
    'control.steer': ['human', project.resume_phase === 'plan' ? 'planner' : 'developer', '补充执行指令'],
    'test.failed': ['test', 'developer', '测试失败，需要修复'],
    'project.completed': ['evaluator', 'human', '目标已完成'],
  };
  const messages = store.officeEvents(id, Object.keys(transitions), 25).map((event) => {
    const [from, to, label] = transitions[event.kind];
    return { id: event.id, from, to, label, created_at: event.created_at, kind: event.kind };
  });
  return { projectId: id, status: project.status, active, actors, messages, questionOwner: owner,
    progress: { done: tasks.filter((task) => task.status === 'done').length, total: tasks.length, passed: checks.filter((check) => check.status === 'passed').length, checks: checks.length },
    instructions: store.instructions(id), synchronizedAt: new Date().toISOString() };
}

// 本文件整理需求来源和五部分上下文，不把故障修复或历史记录当作产品要求。
import { createHash } from 'node:crypto';

// instructionKind 兼容旧版明确的继续操作；其他旧指令保留原意交给负责人整理。
export function instructionKind(content, kind = 'requirement') {
  if (!['requirement', 'repair', 'resume'].includes(kind)) throw new Error('不支持的处理类型');
  return /^(?:继续(?:当前目标|执行(?:任务)?)?|重试)[。！!\s]*$/.test(content.trim()) ? 'resume' : kind;
}

// requirementSources 保留可追溯决策与时间，版本只随用户需求变化。
export function requirementSources(context) {
  if (context.documentSources) return { sources: context.documentSources, revision: createHash('sha256').update(JSON.stringify([context.goalId || '', context.projectContext || '', context.documentSources])).digest('hex') };
  const sources = [{ id: 'goal', kind: 'original', content: context.goal || '' }];
  for (const question of context.questions || []) if (question.answer != null) sources.push({ id: `answer:${question.id}`, kind: 'answer', question: question.prompt, content: question.answer, at: question.answered_at || question.created_at || '' });
  for (const [index, item] of (context.instructions || []).entries()) if (instructionKind(item.content, item.kind) === 'requirement') sources.push({ id: `instruction:${item.id ?? `draft-${index}`}`, kind: 'requirement', content: item.content, at: item.created_at || '' });
  // 问答与补充指令按同一时间线排列，避免较早指令压过较晚答复。
  const original = sources.shift(); sources.sort((a, b) => (a.at || '').localeCompare(b.at || '')); sources.unshift(original);
  const revision = createHash('sha256').update(JSON.stringify([context.goalId || '', context.projectContext || '', sources])).digest('hex');
  return { revision, sources };
}

// organizeContext 按阶段选择相关任务，默认历史只提供编号和查询入口。
export function organizeContext(context, role, task, feedback = '') {
  const input = context.requirementInput || requirementSources(context), snapshot = context.requirementSnapshot;
  const valid = snapshot?.sourceRevision === input.revision;
  const planning = role === 'planner', local = ['developer', 'coordinator'].includes(role);
  const tasks = context.tasks || [], checks = context.checks || [];
  const related = new Set([task?.id, ...(task?.depends_on || [])]);
  const selected = local ? tasks.filter(item => related.has(item.id)) : tasks;
  const checkIds = new Set(local ? task?.check_ids || [] : checks.map(item => item.id));
  const blocker = context.currentBlocker || null;
  const evidence = checks.filter(check => checkIds.has(check.id)).map(check => {
    const stale = blocker?.kind === 'host' && (!check.checked_at || check.checked_at < blocker.at);
    return { ...check, commandVersion: createHash('sha256').update(check.command || '').digest('hex').slice(0, 16), evidenceStatus: stale ? 'historical' : check.status === 'pending' ? 'previous-attempt; not-current-verdict' : 'latest-for-command', output: stale || planning && blocker?.kind !== 'test' ? undefined : check.output };
  });
  const repairs = (context.instructions || []).filter(item => instructionKind(item.content, item.kind) === 'repair');
  return {
    project: { name: context.projectName, repository: context.repository, mainBranch: context.mainBranch, platform: context.platform,
      // 自由文本背景可能含旧目标，仅规划时作为待核对资料，不作为执行约束。
      background: planning && context.projectContext ? { status: 'reference-only', content: context.projectContext, rule: '仅采纳与当前需求一致的内容；冲突部分不适用，不得覆盖用户决策。' } : undefined,
      taskDocuments: context.taskDocuments,
      executionPolicy: context.executionPolicy, modules: context.modules, employees: context.employees, delivery: context.delivery ? { ...context.delivery, lastBuild: undefined } : undefined },
    requirements: { goalId: context.goalId, revision: input.revision, status: valid ? 'consolidated' : 'needs-consolidation',
      effective: valid ? snapshot : undefined,
      sources: planning || !valid ? input.sources : undefined,
      pendingQuestions: (context.questions || []).filter(item => item.answer == null),
      precedence: '最新明确用户决策修订原始诉求；当前有效需求约束计划和验收；修复说明不能改变产品范围。' },
    work: { phase: role, planStatus: context.resumePhase === 'plan' ? 'awaiting-replan' : 'current',
      task: local && task ? { taskId: task.taskId, assignmentId: task.assignmentId || task.id, documents: task.documents, version: task.version, spec: typeof task.spec === 'string' ? JSON.parse(task.spec) : task.spec, handoff: task.handoff, id: task.id, title: task.title, description: task.description, done_when: task.done_when, assignee: task.assignee, check_ids: task.check_ids } : undefined,
      // 当前依赖的交接成果属于执行输入，不能与过期历史一起过滤。
      tasks: selected.map(({ result, ...item }) => ({ ...item, ...(local && related.has(item.id) && item.id !== task?.id && !item.documents ? { result } : {}), description: local || !planning || context.executionPolicy?.executionMode === 'parallel' ? item.description : undefined, done_when: planning && context.resumePhase === 'plan' && context.executionPolicy?.executionMode !== 'parallel' ? undefined : item.done_when })),
      checks: evidence.map(({ id, title, command, expectation, commandVersion }) => ({ id, title, command, expectation, commandVersion })),
      repair: feedback ? { content: feedback, purpose: '修复当前执行，不改变需求' } : undefined,
      repairInstructions: repairs.filter(item => !item.resolved_at && (!local || !task || !item.task_id || item.task_id === task.id)).map(item => ({ id: item.id, taskId: item.task_id, content: item.content, at: item.created_at, status: 'pending-repair' })) },
    state: { status: context.status, blocker, latestRun: context.latestRun,
      checks: evidence.map(({ id, status, output, checked_at, evidenceStatus, commandVersion }) => ({ id, status, output, checked_at, evidenceStatus, commandVersion })),
      completedTasks: tasks.filter(item => item.status === 'done').map(item => ({ id: item.id, title: item.title })) },
    history: { policy: '默认不注入旧目标、过期日志和被替代需求；需要时在项目详情、执行记录及 Git 中查阅。',
      originalRequest: { sourceId: 'goal', status: 'original-subject-to-user-decisions' },
      sourceIds: input.sources.map(item => item.id),
      resolvedRepairIds: repairs.filter(item => item.resolved_at).map(item => item.id),
      records: { project: context.projectId, goal: context.goalId },
      lastBuild: context.delivery?.lastBuild ? { status: context.delivery.lastBuild.status, commit: context.delivery.lastBuild.commit } : undefined }
  };
}

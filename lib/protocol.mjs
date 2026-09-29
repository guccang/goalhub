import { taskCapability } from './employees.mjs';
// 本文件校验 Agent 结构化回复，防止把普通自然语言或未经验证的完成声明当作业务成功。

// text 检查非空文本及长度。
function text(value, name, max = 20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是非空文本，最多 ${max} 字符`);
  return value.trim();
}

// parseReply 仅接受完整 JSON 或单个 JSON 代码块。
export function parseReply(raw) {
  const value = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Agent 必须返回 JSON 对象');
  return parsed;
}

// questions 校验必须交给用户的问题列表。
function questions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error('需要 1–10 个具体问题');
  return value.map(item => {
    // 兼容旧宿主的字符串问题，新问题必须明确背景、原因及回答方式。
    if (typeof item === 'string') return text(item, '问题', 2000);
    if (!item || typeof item !== 'object') throw new Error('问题格式无效');
    const options = item.options ?? [];
    if (!Array.isArray(options) || options.length > 3) throw new Error('问题最多提供三个选项');
    const normalized = options.map(option => ({ label: text(option.label, '选项', 80), impact: text(option.impact, '选项影响', 240) }));
    if (new Set(normalized.map(option => option.label)).size !== normalized.length) throw new Error('问题选项不能重复');
    const recommendation = item.recommendation ? text(item.recommendation, '推荐选项', 80) : '';
    if (recommendation && !normalized.some(option => option.label === recommendation)) throw new Error('推荐必须对应已有选项');
    return { question: text(item.question, '需要决定的问题', 200), context: text(item.context, '问题背景', 600), reason: text(item.reason, '需要用户决定的原因', 400),
      options: normalized, recommendation, answerHint: text(item.answerHint, '回答指引', 240) };
  });
}

// validatePlan 确保任务引用真实验收项，且每个验收项都关联任务。
export function validatePlan(raw) {
  const value = parseReply(raw);
  if (value.needsInput === true) return { needsInput: true, questions: questions(value.questions), summary: text(value.summary, '规划摘要') };
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 50) throw new Error('规划需要 1–50 个任务');
  if (!Array.isArray(value.checks) || !value.checks.length || value.checks.length > 50) throw new Error('规划需要 1–50 个可执行验收项');
  const checks = value.checks.map((item) => ({ id: text(item.id, '验收编号', 100), title: text(item.title, '验收标题', 300), command: text(item.command, '验收命令', 4000), expectation: text(item.expectation, '预期结果', 4000) }));
  const ids = new Set(checks.map((item) => item.id));
  if (ids.size !== checks.length) throw new Error('验收编号不能重复');
  const taskIds = new Set();
  const tasks = value.tasks.map((item, index) => {
    const id = item.id ? text(item.id, '任务编号', 100) : `task-${index + 1}`;
    const dependsOn = item.dependsOn || [];
    if (!Array.isArray(dependsOn) || dependsOn.some(key => !taskIds.has(key)) || taskIds.has(id)) throw new Error('任务编号需唯一，依赖需指向排在前面的任务');
    taskIds.add(id);
    if (!Array.isArray(item.checkIds) || !item.checkIds.length || item.checkIds.some((id) => !ids.has(id))) throw new Error('每个任务必须引用已有验收编号');
    return { id, requiredCapability: taskCapability(item), dependsOn: [...new Set(dependsOn)], assignee: text(item.assignee, '执行员工编号', 100), doneWhen: item.doneWhen ? text(item.doneWhen, '完成条件', 4000) : item.description, title: text(item.title, '任务标题', 300), description: text(item.description, '任务说明'), checkIds: [...new Set(item.checkIds)] };
  });
  if (checks.some((check) => !tasks.some((task) => task.checkIds.includes(check.id)))) throw new Error('每个验收项都必须关联任务');
  let requirements;
  if (value.requirements !== undefined) {
    const item = value.requirements;
    if (!item || typeof item !== 'object') throw new Error('当前需求必须是结构化对象');
    requirements = { summary: text(item.summary, '当前需求摘要'), sourceRevision: text(item.sourceRevision, '需求来源版本', 100) };
    for (const key of ['included', 'deferred', 'excluded', 'sourceIds']) {
      if (!Array.isArray(item[key]) || item[key].length > 200) throw new Error(`当前需求 ${key} 必须是数组且不超过 200 项`);
      requirements[key] = item[key].map(value => text(value, `当前需求 ${key}`, 4000));
    }
    if (new Set(requirements.sourceIds).size !== requirements.sourceIds.length) throw new Error('需求来源不能重复');
  }
  return { needsInput: false, summary: text(value.summary, '规划摘要'), tasks, checks, ...(requirements ? { requirements } : {}) };
}

// checkUpdates 只允许修订命令，不允许悄悄替换验收目标或断言说明。
function checkUpdates(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new Error('验收命令修订必须是最多 50 项的数组');
  const ids = new Set();
  return value.map(item => {
    if (!item || Object.keys(item).some(key => !['id', 'previousCommand', 'command', 'reason'].includes(key))) throw new Error('验收命令修订包含不支持的字段');
    const update = { id: text(item.id, '验收编号', 100), previousCommand: text(item.previousCommand, '原验收命令', 4000), command: text(item.command, '新验收命令', 4000), reason: text(item.reason, '修订原因', 4000) };
    if (ids.has(update.id)) throw new Error('验收命令修订编号不能重复');
    ids.add(update.id);
    if (update.command === update.previousCommand) throw new Error('修订后的验收命令不能与原命令相同');
    return update;
  });
}

// validateWork 校验开发结果，任务仍需要由服务实际运行验收命令。
export function validateWork(raw) {
  const value = parseReply(raw);
  if (!['done', 'retry', 'needs_input'].includes(value.status)) throw new Error('未知的开发结果状态');
  const resolvedRepairIds = value.resolvedRepairIds ?? [];
  if (!Array.isArray(resolvedRepairIds) || resolvedRepairIds.length > 200 || resolvedRepairIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('已处理修复编号必须为有效编号数组');
  return { status: value.status, summary: text(value.summary, '开发摘要'), resolvedRepairIds: [...new Set(resolvedRepairIds)], checkUpdates: checkUpdates(value.checkUpdates), questions: value.status === 'needs_input' ? questions(value.questions) : [] };
}

// validateDispatch 校验负责人对修复任务或失效分配的重新安排。
export function validateDispatch(raw) {
  const value = parseReply(raw);
  if (value.needsInput === true) return { needsInput: true, questions: questions(value.questions), summary: text(value.summary, '分配摘要') };
  return { needsInput: false, assignee: text(value.assignee, '执行员工编号', 100), summary: text(value.summary, '分配摘要'), checkUpdates: checkUpdates(value.checkUpdates) };
}

// validateEvaluation 校验评估建议，最终完成还受调度器的验收条件限制。
export function validateEvaluation(raw) {
  const value = parseReply(raw);
  if (!['continue', 'repair', 'needs_input', 'complete'].includes(value.action)) throw new Error('未知的评估动作');
  const updates = checkUpdates(value.checkUpdates);
  if (updates.length && value.action !== 'repair') throw new Error('修订验收命令必须返回 repair，重新执行后才能通过验收');
  return { action: value.action, summary: text(value.summary, '评估摘要'),
    checkUpdates: updates,
    repair: value.action === 'repair' ? text(value.repair, '修复说明') : '',
    questions: value.action === 'needs_input' ? questions(value.questions) : [] };
}

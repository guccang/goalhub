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
  return value.map((item) => text(item, '问题', 2000));
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
  return { needsInput: false, summary: text(value.summary, '规划摘要'), tasks, checks };
}

// validateWork 校验开发结果，任务仍需要由服务实际运行验收命令。
export function validateWork(raw) {
  const value = parseReply(raw);
  if (!['done', 'retry', 'needs_input'].includes(value.status)) throw new Error('未知的开发结果状态');
  return { status: value.status, summary: text(value.summary, '开发摘要'), questions: value.status === 'needs_input' ? questions(value.questions) : [] };
}

// validateDispatch 校验负责人对修复任务或失效分配的重新安排。
export function validateDispatch(raw) {
  const value = parseReply(raw);
  if (value.needsInput === true) return { needsInput: true, questions: questions(value.questions), summary: text(value.summary, '分配摘要') };
  return { needsInput: false, assignee: text(value.assignee, '执行员工编号', 100), summary: text(value.summary, '分配摘要') };
}

// validateEvaluation 校验评估建议，最终完成还受调度器的验收条件限制。
export function validateEvaluation(raw) {
  const value = parseReply(raw);
  if (!['continue', 'repair', 'needs_input', 'complete'].includes(value.action)) throw new Error('未知的评估动作');
  return { action: value.action, summary: text(value.summary, '评估摘要'),
    repair: value.action === 'repair' ? text(value.repair, '修复说明') : '',
    questions: value.action === 'needs_input' ? questions(value.questions) : [] };
}

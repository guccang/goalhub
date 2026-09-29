// 本文件定义项目独立员工、职位说明与负责人；旧职责仅用于迁移历史配置。
import { effectiveLanguage, validateLanguage } from './languages.mjs';
import { createHash } from 'node:crypto';
export const duties = {
  planner: { name: '项目负责人', character: 'michael', instructions: '理解项目目标和架构，拆解并分配任务，跟进反馈，检查进度与交付证据。' },
  developer: { name: '开发工程师', character: 'jim', instructions: '根据项目架构与当前任务实现功能，完成相关测试并汇报结果与阻断。' },
  evaluator: { name: '技术审查员', character: 'dwight', instructions: '根据负责人分配的任务审查设计和代码，提供有证据的风险与改进建议。' },
  'final-review': { name: '测试工程师', character: 'pam', instructions: '根据负责人分配的任务验证需求和边界行为，提交测试结果与验收证据。' },
};
export const characters = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley', 'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'];
export const characterNames = Object.fromEntries(characters.map(character => [character, character[0].toUpperCase() + character.slice(1)]));

export const capabilities = ['development', 'testing', 'design', 'review', 'documentation', 'coordination'];
// employeeCapabilities 兼容旧员工配置，主管默认不承担开发。
export function employeeCapabilities(employee) {
  if (employee.capabilities !== undefined) {
    if (!Array.isArray(employee.capabilities) || employee.capabilities.some(value => !capabilities.includes(value))) throw new Error('员工能力配置无效');
    return [...new Set(employee.capabilities)];
  }
  if (employee.isLead || employee.role === 'planner') return ['coordination', 'review'];
  const position = employee.position || '';
  if (/开发|developer|engineer/i.test(position) && !/测试开发|test engineer/i.test(position)) return ['development'];
  if (/测试|QA|test/i.test(position) || employee.role === 'final-review') return ['testing'];
  if (/审查|review/i.test(position) || employee.role === 'evaluator') return ['review'];
  if (/设计|design/i.test(position)) return ['design'];
  if (/文档|document/i.test(position)) return ['documentation'];
  return ['development'];
}
// taskCapability 校验任务能力，旧任务默认按开发处理。
export function taskCapability(task) {
  const value = task.requiredCapability || task.required_capability || 'development';
  if (!capabilities.includes(value)) throw new Error('任务所需能力无效');
  return value;
}
// eligibleEmployees 只允许启用且具备所需能力的员工承接任务。
export function eligibleEmployees(project, task) {
  return team(project).filter(employee => employee.enabled && employee.capabilities.includes(taskCapability(task)));
}

// team 将旧的固定职责读成独立职位，保留员工编号以衔接历史任务和执行记录。
export function team(project) {
  const original = project.settings.employees ?? Object.entries(duties).map(([role, value]) => ({ id: role === 'final-review' ? 'quality' : role, role, name: characterNames[value.character], character: value.character, enabled: true, hostType: project.settings.hostType || 'codex', model: project.settings.model || '', reasoningEffort: (project.settings.hostType || 'codex') === 'codex' ? project.settings.reasoningEffort || '' : '', timeoutMinutes: project.settings.agentTimeoutMinutes || 30, instructions: value.instructions, nativeLanguage: '' }));
  const legacyLeader = original.find(employee => employee.enabled && employee.role === 'planner')?.id;
  return original.map(employee => {
    const isLead = employee.isLead ?? employee.id === legacyLeader;
    const defaults = duties[employee.role] || duties[isLead ? 'planner' : 'developer'];
    // 旧版混合了目标和职位，保留原文供查看，执行时使用不绑定目标的职责。
    const legacy = employee.instructionsVersion !== 2 || employee.position === undefined;
    return { ...employee, timeoutMinutes: employee.timeoutMinutes ?? project.settings.agentTimeoutMinutes ?? 30, capabilities: employeeCapabilities({ ...employee, isLead, position: legacy ? defaults.name : employee.position }), name: employee.name || characterNames[employee.character], isLead, instructionsVersion: 2,
      position: legacy ? defaults.name : employee.position,
      instructions: legacy ? defaults.instructions : employee.instructions,
      ...(legacy && employee.instructions ? { legacyInstructions: employee.instructions, legacyPosition: employee.position || '' } : {}) };
  });
}

// validateTeam 校验完整草稿，不再要求四类职责；负责人最多一人且必须启用。
export function validateTeam(value) {
  if (!Array.isArray(value) || value.length > 15) throw new Error('员工数量应为 0–15 人');
  const ids = new Set();
  const employees = value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,60}$/.test(item.id) || ['test', 'human', 'goalhub-god'].includes(item.id) || ids.has(item.id)) throw new Error('员工编号无效、重复或属于全局管理者');
    ids.add(item.id);
    if (!['codex', 'claudecode', 'deepseek-harness', 'opencode'].includes(item.hostType)) throw new Error('员工宿主无效');
    if (!characters.includes(item.character) || typeof item.enabled !== 'boolean' || typeof item.isLead !== 'boolean') throw new Error('员工形象、负责人或启用状态无效');
    for (const [key, max] of [['position', 100], ['model', 150], ['instructions', 4000]]) if (typeof item[key] !== 'string' || item[key].length > max) throw new Error(`${key} 长度或类型无效`);
    if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(item.reasoningEffort)) throw new Error('思考强度无效');
    if (item.hostType !== 'codex' && item.reasoningEffort) throw new Error('当前仅 Codex 支持配置思考强度');
    if (!Number.isFinite(item.timeoutMinutes) || item.timeoutMinutes < 1 || item.timeoutMinutes > 240) throw new Error('执行时限应为 1–240 分钟');
    if (item.isLead && !item.enabled) throw new Error('项目负责人必须参与执行');
    for (const key of ['legacyInstructions', 'legacyPosition']) if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 4000)) throw new Error('历史职责格式无效');
    return { capabilities: employeeCapabilities(item), instructionsVersion: 2, ...(item.legacyInstructions ? { legacyInstructions: item.legacyInstructions, legacyPosition: item.legacyPosition || '' } : {}), nativeLanguage: validateLanguage(item.nativeLanguage, true), id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 100) : characterNames[item.character], position: item.position.trim(), isLead: item.isLead, character: item.character, enabled: item.enabled, hostType: item.hostType, model: item.model.trim(), reasoningEffort: item.reasoningEffort, timeoutMinutes: item.timeoutMinutes, instructions: item.instructions.trim(),
      ...(Object.hasOwn(duties, item.role) ? { role: item.role } : {}) };
  });
  if (employees.filter(employee => employee.isLead).length > 1) throw new Error('每个项目只能指定一名负责人');
  return employees;
}

// requireTeam 启动时要求负责人及启用员工的职位定义，草稿仍允许暂不完整。
export function requireTeam(project) {
  const employees = team(project).filter(employee => employee.enabled);
  if (employees.filter(employee => employee.isLead).length !== 1) throw new Error('请指定一名参与执行的项目负责人');
  const missing = employees.find(employee => !employee.position.trim() || !employee.instructions.trim());
  if (missing) throw new Error(`请补充 ${missing.name} 的职位名称和工作说明`);
}

// validateAssignments 拒绝计划引用未启用或不存在的员工，任务直接指向真实项目成员。
export function validateAssignments(project, plan) {
  for (const task of plan.tasks) if (!eligibleEmployees(project, task).some(employee => employee.id === task.assignee)) throw new Error(`任务「${task.title}」必须分配给本项目启用员工，且具备 ${taskCapability(task)} 能力`);
  return plan;
}

// assignEmployee 按任务员工编号执行；规划、协调和验收由项目负责人承担，不做职责轮换。
export function assignEmployee(store, project, phase, employeeId = '') {
  const employees = team(project).filter(employee => employee.enabled);
  const selected = phase === 'developer' ? employees.find(employee => employee.id === employeeId) : employees.find(employee => employee.isLead);
  if (!selected) throw new Error(phase === 'developer' ? '任务尚未分配给可用员工，请由项目负责人重新分配' : '没有启用的项目负责人');
  const employee = { ...selected, effectiveLanguage: effectiveLanguage(project, selected) };
  const configKey = createHash('sha256').update(JSON.stringify(['durable-roles-v2', project.executionGoalId || '', employee.id, employee.position, employee.capabilities, employee.isLead, employee.hostType, employee.model, employee.reasoningEffort, employee.instructions, employee.effectiveLanguage, project.settings.language || 'zh-CN', project.settings.context || ''])).digest('hex');
  return { ...employee, configKey };
}

// executionTimeoutMs 只读取实际执行员工的时限，拒绝无效值，避免定时器退化为立即超时。
export function executionTimeoutMs(employee) {
  const minutes = employee?.timeoutMinutes;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new Error('请在员工配置中设置有效的处理时限（1–240 分钟）');
  return minutes * 60000;
}

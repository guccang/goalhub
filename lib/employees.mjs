// 本文件定义项目员工、参数校验和职责分配；认证凭据继续由全局宿主管理。
import { effectiveLanguage, validateLanguage } from './languages.mjs';
import { createHash } from 'node:crypto';
export const duties = {
  planner: { name: '项目经理', character: 'michael' },
  developer: { name: '软件工程师', character: 'jim' },
  evaluator: { name: '技术主管', character: 'dwight' },
  'final-review': { name: '质量工程师', character: 'pam' },
};
export const characters = ['michael', 'jim', 'pam', 'dwight', 'kevin', 'angela', 'oscar', 'stanley', 'phyllis', 'andy', 'kelly', 'ryan', 'toby', 'creed', 'meredith'];
// team 为旧项目生成兼容的默认员工，读取时不修改历史数据。
export function team(project) {
  return project.settings.employees ?? Object.entries(duties).map(([role, value]) => ({ id: role === 'final-review' ? 'quality' : role, name: value.name, role, character: value.character, enabled: true, hostType: project.settings.hostType || 'codex', model: project.settings.model || '', reasoningEffort: project.settings.hostType === 'codex' ? project.settings.reasoningEffort || '' : '', timeoutMinutes: project.settings.agentTimeoutMinutes || 30, instructions: '', nativeLanguage: '' }));
}
// validateTeam 严格限制可写字段，不允许员工配置包含凭据或任意执行参数。
export function validateTeam(value) {
  if (!Array.isArray(value) || value.length > 15) throw new Error('员工数量应为 0–15 人');
  const ids = new Set();
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,60}$/.test(item.id) || ['test', 'human'].includes(item.id) || ids.has(item.id)) throw new Error('员工编号无效或重复');
    ids.add(item.id);
    if (!Object.hasOwn(duties, item.role)) throw new Error('员工职责无效');
    if (!['codex', 'claudecode', 'deepseek-harness', 'opencode'].includes(item.hostType)) throw new Error('员工宿主无效');
    if (!characters.includes(item.character) || typeof item.enabled !== 'boolean') throw new Error('员工形象或启用状态无效');
    for (const [key, max] of [['name', 60], ['model', 150], ['instructions', 4000]]) if (typeof item[key] !== 'string' || item[key].length > max) throw new Error(`${key} 长度或类型无效`);
    if (!item.name.trim()) throw new Error('请输入员工名称');
    if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(item.reasoningEffort)) throw new Error('思考强度无效');
    if (item.hostType !== 'codex' && item.reasoningEffort) throw new Error('当前仅 Codex 支持配置思考强度');
    if (!Number.isFinite(item.timeoutMinutes) || item.timeoutMinutes < 1 || item.timeoutMinutes > 240) throw new Error('执行时限应为 1–240 分钟');
    return { nativeLanguage: validateLanguage(item.nativeLanguage, true), id: item.id, name: item.name.trim(), role: item.role, character: item.character, enabled: item.enabled, hostType: item.hostType, model: item.model.trim(), reasoningEffort: item.reasoningEffort, timeoutMinutes: item.timeoutMinutes, instructions: item.instructions.trim() };
  });
}
// requireTeam 在启动之前检查四类职责，允许编辑期间暂存不完整团队。
export function requireTeam(project) {
  const employees = team(project);
  const missing = Object.entries(duties).filter(([role]) => !employees.some(employee => employee.enabled && employee.role === role));
  if (missing.length) throw new Error('请在员工管理中补齐启用的职责：' + missing.map(([, value]) => value.name).join('、'));
}
// assignEmployee 同职责员工按已执行轮数轮换，配置指纹隔离不同模型和宿主的会话。
export function assignEmployee(store, project, role) {
  const eligible = team(project).filter(employee => employee.enabled && employee.role === role);
  if (!eligible.length) throw new Error(`没有启用的${duties[role]?.name || role}`);
  const count = store.db.prepare('SELECT count(*) AS n FROM runs WHERE project_id=? AND role=?').get(project.id, role).n;
  const employee = { ...eligible[count % eligible.length], effectiveLanguage: effectiveLanguage(project, eligible[count % eligible.length]) };
  const configKey = createHash('sha256').update(JSON.stringify([employee.id, employee.hostType, employee.model, employee.reasoningEffort, employee.instructions, employee.effectiveLanguage, project.settings.language || 'zh-CN'])).digest('hex');
  return { ...employee, configKey };
}

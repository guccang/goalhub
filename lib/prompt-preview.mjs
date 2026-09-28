// 本文件生成只读提示词快照，预览不会启动模型、保存草稿或改变执行状态。
import { phasePrompt, employeePrompt } from './prompts.mjs';
import { assignEmployee, team, validateTeam } from './employees.mjs';
import { deliveryRepairInstruction } from './delivery.mjs';
import { validateLanguage } from './languages.mjs';

// previewPrompts 使用当前项目和可选未保存输入，还原各个模型调用阶段。
export function previewPrompts({ store, orchestrator, teamBuilder }, id, value = {}) {
  const saved = store.project(id);
  if (!saved) throw new Error('项目不存在');
  const project = { ...saved, settings: { ...saved.settings } };
  for (const [key, max] of [['goal', 30000], ['context', 20000], ['instruction', 10000]]) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > max)) throw new Error(`${key} 长度或类型无效`);
  }
  if (value.goal !== undefined) project.goal = value.goal;
  if (value.context !== undefined) project.settings.context = value.context;
  if (value.language !== undefined) project.settings.language = validateLanguage(value.language);
  if (value.employees !== undefined) project.settings.employees = validateTeam(value.employees);
  if (value.role === 'team-builder') {
    // God 实际调用参考已保存团队，目标、背景和语言取当前表单。
    const request = teamBuilder.prepare(saved, value);
    return { note: '依据当前目标、背景、语言和已保存的 God 配置生成；预览不会调用模型。', entries: [{ title: 'God 一键搭建团队', input: request.input, executor: request.god }] };
  }
  const context = JSON.parse(orchestrator.context(id));
  context.goal = project.goal; context.projectContext = project.settings.context || '';
  context.employees = team(project).map(({ id, name, position, enabled, isLead }) => ({ id, name, position, enabled, isLead }));
  if (value.goal !== undefined) {
    context.tasks = []; context.checks = []; context.questions = []; context.instructions = []; context.recentEvents = []; context.summary = '';
  }
  if (value.instruction) context.instructions.push({ content: value.instruction });
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers) || value.answers.some(item => !item || typeof item.answer !== 'string' || item.answer.length > 10000)) throw new Error('回答格式无效');
    context.questions = context.questions.map(question => ({ ...question, answer: value.answers.find(item => item.id === question.id)?.answer ?? question.answer }));
  }
  const tasks = value.goal === undefined ? store.tasks(id) : [];
  if (value.taskId && !tasks.some(item => item.id === value.taskId)) throw new Error('当前目标中没有此任务，请在执行记录中查看当时的提示词');
  let task = (value.taskId ? tasks.find(item => item.id === value.taskId) : tasks.find(item => item.status !== 'done' && item.depends_on.every(id => tasks.some(dependency => dependency.id === id && dependency.status === 'done')))) || { title: '待规划或分配的任务', description: '实际调用时替换为已分配任务', assignee: value.employeeId || '' };
  const roles = { planner: '负责人规划', coordinator: '任务分配', developer: '员工执行', evaluator: '定时进度评估', 'final-review': '最终验收评估' };
  // 操作预览仅展示即将启动的阶段，补充任务使用与调度器一致的内容。
  let nextRole = value.role;
  if (value.action === 'delivery/build') {
    const instruction = deliveryRepairInstruction(project); context.instructions.push({ content: instruction });
    context.delivery.savedConfig = null; context.delivery.configSource = 'repository';
    task = { title: '准备可使用的项目预览与交付', description: instruction, assignee: '', check_ids: context.checks.map(check => check.id) };
    context.tasks.push(task); nextRole = 'coordinator';
  } else if (value.action === 'steer' && saved.resume_phase === 'execute') {
    task = { title: '落实补充执行要求', description: `用户补充执行要求：${value.instruction}\n保持原目标，完成后重新运行相关验收。`, assignee: '', check_ids: context.checks.map(check => check.id) };
    context.tasks.push(task);
    const pending = tasks.find(item => item.status !== 'done' && item.depends_on.every(id => tasks.some(dependency => dependency.id === id && dependency.status === 'done')));
    if (pending) task = pending;
    nextRole = team(project).some(employee => employee.enabled && employee.id === task.assignee) ? 'developer' : 'coordinator';
  } else if (value.action === 'evaluate') nextRole = 'evaluator';
  else if (value.action && !nextRole) {
    nextRole = saved.resume_phase === 'plan' ? 'planner' : tasks.some(item => item.status !== 'done')
      ? team(project).some(employee => employee.enabled && employee.id === task.assignee) ? 'developer' : 'coordinator'
      : 'final-review';
  }
  const selected = nextRole ? [nextRole] : Object.keys(roles);
  if (selected.some(role => !Object.hasOwn(roles, role))) throw new Error('不支持的提示词阶段');
  const entries = selected.map(role => {
    try {
      const employeeId = value.employeeId || task.assignee || team(project).find(item => item.enabled && !item.isLead)?.id || team(project).find(item => item.enabled)?.id;
      const executor = assignEmployee(store, project, role, employeeId);
      const input = employeePrompt(phasePrompt(role, { context: JSON.stringify(context), task, feedback: orchestrator.controls.get(id)?.feedback || '' }), executor, project);
      return { title: roles[role], input, executor };
    } catch (error) { return { title: roles[role], error: error.message }; }
  });
  return { note: '当前上下文快照；任务、运行记录、评估反馈及会话历史会随执行更新。尚未分配的任务以占位说明展示，实际发送内容可在执行记录中查看。', entries };
}

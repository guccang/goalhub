// 本文件在最终构建和测试之后重新安排独立审查，防止只读校验误用旧证据。
import { phasePrompt } from './prompts.mjs';
import { validateWork } from './protocol.mjs';
import { eligibleEmployees, taskCapability } from './employees.mjs';

// finalVerification 先运行普通验收，再由具备审查能力的员工更新报告并运行对应校验。
export async function finalVerification(engine, control, cwd, tasks) {
  const { store } = engine, id = control.id;
  const checks = store.checks(id).filter(check => check.status !== 'retired' && tasks.some(task => task.check_ids.includes(check.id)));
  const reviews = tasks.filter(task => taskCapability(task) === 'review');
  // 生成证据的测试任务必须在生成阶段之后重新复核和封存，再进行独立审查。
  const evidenceTasks = tasks.filter(task => taskCapability(task) === 'testing' && checks.some(check => task.check_ids.includes(check.id) && check.stage === 'prepare'));
  const evidenceIds = new Set(evidenceTasks.flatMap(task => task.check_ids).filter(key => checks.some(check => check.id === key && check.stage !== 'prepare')));
  const reviewIds = new Set(reviews.flatMap(task => task.check_ids));
  // 共享命令无法保证只读审查的边界，明确拒绝歧义计划，避免把构建移到审查之后。
  const shared = checks.find(check => reviewIds.has(check.id) && tasks.some(task => taskCapability(task) !== 'review' && task.check_ids.includes(check.id)));
  if (shared) return { passed: false, reviewTask: reviews.find(task => task.check_ids.includes(shared.id)), reason: `审查验收「${shared.title}」与非审查任务共用。请拆分构建/测试与只读审查校验，再更新计划。` };
  for (const check of checks.filter(check => !reviewIds.has(check.id) && !evidenceIds.has(check.id))) {
    if (!await engine.test(control, check, cwd)) return { passed: false, reason: `最终验收「${check.title}」失败：${store.checks(id).find(item => item.id === check.id)?.output || ''}` };
  }
  for (const task of [...evidenceTasks, ...reviews]) {
    const evidenceRefresh = evidenceTasks.includes(task), refreshKind = evidenceRefresh ? 'evidence' : 'review';
    engine.assertActive(control);
    if (control.directive) return { interrupted: true };
    const candidates = eligibleEmployees(store.project(id), task);
    const employee = candidates.find(item => item.id === task.assignee) || candidates[0];
    if (!employee) return { passed: false, reviewTask: task, reason: `最终审查「${task.title}」缺少启用的 ${taskCapability(task)} 员工。` };
    store.assignTask(id, task.id, employee.id, evidenceRefresh ? '证据准备完成，实际复核并封存后运行校验。' : '最终构建与测试完成，重新审查本轮证据后再校验报告。');
    store.event(id, `${refreshKind}.refresh.started`, JSON.stringify({ taskId: task.id, employeeId: employee.id }));
    // 保留任务的原完成状态，失败时由调用方登记阻断，不能把员工成功退出当作审查通过。
    control.finalReviewTask = task;
    try {
      const feedback = evidenceRefresh ? '平台已完成本轮 prepare 证据生成。请实际复核本轮结果并完成本任务的证据封存；不得重跑会覆盖证据的准备命令，不得仅刷新摘要冒充复核。之后平台只运行 verify 校验，再进入独立审查。若本轮证据失败，返回 retry 并说明实际缺项。' : '最终构建和普通验收已执行，证据可能已更新。请按本任务要求重新独立审查当前源码、产物及本轮测试证据，完成真实审查后更新审查报告和证据绑定。不得仅刷新哈希或伪造通过结论，不重跑会覆盖证据的构建与验收，不修改产品源码或测试脚本。若确需修改实现或重测，返回 retry 并说明具体原因。随后平台只执行本审查任务关联的校验命令。';
      const result = validateWork(await engine.agent(control, 'developer', cwd, phasePrompt('developer', { context: engine.context(id), task, feedback }), true, employee.id));
      engine.assertActive(control);
      if (control.directive) return { interrupted: true };
      store.saveWorkHandoff?.(id, task.id, result);
      await engine.git.checkpoint(id, `review: ${task.title}`);
      engine.assertActive(control);
      if (result.status === 'needs_input') { await engine.ask(control, result.questions, result.summary); store.task(task.id, 'blocked', result.summary); return { needsInput: true }; }
      if (result.status !== 'done') return { passed: false, reviewTask: task, reason: result.summary };
      store.reviseChecks(id, result.checkUpdates, { taskId: task.id, source: employee.id });
      for (const check of store.checks(id).filter(check => check.status !== 'retired' && task.check_ids.includes(check.id) && check.stage !== 'prepare')) {
        if (!await engine.test(control, check, cwd, employee.id)) return { passed: false, reviewTask: task, reason: `最终审查「${task.title}」校验失败：${store.checks(id).find(item => item.id === check.id)?.output || ''}` };
      }
      store.task(task.id, 'done', result.summary);
      store.resolveRepairs(id, task.id, result.resolvedRepairIds);
      store.event(id, `${refreshKind}.refresh.completed`, JSON.stringify({ taskId: task.id, employeeId: employee.id, summary: result.summary }));
    } catch (error) {
      engine.assertActive(control);
      if (control.directive) return { interrupted: true };
      return { passed: false, reviewTask: task, reason: error.message, teamRepair: error.teamRepair === true };
    } finally { delete control.finalReviewTask; }
  }
  return { passed: true };
}

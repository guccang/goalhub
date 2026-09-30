// 本文件验证长期职责迁移、跨目标隔离及提示词结构，避免旧验收目标继续约束新任务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { team, validateTeam, assignEmployee } from '../lib/employees.mjs';
import { employeePrompt, phasePrompt } from '../lib/prompts.mjs';

// project 构造携带旧版目标说明的项目。
function project() {
  return { goal: '新增数独小游戏', settings: { employees: [{ id: 'planner', role: 'planner', character: 'michael', enabled: true, isLead: true, position: '欢迎页面验收负责人', instructions: '仅创建 index.html 和 smoke.test.mjs，h1 为 Hello GoalHub；自行管理 worktree。', hostType: 'codex', model: '', reasoningEffort: '', timeoutMinutes: 30 }] } };
}

test('旧职责原文可查看但不注入规划、执行和验收，保存不会复活旧限制', () => {
  const value = project(), original = structuredClone(value);
  const migrated = team(value);
  assert.match(migrated[0].legacyInstructions, /Hello GoalHub/);
  assert.equal(migrated[0].position, '项目负责人');
  assert.deepEqual(value, original);
  value.settings.employees = validateTeam(migrated);
  for (const role of ['planner', 'developer', 'final-review']) {
    const employee = assignEmployee(null, value, role, 'planner');
    const input = employeePrompt(phasePrompt(role, { context: JSON.stringify({ goal: value.goal, employees: [] }), task: { title: '实现数独' } }), employee, value);
    assert.match(input, /当前需求：/); assert.match(input, /新增数独小游戏/);
    assert.doesNotMatch(input, /Hello GoalHub|欢迎页面验收负责人|仅创建/);
    assert.match(input, /Git 分支、提交和 worktree 由调度器管理/);
  }
  assert.match(team(value)[0].legacyInstructions, /Hello GoalHub/);
});

test('新版长期职责跨目标保留且修改后使旧会话失效', () => {
  const value = project(); value.settings.employees = validateTeam(team(value));
  value.settings.employees[0].instructions = '重视键盘可访问性与无依赖交付';
  const before = assignEmployee(null, value, 'planner');
  value.goal = '增加日历系统';
  assert.equal(team(value)[0].instructions, before.instructions);
  value.settings.employees[0].instructions = '重视自动化测试';
  assert.notEqual(assignEmployee(null, value, 'planner').configKey, before.configKey);
});

test('规划保留构建状态但移除历史原始日志，完整上下文对象不被修改', () => {
  const context = { goal: '数独', delivery: { lastBuild: { status: 'ready', evidence: '历史重复日志' } } };
  const input = phasePrompt('planner', { context: JSON.stringify(context) });
  assert.doesNotMatch(input, /历史重复日志/);
  assert.match(input, /ready/);
  assert.match(input, /goalhub.delivery.json/);
  assert.equal(context.delivery.lastBuild.evidence, '历史重复日志');
});

// 验证每个执行阶段均携带个人计划约束，同时保留角色权限及最终结果协议。
test('所有员工阶段先制定至少两项个人 TODO 并独立验证目标', () => {
  const value = project();
  for (const role of ['planner', 'coordinator', 'developer', 'evaluator', 'final-review']) {
    const employee = assignEmployee(null, value, role, 'planner');
    const input = employeePrompt(phasePrompt(role, { context: JSON.stringify({ goal: value.goal, employees: [] }), task: { title: '实现数独' } }), employee, value);
    // 只读评估用简短的双目标计划约束，执行阶段继续遵守完整计划协议。
    const rules = ['evaluator', 'final-review'].includes(role)
      ? ['plan.md', '判断进度', '核验证据', '只读检查', '最终只返回单个 JSON 对象']
      : ['先制定并上报个人 TODO 执行计划，再开始实际执行', '至少有两项独立 TODO', '1. 完成目标', '2. 测试目标', '复杂任务必须按依赖和可验证的阶段继续拆解', '实际完成后才标记完成', '验证失败或受阻时保留未完成状态', '结束本轮前更新计划', '必须遵守当前角色权限', '最终回复必须是单个 JSON 对象'];
    for (const rule of rules) {
      assert.ok(input.includes(rule), role + ' 缺少规则：' + rule);
    }
    assert.doesNotMatch(input, /commentary 或工作计划事件/);
  }
});

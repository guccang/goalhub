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
    assert.ok(input.startsWith('当前目标（本轮唯一产品目标）："新增数独小游戏"'));
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

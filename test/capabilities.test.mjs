// 本文件验证岗位能力的硬约束、旧配置迁移与协议持久化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { team, validateAssignments, employeeCapabilities } from '../lib/employees.mjs';
import { validatePlan } from '../lib/protocol.mjs';

test('主管默认不开发，测试员工不会误接开发，显式兼任才放行', () => {
  const project = { settings: {} };
  const employees = team(project); project.settings.employees = employees;
  const task = { title: '实现功能', requiredCapability: 'development', assignee: 'planner' };
  assert.throws(() => validateAssignments(project, { tasks: [task] }), /能力/);
  assert.throws(() => validateAssignments(project, { tasks: [{ ...task, assignee: 'quality' }] }), /能力/);
  validateAssignments(project, { tasks: [{ ...task, assignee: 'developer' }] });
  validateAssignments(project, { tasks: [{ ...task, assignee: 'quality', requiredCapability: 'testing' }] });
  employees[0].capabilities.push('development'); validateAssignments(project, { tasks: [task] });
  employees[0].enabled = false; assert.throws(() => validateAssignments(project, { tasks: [task] }), /启用/);
  assert.throws(() => employeeCapabilities({ capabilities: ['magic'] }), /无效/);
});

test('规划协议保留任务能力并拒绝未知能力和倒置依赖', () => {
  const plan = { summary: '计划', tasks: [{ id: 'dev', title: '开发', description: '实现', assignee: 'developer', checkIds: ['check'] }, { id: 'qa', title: '测试', description: '验证', assignee: 'quality', requiredCapability: 'testing', dependsOn: ['dev'], checkIds: ['check'] }], checks: [{ id: 'check', title: '验收', command: 'node --test', expectation: '行为通过' }] };
  assert.equal(validatePlan(JSON.stringify(plan)).tasks[1].requiredCapability, 'testing');
  plan.tasks[1].requiredCapability = 'magic'; assert.throws(() => validatePlan(JSON.stringify(plan)), /能力/);
  plan.tasks[1].requiredCapability = 'testing'; plan.tasks[0].dependsOn = ['qa']; assert.throws(() => validatePlan(JSON.stringify(plan)), /依赖/);
});

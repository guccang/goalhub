// 本文件验证职业模板的能力约束、草稿隔离及真实存储往返。
import test from 'node:test';
import assert from 'node:assert/strict';
import { roleTemplates, applyRoleTemplate } from '../public/employees.js';
import { team, validateTeam, validateAssignments } from '../lib/employees.mjs';
import { Store } from '../lib/store.mjs';

test('六类职业模板可校验并保存，能力与职业一致', () => {
  const store = new Store(':memory:');
  try {
    const project = store.create({ name: '模板测试', settings: {} });
    const employee = team(project)[1];
    assert.equal(roleTemplates.length, 6); assert.equal(new Set(roleTemplates.map(item => item.id)).size, 6);
    for (const template of roleTemplates) {
      const draft = applyRoleTemplate(employee, template.id);
      store.saveEmployees(project.id, validateTeam([draft]));
      const saved = team(store.project(project.id))[0];
      assert.equal(saved.instructions, template.instructions); assert.deepEqual(saved.capabilities, template.capabilities);
      assert.equal(saved.id, employee.id); assert.equal(saved.isLead, false);
    }
    const tester = applyRoleTemplate(employee, 'tester');
    assert.throws(() => validateAssignments({ settings: { employees: [tester] } }, { tasks: [{ title: '开发', assignee: tester.id, requiredCapability: 'development' }] }), /能力/);
    validateAssignments({ settings: { employees: [tester] } }, { tasks: [{ title: '测试', assignee: tester.id, requiredCapability: 'testing' }] });
  } finally { store.close(); }
});

test('应用模板保留身份模型，编辑草稿不污染模板或其他员工', () => {
  const employee = { id: 'jim', model: 'custom', hostType: 'codex', isLead: true, enabled: false, instructions: '原规范', position: '原职位', capabilities: ['review'] };
  const draft = applyRoleTemplate(employee, 'developer');
  assert.equal(draft.model, employee.model); assert.equal(draft.isLead, true); assert.equal(draft.enabled, false);
  assert.equal(employee.instructions, '原规范');
  draft.capabilities.push('testing'); draft.instructions += '定制要求';
  const another = applyRoleTemplate(employee, 'developer');
  assert.deepEqual(another.capabilities, ['development']); assert.ok(!another.instructions.includes('定制要求'));
  assert.throws(() => applyRoleTemplate(employee, 'missing'), /不存在/);
});

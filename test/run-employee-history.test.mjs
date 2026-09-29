// 本文件验证轮次执行人使用历史快照，并准确区分离职、停用、改名和系统执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { team, assignEmployee, runEmployeeIdentity } from '../lib/employees.mjs';
import { renderRunEmployee, runEmployeeText } from '../public/run-view.js';

// fixture 保存一轮真实 SQLite 员工快照，测试无需启动模型。
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '轮次身份', goal: '实现页面', settings: {} });
  const employee = assignEmployee(store, project, 'developer', 'developer');
  const runId = store.beginRun(project.id, 'developer', '执行当前任务', employee);
  store.finishRun(runId, 'completed', '已完成');
  return { store, project, employee, runId };
}

test('列表与详情返回当时员工姓名职位，不传输列表中的完整执行配置', t => {
  const f = fixture(t), list = f.store.detail(f.project.id).runs[0], detail = f.store.run(f.runId);
  assert.equal(list.employee.name, f.employee.name);
  assert.equal(list.employee.position, f.employee.position);
  assert.equal(list.employee.membership, 'active');
  assert.deepEqual(list.employee, detail.employee);
  assert.equal(list.executor, undefined); assert.equal(list.employee.instructions, undefined);
  assert.ok(detail.executor);
});

test('员工改名保留历史姓名，停用和离职分别标记，不归属到同名新员工', t => {
  const f = fixture(t), original = team(f.store.project(f.project.id));
  f.store.saveEmployees(f.project.id, original.map(item => item.id === f.employee.id ? { ...item, name: '新的姓名', enabled: false } : item));
  let run = f.store.run(f.runId);
  assert.equal(run.employee.name, f.employee.name); assert.equal(run.employee.currentName, '新的姓名');
  assert.equal(run.employee.membership, 'disabled'); assert.match(runEmployeeText(run), /已停用.*现名：新的姓名/);
  f.store.saveEmployees(f.project.id, [...original.filter(item => item.id !== f.employee.id), { ...f.employee, id: 'replacement', configKey: undefined }]);
  run = f.store.run(f.runId);
  assert.equal(run.employee.membership, 'departed'); assert.equal(run.employee.name, f.employee.name);
  assert.match(renderRunEmployee(run), /已离职/); assert.equal(f.store.detail(f.project.id).runs[0].employee.membership, 'departed');
});

test('查看旧目标也按当前团队判断离职，不能被旧目标团队快照复活', t => {
  const f = fixture(t), oldGoal = f.project.active_goal_id;
  f.store.update(f.project.id, { status: 'completed' });
  f.store.createGoal(f.project.id, { goal: '第二个目标', settings: f.project.settings });
  f.store.saveEmployees(f.project.id, team(f.store.project(f.project.id)).filter(item => item.id !== f.employee.id));
  assert.equal(f.store.detail(f.project.id, oldGoal).runs[0].employee.membership, 'departed');
  assert.equal(f.store.forGoal(f.project.id, oldGoal).detail(f.project.id).runs[0].employee.membership, 'departed');
});

test('旧轮次缺少身份不能猜成当前员工，保留编号并容忍损坏快照', () => {
  const staff = [{ id: 'developer', name: '当前开发', enabled: true }];
  const unknown = runEmployeeIdentity({ role: 'developer' }, staff);
  assert.equal(unknown.membership, 'unknown'); assert.equal(unknown.name, '员工信息未记录');
  const legacy = runEmployeeIdentity({ role: 'developer', employee_id: 'removed-id', executor: '{bad' }, staff);
  assert.equal(legacy.membership, 'departed'); assert.match(legacy.name, /removed-id/);
  const fallback = runEmployeeIdentity({ employee_id: 'developer' }, staff);
  assert.equal(fallback.nameSource, 'current'); assert.match(renderRunEmployee({ employee: fallback }), /历史姓名未记录/);
});

test('God 与旧自动验收不误标离职，有员工的验收仍显示员工身份', t => {
  const f = fixture(t);
  assert.equal(runEmployeeIdentity({ employee_id: 'goalhub-god' }, []).membership, 'external');
  assert.equal(runEmployeeIdentity({ role: 'test' }, []).membership, 'system');
  assert.equal(runEmployeeIdentity({ role: 'test', employee_id: f.employee.id, executor: JSON.stringify(f.employee) }, []).membership, 'departed');
});

test('轮次中的员工姓名、职位和编号不能插入页面代码', () => {
  const employee = { name: '<script>alert(1)</script>', id: '"bad', position: '<img src=x>', nameSource: 'snapshot', membership: 'departed' };
  const html = renderRunEmployee({ employee });
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /已离职/);
});

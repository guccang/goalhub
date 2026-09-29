// 本文件用虚拟时间验证员工时限真正控制验收与交付，不启动模型或等待数分钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { DeliveryManager } from '../lib/delivery.mjs';
import { HostSetup } from '../lib/host-setup.mjs';
import { executionTimeoutMs, team } from '../lib/employees.mjs';

// fixture 使用内存数据库和可终止句柄，保留真实运行记录与员工归属。
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.create({ name: '员工时限', goal: '检查超时归属', settings: { agentTimeoutMinutes: 8, testTimeoutSeconds: 1 } });
  const employees = team(project).map(employee => ({ ...employee, timeoutMinutes: employee.isLead ? 5 : 3 }));
  store.saveEmployees(project.id, employees);
  let stopped = 0, finish;
  const handle = { done: new Promise(resolve => { finish = resolve; }), stop() { stopped++; finish({ code: 1 }); } };
  const runtime = { async command() { return handle; } };
  const control = { id: project.id, handles: new Set(), interrupted: new Set(), cancelled: false };
  return { store, project: store.project(project.id), runtime, control, finish: value => finish(value), stopped: () => stopped };
}

// timerProbe 捕获实际定时器预算和取消行为，避免依赖平台虚拟时钟的精度。
function timerProbe(t) {
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  return timers;
}

for (const [description, employeeId, minutes] of [['任务验收使用执行员工', 'developer', 3], ['最终验收使用负责人', '', 5]]) {
  test(`${description}时限，忽略旧测试秒数且不在 120 秒误杀`, async t => {
    const f = fixture(t), orchestrator = new Orchestrator({ ...f, git: {}, delivery: {} });
    const timers = timerProbe(t);
    const pending = orchestrator.test(f.control, { id: 'check', command: 'test', title: '验收' }, '.', employeeId);
    await Promise.resolve();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, minutes * 60000);
    assert.ok(timers[0].delay > 120000);
    assert.equal(f.stopped(), 0);
    timers[0].callback();
    assert.equal(await pending, false);
    assert.equal(f.stopped(), 1);
    const run = f.store.db.prepare("SELECT * FROM runs WHERE role='test'").get();
    assert.equal(run.employee_id, employeeId || 'planner');
    assert.equal(JSON.parse(run.executor).timeoutMinutes, minutes);
    assert.match(run.output, new RegExp(`员工时限 ${minutes} 分钟`));
    assert.equal(f.control.handles.size, 0);
  });
}

test('调整员工时限后下一轮立即采用新值，成功后不会迟到终止', async t => {
  const f = fixture(t);
  f.store.saveEmployees(f.project.id, f.project.settings.employees.map(employee => ({ ...employee, timeoutMinutes: 9 })));
  const orchestrator = new Orchestrator({ ...f, git: {}, delivery: {} });
  const timers = timerProbe(t);
  const pending = orchestrator.test(f.control, { id: 'check', command: 'test' }, '.', 'developer');
  await Promise.resolve();
  assert.equal(timers[0].delay, 9 * 60000);
  assert.equal(f.stopped(), 0);
  f.finish({ code: 0 });
  assert.equal(await pending, true);
  assert.equal(timers[0].cleared, true);
  assert.equal(f.stopped(), 0);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT executor FROM runs').get().executor).timeoutMinutes, 9);
});

test('交付命令继承负责人时限，员工配置快照不被其他目标或配置变化覆盖', async t => {
  const f = fixture(t), manager = new DeliveryManager({ ...f, git: {} });
  const leader = f.project.settings.employees.find(employee => employee.isLead);
  f.store.db.prepare('INSERT INTO deliveries(id,project_id,goal_id,status,executor,created_at) VALUES(?,?,?,?,?,?)').run('release', f.project.id, f.project.active_goal_id, 'building', JSON.stringify(leader), new Date().toISOString());
  f.store.saveEmployees(f.project.id, f.project.settings.employees.map(employee => ({ ...employee, timeoutMinutes: 1 })));
  assert.equal(manager.executionPolicy('release').timeoutMs, 5 * 60000);
  const timers = timerProbe(t);
  const pending = manager.run('release', 'build', '.', f.control);
  const rejected = assert.rejects(pending, /员工时限 5 分钟/);
  await Promise.resolve();
  assert.equal(timers[0].delay, 5 * 60000);
  assert.equal(f.stopped(), 0);
  timers[0].callback();
  await rejected;
  assert.equal(f.stopped(), 1);
});

test('缺失员工时限的旧数据继承项目默认值，显式无效员工值被拒绝', () => {
  const project = { settings: { agentTimeoutMinutes: 17, employees: [{ id: 'legacy', enabled: true, role: 'developer' }] } };
  assert.equal(executionTimeoutMs(team(project)[0]), 17 * 60000);
  for (const timeoutMinutes of [undefined, 0, NaN, Infinity, 241, '30']) assert.throws(() => executionTimeoutMs({ timeoutMinutes }), /处理时限/);
});

test('全局工作沿用管理者员工超时，忽略旧宿主专属时限', async t => {
  const f = fixture(t);
  const runtime = { dataDir: '.', async load() { return { saveHostSettings() {}, inspectHostSettings() { return {}; } }; } };
  const setup = new HostSetup(f.store, runtime);
  await setup.save({ hostType: 'claudecode', model: '', probeTimeoutMinutes: 7 });
  assert.equal(setup.profile().probeTimeoutMinutes, undefined);
  setup.god.save({ ...setup.god.profile(false), timeoutMinutes: 11 });
  assert.equal(executionTimeoutMs(setup.god.profile()), 11 * 60000);
  assert.equal((await setup.snapshot()).hosts.find(host => host.hostType === 'claudecode').probeTimeoutMinutes, undefined);
  const restored = new HostSetup(f.store, runtime);
  assert.equal(restored.god.profile().timeoutMinutes, 11);
  f.store.db.prepare('UPDATE host_profile SET value=? WHERE id=1').run(JSON.stringify({ ...restored.profile(), probeTimeoutMinutes: 1 }));
  assert.equal(restored.profile().probeTimeoutMinutes, undefined);
  assert.equal(executionTimeoutMs(restored.god.profile()), 11 * 60000);
});

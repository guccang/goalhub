// 本文件验证停滞任务只升级主管一次，并可在测试任务之前请求真实构建。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { validateDispatch } from '../lib/protocol.mjs';

// recoveryFixture 模拟停滞计数及主管调度，验证保护边界不依赖模型响应速度。
function recoveryFixture() {
  const state = { failures: 2, status: 'running' }, events = [];
  const store = { project: () => state, update: (_, values) => Object.assign(state, values), recordError() {}, event: (_, kind) => events.push(kind), tasks: () => [{ id: 'task', status: 'pending' }] };
  const engine = new Orchestrator({ store, git: { ensure: async () => ({ work: '.' }) }, runtime: {}, delivery: {}, retryDelayMs: 0 });
  let calls = 0;
  engine.dispatch = async () => { calls++; return { id: 'task' }; };
  return { engine, state, events, control: { id: 'project' }, calls: () => calls };
}

test('连续业务失败升级主管一次，再失败保留暂停及恢复入口', async () => {
  const f = recoveryFixture(), error = Object.assign(new Error('安装包过期'), { teamRecoverable: true });
  assert.equal(await f.engine.failed(f.control, error), true);
  assert.equal(f.calls(), 1); assert.equal(f.state.failures, 0);
  f.state.failures = 2;
  assert.equal(await f.engine.failed(f.control, error), false);
  assert.equal(f.calls(), 1); assert.equal(f.state.status, 'blocked');
});

test('协议故障不会通过主管恢复产生无限循环', async () => {
  const f = recoveryFixture();
  assert.equal(await f.engine.failed(f.control, new Error('JSON 格式错误')), false);
  assert.equal(f.calls(), 0);
});

test('主管恢复失败保留明确故障，不宣称已经恢复', async () => {
  const f = recoveryFixture(); f.engine.dispatch = async () => { throw new Error('构建失败'); };
  assert.equal(await f.engine.failed(f.control, Object.assign(new Error('重试'), { teamRecoverable: true })), false);
  assert.match(f.state.summary, /构建失败/); assert.ok(f.events.includes('team.recovery.failed'));
});

test('构建请求只能由明确布尔字段发出', () => {
  assert.equal(validateDispatch(JSON.stringify({ assignee: 'jim', summary: '先构建', prepareDelivery: true })).prepareDelivery, true);
  assert.equal(validateDispatch(JSON.stringify({ assignee: 'jim', summary: '无需构建' })).prepareDelivery, false);
  assert.throws(() => validateDispatch(JSON.stringify({ assignee: 'jim', summary: '错误', prepareDelivery: 'false' })), /布尔/);
});

import { Store } from '../lib/store.mjs';
import { GoalScheduler } from '../lib/goal-scheduler.mjs';

test('主管先构建前置交付再分配员工，并把产物路径交给执行轮次', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '构建依赖', goal: '测试安装包', settings: {} });
  store.plan(project.id, { summary: '测试', tasks: [{ id: 'a', title: '验证', description: '验证', checkIds: ['c'], assignee: 'developer' }], checks: [{ id: 'c', title: '验证', command: 'node verify.mjs', expectation: '可运行' }] });
  const task = store.tasks(project.id)[0], order = [];
  const engine = new Orchestrator({ store, runtime: {}, git: { checkpoint: async () => order.push('checkpoint') }, delivery: { prepare: async () => { order.push('build'); return 'release'; }, row: () => ({ directory: '/release/source' }) } });
  engine.context = () => '{}';
  engine.agent = async () => JSON.stringify({ assignee: 'developer', summary: '验证新安装包', prepareDelivery: true });
  const control = { id: project.id };
  await engine.dispatch(control, task, '.');
  assert.deepEqual(order, ['checkpoint', 'build']); assert.match(control.feedback, /release\/source/);
  assert.equal(store.tasks(project.id)[0].assignee, 'developer');
});

test('队列恢复先清除旧分配，保留已完成分工', () => {
  const cleared = [], updates = [];
  const project = { status: 'blocked', settings: {} };
  // 使用真实默认员工配置通过团队校验，队列槽位本身不在本测试范围。
  const store = new Store(':memory:');
  try {
    Object.assign(project, store.create({ name: '队列恢复', goal: '测试', settings: {} }), { status: 'blocked' });
    const scheduler = Object.create(GoalScheduler.prototype);
    scheduler.steering = new Set(); scheduler.pump = () => {};
    scheduler.engine = () => ({ controls: new Map(), store: { project: () => project, questions: () => [], tasks: () => [{ id: 'done', status: 'done' }, { id: 'pending', status: 'pending' }], clearAssignment: id => cleared.push(id), update: (_, value) => updates.push(value) } });
    scheduler.start(project.id);
    assert.deepEqual(cleared, ['pending']); assert.equal(updates[0].status, 'queued');
  } finally { store.close(); }
});

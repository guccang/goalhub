// 本文件验证模块约定、并行容量、滚动规划和重启恢复的持久化边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPolicy, TaskSlots } from '../lib/execution-policy.mjs';
import { validatePlan, validateModulePlan, validateControl } from '../lib/protocol.mjs';
import { Store } from '../lib/store.mjs';
import { buildOfficeSnapshot } from '../lib/office.mjs';
import { assignEmployee } from '../lib/employees.mjs';

// plan 构造只有数据含义、没有字段级定义的有效模块计划。
function plan() {
  return validatePlan(JSON.stringify({ summary: '模块并行', tasks: [
    { id: 'ui', title: '页面', description: '显示身份', scope: '界面', inputs: '身份', outputs: '显示状态', assignee: 'developer', checkIds: ['check'] },
    { id: 'api', title: '服务', description: '验证身份', scope: '服务', inputs: '凭据', outputs: '身份', assignee: 'developer', checkIds: ['check'] },
    { id: 'join', title: '集成', description: '适配实际接口', phase: 'integration', dependsOn: ['ui', 'api'], assignee: 'developer', checkIds: ['check'] },
  ], checks: [{ id: 'check', title: '验证', command: 'node test.mjs', expectation: '身份正确显示' }] }));
}

test('模块计划只要求语义和范围，但每个模块必须进入真实集成开发', () => {
  const value = plan(); assert.doesNotThrow(() => validateModulePlan(value));
  value.tasks[2].dependsOn = ['ui']; assert.throws(() => validateModulePlan(value), /服务.*集成任务/);
  value.tasks[2].dependsOn = ['ui', 'api']; value.tasks[0].inputs = ''; assert.throws(() => validateModulePlan(value), /数据输入输出/);
});

test('旧项目默认串行，配置校验和主管停止决策不能自动恢复', () => {
  assert.equal(executionPolicy().executionMode, 'serial');
  assert.throws(() => executionPolicy({ maxParallelTasks: 0 }));
  assert.throws(() => executionPolicy({ executionMode: 'unknown' }));
  assert.equal(validateControl(JSON.stringify({ action: 'pause', summary: '停止', resume: true })).resume, false);
  assert.throws(() => validateControl(JSON.stringify({ action: 'cancel_tasks', taskIds: [], summary: '取消', resume: false })));
});

test('任务容量跨目标共用，取消等待和重复释放不泄漏名额', async () => {
  const pool = new TaskSlots(), a = new AbortController(), b = new AbortController(), c = new AbortController();
  const release = await pool.acquire('project', 1, a.signal);
  const cancelled = pool.acquire('project', 1, b.signal); b.abort(); await assert.rejects(cancelled, /暂停/);
  let acquired = false;
  const next = pool.acquire('project', 1, c.signal).then(done => { acquired = true; return done; });
  await Promise.resolve(); assert.equal(acquired, false); release(); release();
  const done = await next; assert.equal(pool.projects.get('project').active, 1); done(); assert.equal(pool.projects.get('project').active, 0);
});

test('滚动规划不能丢失远期模块，已完成任务保留编号和状态', () => {
  const store = new Store(':memory:');
  try {
    const p = store.create({ name: '分批', goal: '分批实现', settings: { executionMode: 'parallel' } });
    const value = plan(), input = store.requirementInput(p.id);
    value.requirements = { summary: '分批实现', included: ['分批实现'], deferred: [], excluded: [], sourceRevision: input.revision, sourceIds: input.sources.map(item => item.id) };
    value.modules = [{ id: 'later', title: '远期', scope: '后续能力', status: 'deferred' }];
    store.plan(p.id, value);
    for (const task of store.tasks(p.id)) store.task(task.id, 'done', '已接纳');
    const first = store.tasks(p.id)[0];
    assert.throws(() => store.plan(p.id, { ...value, modules: [] }), /保留全部/);
    assert.throws(() => store.plan(p.id, value), /增加可执行任务/);
    value.tasks.push({ ...value.tasks[0], id: 'next', title: '后续任务', description: '后续能力' });
    store.plan(p.id, value);
    assert.equal(store.tasks(p.id)[0].id, first.id); assert.equal(store.tasks(p.id)[0].status, 'done');
  } finally { store.close(); }
});

test('重启暂停未知执行且保留等待集成成果，验收阶段仍显示持久个人计划', () => {
  const store = new Store(':memory:');
  try {
    const p = store.create({ name: '恢复', goal: '恢复', settings: { executionMode: 'parallel' } }); store.plan(p.id, plan());
    const [task, queued] = store.tasks(p.id), employee = assignEmployee(store, p, 'developer', 'developer');
    store.task(task.id, 'self_testing'); store.task(queued.id, 'queued_merge');
    const run = store.beginRun(p.id, 'developer', '', employee);
    store.db.prepare('UPDATE runs SET task_id=?,task_version=?,plan_steps=? WHERE id=?').run(task.id, task.version, JSON.stringify([{ text: '完成目标', completed: true }, { text: '测试目标', completed: false }]), run);
    store.finishRun(run, 'completed', '模块完成');
    const check = store.beginRun(p.id, 'test', 'test', employee);
    store.db.prepare('UPDATE runs SET task_id=?,task_version=? WHERE id=?').run(task.id, task.version, check);
    const office = buildOfficeSnapshot(store, { controls: new Map() }, p.id);
    assert.equal(office.actors.find(actor => actor.id === 'developer').progress.at(-1).steps.length, 2);
    store.recover(); assert.equal(store.tasks(p.id)[0].status, 'pending'); assert.equal(store.tasks(p.id)[1].status, 'queued_merge');
  } finally { store.close(); }
});

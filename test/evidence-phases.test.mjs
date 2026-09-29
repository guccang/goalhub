// 本文件复现安装证据被平台重跑覆盖的循环，验证生成、封存、校验和审查的顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { validatePlan } from '../lib/protocol.mjs';

// fixture 使用可变化的安装证据，旧执行顺序必然使封存校验失败。
function fixture(t, { reject = false, mutate = false } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '证据循环', goal: '真实交付', settings: {} });
  const plan = validatePlan(JSON.stringify({ summary: '生成和消费分离', tasks: [
    { id: 'qa', title: '安装验证', description: '核对真实安装证据', requiredCapability: 'testing', assignee: 'quality', checkIds: ['install', 'accept'] },
    { id: 'review', title: '独立审查', description: '独立复核', requiredCapability: 'review', assignee: 'evaluator', dependsOn: ['qa'], checkIds: ['review'] }
  ], checks: [
    { id: 'install', title: '安装证据', command: 'install', expectation: '真实安装启动', stage: 'prepare' },
    { id: 'accept', title: '封存校验', command: 'accept', expectation: '绑定相同安装批次', stage: 'verify' },
    { id: 'review', title: '审查校验', command: 'review', expectation: '独立审查本轮结果' }
  ] }));
  store.plan(project.id, plan);
  const calls = [], state = { evidence: 0, seal: -1, review: -1 };
  const engine = new Orchestrator({ store, retryDelayMs: 0,
    git: { ensure: async () => ({ work: '.' }), checkpoint: async () => {}, review: async () => '.', removeReview: async () => {}, complete: async () => calls.push('merge') },
    delivery: { jobs: new Map(), prepare: async () => 'release', publish: () => calls.push('publish') },
    runtime: { command: async command => {
      calls.push(command);
      if (command === 'install') state.evidence++;
      const passed = command === 'install' || command === 'accept' && state.seal === state.evidence || command === 'review' && state.review === state.evidence;
      return { done: Promise.resolve({ code: passed ? 0 : 1 }), stop() {} };
    } } });
  engine.schedule = () => {};
  engine.context = () => JSON.stringify({ goal: project.goal, tasks: store.tasks(project.id), checks: store.checks(project.id) });
  engine.agent = async (_, role, cwd, prompt, working, employee) => {
    if (role === 'developer') {
      if (employee === 'quality') { calls.push('seal'); state.seal = state.evidence; if (mutate) state.evidence++; }
      else if (employee === 'evaluator') { calls.push('independent-review'); state.review = state.evidence; }
      return JSON.stringify({ status: 'done', summary: '完成实际复核' });
    }
    if (role === 'coordinator') return JSON.stringify({ assignee: 'developer', summary: '修复' });
    if (role === 'final-review') { calls.push('final'); return JSON.stringify(reject ? { action: 'repair', summary: '仍有遗漏', repair: '修复遗漏' } : { action: 'complete', summary: '全部通过' }); }
    throw new Error(`不应启动 ${role}`);
  };
  return { engine, store, project, calls, state };
}

test('安装报告每次都会变化，仍可完成真实校验、独立审查和发布', async t => {
  const f = fixture(t);
  f.engine.start(f.project.id); await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.deepEqual(f.calls, ['install', 'seal', 'accept', 'independent-review', 'review', 'install', 'seal', 'accept', 'independent-review', 'review', 'final', 'merge', 'publish']);
  assert.equal(f.state.evidence, 2);
});

test('封存后证据被改写必须失败，不能跳过摘要校验冒充完成', async t => {
  const f = fixture(t, { mutate: true });
  f.engine.start(f.project.id); await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'blocked');
  assert.ok(!f.calls.includes('publish'));
});

test('最终拒绝不会被修复任务通过清零，有限收尾后保留阻断', async t => {
  const f = fixture(t, { reject: true });
  // 本用例只关注最终循环，普通修复任务都真实返回命令通过。
  f.engine.test = async () => true;
  f.engine.start(f.project.id); await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'blocked');
  assert.equal(f.calls.filter(item => item === 'final').length, 4);
  assert.equal(f.store.tasks(f.project.id).length, 5);
  assert.ok(!f.calls.includes('publish'));
});

test('生成阶段持久化且命令修订不会丢失阶段', t => {
  const f = fixture(t), check = f.store.checks(f.project.id).find(item => item.stage === 'prepare');
  f.store.reviseChecks(f.project.id, [{ id: check.id, previousCommand: 'install', command: 'install-v2', reason: '真实接口更新' }], { taskId: f.store.tasks(f.project.id)[0].id });
  assert.equal(f.store.checks(f.project.id).find(item => item.id === check.id).stage, 'prepare');
  assert.equal(f.store.db.prepare('SELECT stage FROM checks WHERE id=?').get(check.id).stage, 'prepare');
});

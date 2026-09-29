// 本文件复现主管要求等待却继续派发的空转，并验证验收规则跨阶段一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { validateDispatch } from '../lib/protocol.mjs';
import { organizeContext } from '../lib/context.mjs';
import { phasePrompt } from '../lib/prompts.mjs';

// fixture 使用真实状态存储与调度，仅模拟员工和外部命令。
function fixture(t, action) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '协调规则', goal: '完成真实功能', settings: {} });
  const plan = { summary: '实现并验证', tasks: [{ id: 'dev', title: '实现', description: '完成真实功能', assignee: 'developer', checkIds: ['check'] }], checks: [{ id: 'check', title: '行为', command: 'verify', expectation: '真实功能通过' }] };
  store.plan(project.id, plan); store.clearAssignment(store.tasks(project.id)[0].id);
  const calls = [];
  const engine = new Orchestrator({ store, retryDelayMs: 0,
    git: { ensure: async () => ({ work: '.' }), checkpoint: async () => {}, review: async () => '.', removeReview: async () => {}, complete: async () => calls.push('merge') },
    delivery: { jobs: new Map(), prepare: async () => { calls.push('build'); return {}; }, publish: () => calls.push('publish') },
    runtime: { command: async () => { calls.push('test'); return { done: Promise.resolve({ code: 0 }), stop() {} }; } } });
  engine.schedule = () => {};
  engine.context = () => JSON.stringify({ goal: project.goal, tasks: store.tasks(project.id), checks: store.checks(project.id), requirementInput: store.requirementInput(project.id) });
  engine.agent = async (_, role, cwd, prompt) => {
    calls.push(role);
    if (role === 'coordinator') return JSON.stringify({ action, summary: '缺少前置基线', reason: '先由开发生成可追溯基线，再派发测试' });
    if (role === 'planner') {
      assert.match(prompt, /先由开发生成可追溯基线/);
      const input = store.requirementInput(project.id);
      return JSON.stringify({ ...plan, requirements: { summary: '真实功能', included: ['真实功能'], deferred: [], excluded: [], sourceRevision: input.revision, sourceIds: input.sources.map(item => item.id) } });
    }
    if (role === 'developer') return JSON.stringify({ status: 'done', summary: '实现和基线完成' });
    return JSON.stringify({ action: 'complete', summary: '验收完成' });
  };
  return { store, engine, project, calls };
}

test('主管明确等待时一次停止，不派发员工、不运行测试或构建', async t => {
  const f = fixture(t, 'blocked');
  f.engine.start(f.project.id); await f.engine.controls.get(f.project.id).promise;
  assert.deepEqual(f.calls, ['coordinator']);
  assert.equal(f.store.project(f.project.id).status, 'blocked');
  assert.equal(f.store.tasks(f.project.id)[0].status, 'blocked');
  assert.match(f.store.project(f.project.id).summary, /可追溯基线/);
  assert.equal(f.store.questions(f.project.id).length, 0);
});

test('主管修正前置时自动重规划，再实施验收，不将修复当成需求', async t => {
  const f = fixture(t, 'replan'), revision = f.store.requirementInput(f.project.id).revision;
  f.engine.start(f.project.id); await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.deepEqual(f.calls, ['coordinator', 'planner', 'developer', 'test', 'test', 'final-review', 'build', 'merge', 'publish']);
  assert.equal(f.store.requirementInput(f.project.id).revision, revision);
});

test('重规划有界，连续请求不会无限消耗规划调用', async t => {
  const f = fixture(t, 'replan'), control = { id: f.project.id, coordinationReplans: 1 };
  assert.equal(await f.engine.dispatch(control, f.store.tasks(f.project.id)[0], '.'), null);
  assert.equal(control.replanRequested, undefined);
  assert.equal(f.store.project(f.project.id).status, 'blocked');
});

test('等待不能夹带执行，旧协议仍可正常派发', () => {
  assert.equal(validateDispatch('{"assignee":"developer","summary":"执行"}').action, 'execute');
  assert.throws(() => validateDispatch('{"action":"wait","summary":"等待"}'), /未知/);
  assert.throws(() => validateDispatch('{"action":"blocked","summary":"等待","reason":"设备","prepareDelivery":true}'), /不能同时/);
  assert.throws(() => validateDispatch('{"action":"replan","summary":"修改"}'), /重规划要求/);
});

test('实施与主管共享规则版本，证据状态不改版本，规则修订会改版本', () => {
  const task = { id: 'a', check_ids: ['c'], depends_on: [], done_when: '四人输入可区分' };
  const context = { goal: '合作游戏', tasks: [task], checks: [{ id: 'c', command: 'verify', expectation: '四人输入可区分', status: 'pending' }] };
  const acceptance = organizeContext(context, 'developer', task).work.acceptance;
  assert.deepEqual(organizeContext(context, 'final-review').work.acceptance, acceptance);
  context.checks[0].status = 'passed';
  assert.equal(organizeContext(context, 'evaluator').work.acceptance.revision, acceptance.revision);
  context.checks[0].expectation = '新增条件';
  assert.notEqual(organizeContext(context, 'evaluator').work.acceptance.revision, acceptance.revision);
  const prompt = phasePrompt('final-review', { context: JSON.stringify(context) });
  assert.match(prompt, /不得在审查阶段临时增加/);
  assert.doesNotMatch(prompt, /交付要求：读取并维护/);
});

import { executeParallel } from '../lib/parallel-execution.mjs';

test('并行调度保留主管的等待原因，不覆盖成通用依赖失败', async t => {
  const f = fixture(t, 'blocked');
  const control = { id: f.project.id, abort: new AbortController() };
  f.engine.git.paths = () => ({ work: '.' });
  assert.equal(await executeParallel(f.engine, control), false);
  assert.deepEqual(f.calls, ['coordinator']);
  assert.match(f.store.project(f.project.id).summary, /可追溯基线/);
});

import { validatePlan } from '../lib/protocol.mjs';

test('规划阶段拒绝最终验收不允许的审查与构建共用规则', () => {
  const tasks = ['development', 'review'].map((requiredCapability, index) => ({ id: String(index), title: requiredCapability, description: '验证目标', assignee: requiredCapability, requiredCapability, checkIds: ['shared'] }));
  assert.throws(() => validatePlan(JSON.stringify({ summary: '计划', tasks, checks: [{ id: 'shared', title: '混用规则', command: 'verify', expectation: '通过' }] })), /不能与非审查任务共用/);
});

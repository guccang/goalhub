// 本文件复现最终验收覆盖证据后的旧报告失效，并验证真正的审查调用和失败归属。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { finalVerification } from '../lib/final-verification.mjs';

// fixture 模拟会改变内容的验收文件和只读哈希校验，调度及状态仍使用真实实现。
function fixture(t, options = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.create({ name: '审查顺序回归', goal: '交付游戏', settings: {} });
  store.plan(project.id, { summary: '已有实现与审查', tasks: [
    { id: 'dev', title: '实现与验收', description: '先构建再验收', requiredCapability: 'development', assignee: 'developer', checkIds: ['build', 'acceptance'] },
    { id: 'review', title: '独立证据审查', description: '审查实际证据并保存报告', requiredCapability: 'review', assignee: 'evaluator', dependsOn: ['dev'], checkIds: ['review'] },
  ], checks: ['build', 'acceptance', 'review'].map(id => ({ id, title: id, command: id, expectation: '真实通过' })) });
  for (const task of store.tasks(project.id)) store.task(task.id, 'done', '旧任务通过');
  const calls = [], state = { evidence: '旧证据', hash: '', publications: 0 };
  // digest 计算模拟证据的实际哈希，让旧报告在验收改写后确实失效。
  const digest = () => createHash('sha256').update(state.evidence).digest('hex');
  state.hash = digest();
  const git = {
    // ensure 返回模拟工作目录，测试无需启动外部宿主。
    async ensure() { return { work: '.' }; },
    // checkpoint 记录真实调度的提交顺序。
    async checkpoint() { calls.push('checkpoint'); },
    // complete 记录完成路径，失败时不得合并。
    async complete() { calls.push('merge'); },
  };
  const delivery = {
    jobs: new Map(),
    // prepare 不执行安装构建，只检查调度是否越过审查门槛。
    async prepare() { calls.push('delivery'); return {}; },
    // publish 记录发布次数，审查失败必须为零。
    publish() { state.publications++; },
  };
  const runtime = {
    // command 模拟最终构建、覆盖证据和只读审查校验。
    async command(command, cwd, output) {
      calls.push(command);
      if (command === 'acceptance') state.evidence += '新时间与性能样本';
      const failed = options.failCheck === command || (command === 'review' && state.hash !== digest());
      output('stdout', failed ? '摘要过期：acceptance-evidence.json' : '通过');
      return { done: Promise.resolve({ code: failed ? 1 : 0 }), stop() {} };
    },
  };
  const engine = new Orchestrator({ store, git, runtime, delivery, retryDelayMs: 0 });
  // schedule 关闭定时评估，仅观察最终验收链路。
  engine.schedule = () => {};
  // context 保留提示词整理所需的真实任务与验收信息。
  engine.context = () => JSON.stringify({ goal: project.goal, tasks: store.tasks(project.id), checks: store.checks(project.id), employees: [] });
  // agent 模拟审查员真正读取新证据，返回 done 也不能绕过后续校验。
  engine.agent = async (control, role, cwd, prompt, working, employeeId) => {
    if (role === 'issue-review') {
      calls.push('supervisor');
      return JSON.stringify(options.reply?.status === 'needs_input' && !options.teamIssue
        ? { action: 'needs_input', summary: '需要确认需求范围', questions: ['本轮需要哪些功能？'] }
        : { action: 'repair', summary: '团队处理', repair: '重新构建并复核证据' });
    }
    if (role === 'coordinator') return JSON.stringify({ needsInput: false, assignee: 'developer', summary: '安排修复' });
    if (employeeId === 'developer') return JSON.stringify({ status: 'done', summary: '完成内部修复' });
    calls.push('reviewer');
    assert.equal(employeeId, 'evaluator');
    assert.match(prompt, /重新独立审查/);
    assert.match(prompt, /不重跑会覆盖证据/);
    if (options.interrupt) { control.cancelled = true; engine.assertActive(control); }
    if (options.throwReview) throw new Error('审查宿主连接失败');
    if (!options.stale || options.recover && calls.filter(value => value === 'reviewer').length > 1) state.hash = digest();
    return JSON.stringify(options.teamIssue && calls.filter(value => value === 'reviewer').length > 1 ? { status: 'done', summary: '已重新独立审查本轮证据' } : options.reply || { status: 'done', summary: '已重新独立审查本轮证据' });
  };
  // evaluate 模拟最后的只读目标核对，前面的审查校验必须已经通过。
  engine.evaluate = async () => { calls.push('evaluation'); return { action: 'complete', summary: '完成' }; };
  return { engine, store, project, calls, state, control: { id: project.id, handles: new Set(), interrupted: new Set(), abort: new AbortController() } };
}

test('最终验收覆盖证据后先重新调用审查员，再校验和发布', async t => {
  const f = fixture(t);
  f.engine.start(f.project.id);
  await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.deepEqual(f.calls.filter(value => value !== 'checkpoint'), ['build', 'acceptance', 'reviewer', 'review', 'evaluation', 'delivery', 'merge']);
  assert.equal(f.state.publications, 1);
  assert.equal(f.store.tasks(f.project.id).length, 2);
});

test('审查员返回完成但仍使用旧哈希时不可发布，阻断保留在审查任务', async t => {
  const f = fixture(t, { stale: true });
  f.engine.start(f.project.id);
  await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'blocked');
  assert.match(f.store.project(f.project.id).summary, /摘要过期/);
  const task = f.store.tasks(f.project.id)[1];
  assert.equal(task.status, 'blocked'); assert.equal(task.assignee, 'evaluator');
  assert.equal(f.calls.filter(value => value === 'supervisor').length, 3);
  assert.equal(f.state.publications, 0); assert.ok(f.store.tasks(f.project.id).length > 2);
});

test('普通验收失败时不启动审查员，保留具体命令失败原因', async t => {
  const f = fixture(t, { failCheck: 'acceptance' });
  const result = await finalVerification(f.engine, f.control, '.', f.store.tasks(f.project.id));
  assert.equal(result.passed, false); assert.equal(result.reviewTask, undefined);
  assert.match(result.reason, /acceptance.*失败/); assert.ok(!f.calls.includes('reviewer'));
});

test('审查返回 retry 或宿主异常时由主管安排有界修复', async t => {
  for (const options of [{ reply: { status: 'retry', summary: '缺少本轮独立证据' } }, { throwReview: true }]) {
    const f = fixture(t, options);
    f.engine.start(f.project.id);
    await f.engine.controls.get(f.project.id).promise;
    assert.equal(f.store.project(f.project.id).status, 'blocked');
    assert.equal(f.store.tasks(f.project.id)[1].status, 'blocked');
    assert.equal(f.state.publications, 0);
    assert.ok(!f.calls.includes('review'));
  }
});

test('重新审查提出问题须经主管确认需求歧义后才能提问', async t => {
  const f = fixture(t, { reply: { status: 'needs_input', summary: '缺少外部授权', questions: ['请提供授权信息'] } });
  f.engine.start(f.project.id);
  await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'waiting_input');
  assert.equal(f.store.questions(f.project.id).length, 1);
  assert.equal(f.state.publications, 0);
});

test('审查被用户中断时不会写成审查失败或发布', async t => {
  const f = fixture(t, { interrupt: true });
  await assert.rejects(finalVerification(f.engine, f.control, '.', f.store.tasks(f.project.id)), /暂停/);
  assert.equal(f.state.publications, 0); assert.equal(f.control.finalReviewTask, undefined);
});

test('审查与构建共用命令时明确拒绝，不能跳过构建或审查后改写证据', async t => {
  const f = fixture(t), tasks = f.store.tasks(f.project.id);
  tasks[1].check_ids.push(tasks[0].check_ids[0]);
  const result = await finalVerification(f.engine, f.control, '.', tasks);
  assert.equal(result.passed, false); assert.match(result.reason, /共用/);
  assert.deepEqual(f.calls, []);
});

test('审查员工缺失时显示能力问题，不退回开发员工', async t => {
  const f = fixture(t);
  f.store.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(JSON.stringify({ employees: [{ id: 'planner', enabled: true, isLead: true, capabilities: ['coordination'], timeoutMinutes: 10 }, { id: 'developer', enabled: true, capabilities: ['development'] }] }), f.project.id);
  const result = await finalVerification(f.engine, f.control, '.', f.store.tasks(f.project.id));
  assert.equal(result.passed, false); assert.match(result.reason, /缺少启用的 review 员工/);
  assert.ok(!f.calls.includes('reviewer'));
});

test('通用开发修复只重跑非审查验收，后续仍须独立刷新审查报告', async t => {
  const f = fixture(t);
  f.store.repair(f.project.id, '修复最终验收失败');
  const tasks = f.store.tasks(f.project.id), repair = tasks.at(-1);
  assert.equal(repair.required_capability, 'development');
  assert.deepEqual(repair.check_ids, tasks[0].check_ids);
  f.store.task(repair.id, 'done', '已修复并回归');
  const result = await finalVerification(f.engine, f.control, '.', f.store.tasks(f.project.id));
  assert.equal(result.passed, true);
  assert.deepEqual(f.calls.filter(value => value !== 'checkpoint'), ['build', 'acceptance', 'reviewer', 'review']);
});

// 暂时的审查失败由团队自动恢复，不向用户索要技术处理意见。
test('审查首次失败后自动重新验证，恢复后正常交付', async t => {
  const f = fixture(t, { stale: true, recover: true });
  f.engine.start(f.project.id);
  await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.calls.filter(value => value === 'reviewer').length, 2);
  assert.equal(f.state.publications, 1);
  assert.equal(f.store.questions(f.project.id).length, 0);
});

// 审查误报技术提问时只分流一次，并让修复员工处理后重新审查。
test('审查误报安装包技术提问时主管安排修复，不阻塞用户或重复审核', async t => {
  const f = fixture(t, { teamIssue: true, reply: { status: 'needs_input', summary: '安装包源码过期', questions: ['请说明如何重建安装包'] } });
  f.engine.start(f.project.id);
  await f.engine.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.calls.filter(value => value === 'supervisor').length, 1);
  assert.equal(f.store.questions(f.project.id).length, 0);
  assert.ok(f.store.tasks(f.project.id).some(task => task.title === '主管安排处理技术问题'));
});

// 本文件验证需求版本、五部分上下文、故障归因和恢复分流，全部使用隔离数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { GoalScheduler } from '../lib/goal-scheduler.mjs';
import { organizeContext } from '../lib/context.mjs';
import { phasePrompt } from '../lib/prompts.mjs';
import { previewPrompts } from '../lib/prompt-preview.mjs';
import { blockerFeedback } from '../public/feedback.js';
import { previewRequest } from '../public/prompt-preview.js';

// fixture 构造含冲突旧背景和用户已授权例外的真实目标。
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '上下文测试', goal: 'Godot 100%复刻', settings: { context: '旧方案 Three.js Web' } });
  store.ask(project.id, ['缺少原版资料如何处理？']); store.answer(project.id, store.questions(project.id)[0].id, '缺少就不实现，未知数值后续调优');
  const orchestrator = new Orchestrator({ store, runtime: {}, git: { paths() { return { repo: 'repo' }; } } });
  const input = store.requirementInput(project.id);
  const plan = { summary: '可执行范围', requirements: { summary: '用 Godot 实现已有资料支持的玩法', included: ['已知玩法'], deferred: ['未知数值后续调优'], excluded: ['无法取得资料的内容'], sourceRevision: input.revision, sourceIds: input.sources.map(item => item.id) },
    tasks: [{ id: 'one', title: '实现玩法', description: '实现并测试', assignee: 'developer', checkIds: ['verify'] }], checks: [{ id: 'verify', title: '功能验收', command: 'node verify.mjs', expectation: '玩法通过' }] };
  store.plan(project.id, plan);
  return { store, project, orchestrator, plan };
}

test('执行只收到当前需求和相关任务，旧目标问答背景仅保留索引', t => {
  const f = fixture(t), task = f.store.tasks(f.project.id)[0];
  const input = phasePrompt('developer', { context: f.orchestrator.context(f.project.id), task });
  for (const label of ['项目资料：', '当前需求：', '本轮任务：', '当前状态与证据：', '历史记录索引：']) assert.ok(input.includes(label));
  assert.match(input, /用 Godot 实现已有资料支持的玩法/);
  assert.doesNotMatch(input, /100%复刻|Three.js|缺少原版资料如何处理|当前任务：undefined/);
  assert.ok(f.store.questions(f.project.id)[0].prompt.includes('原版资料'));
});

test('用户新决定使需求快照失效，过期规划不能覆盖新要求', t => {
  const f = fixture(t), before = f.store.requirementInput(f.project.id).revision;
  f.store.instruction(f.project.id, '改成离线本地合作');
  const value = organizeContext(JSON.parse(f.orchestrator.context(f.project.id)), 'planner');
  assert.notEqual(value.requirements.revision, before);
  assert.equal(value.requirements.status, 'needs-consolidation'); assert.equal(value.requirements.effective, undefined);
  assert.ok(value.requirements.sources.some(item => item.content === '改成离线本地合作'));
  assert.throws(() => f.store.plan(f.project.id, f.plan), /需求来源已变化/);
  assert.equal(f.store.tasks(f.project.id).length, 1);
});

test('会话同时隔离目标与需求版本，修复及继续操作不会污染需求', t => {
  const f = fixture(t), id = f.project.id;
  const run = f.store.beginRun(id, 'developer', '输入', { id: 'developer', configKey: 'key' }); f.store.session(run, 'session');
  const revision = f.store.requirementInput(id).revision;
  f.store.instruction(id, '继续当前目标'); f.store.instruction(id, '修正测试入口', 'repair');
  assert.equal(f.store.requirementInput(id).revision, revision);
  assert.equal(f.store.employeeSession(id, 'developer', 'key'), 'session');
  f.store.instruction(id, '添加手柄操作');
  assert.equal(f.store.employeeSession(id, 'developer', 'key'), '');
  const other = f.store.enqueueGoal(id, { goal: '另一个目标' }, false);
  assert.equal(f.store.forGoal(id, other.id).employeeSession(id, 'developer', 'key'), '');
});

test('最新宿主失败压过旧验收，提示处理环境且不要求再解释需求', t => {
  const f = fixture(t), id = f.project.id;
  const check = f.store.checks(id)[0]; f.store.check(check.id, 'failed', '旧 PowerShell ParserError');
  f.store.db.prepare('UPDATE checks SET checked_at=? WHERE id=?').run('2020-01-01', check.id);
  const run = f.store.beginRun(id, 'planner', '输入'); f.store.finishRun(run, 'failed', 'spawn codex ENOENT');
  f.store.update(id, { status: 'blocked', summary: '连续三轮未能推进：spawn codex ENOENT。自动执行已停止', resume_phase: 'plan' });
  const feedback = blockerFeedback(f.store.detail(id));
  assert.doesNotMatch(feedback.reason, /ENOENT/); assert.doesNotMatch(feedback.reason, /未通过验收/);
  assert.match(feedback.request, /无需分析报错/);
  const context = organizeContext(JSON.parse(f.orchestrator.context(id)), 'planner');
  assert.equal(context.state.blocker.kind, 'host'); assert.equal(context.state.checks[0].evidenceStatus, 'historical');
  assert.equal(context.state.checks[0].output, undefined);
  f.store.update(id, { status: 'planning', summary: '正在重新规划' });
  const retry = organizeContext(JSON.parse(f.orchestrator.context(id)), 'planner');
  assert.equal(retry.state.blocker.kind, 'host');
  assert.match(retry.state.blocker.message, /spawn codex ENOENT/);
});

test('源码变化后保留关联验收的上次失败线索，不冒充当前结论', t => {
  const f = fixture(t), id = f.project.id, task = f.store.tasks(id)[0];
  f.store.check(f.store.checks(id)[0].id, 'failed', '断言失败：计算结果应为42');
  f.store.invalidate(id);
  const context = organizeContext(JSON.parse(f.orchestrator.context(id)), 'developer', task);
  assert.match(context.state.checks[0].output, /断言失败/);
  assert.equal(context.state.checks[0].evidenceStatus, 'previous-attempt; not-current-verdict');
  assert.equal(context.state.checks[0].commandVersion, context.work.checks[0].commandVersion);
});

test('修复意见通过真实验收后归档，不继续成为后续任务指令', t => {
  const f = fixture(t), id = f.project.id;
  f.store.instruction(id, '修复旧路径', 'repair');
  assert.equal(organizeContext(JSON.parse(f.orchestrator.context(id)), 'developer').work.repairInstructions.length, 1);
  f.store.resolveRepairs(id, 'other-task');
  assert.equal(f.store.instructions(id)[0].resolved_at, '');
  assert.throws(() => f.store.resolveRepairs(id, 'other-task', [f.store.instructions(id)[0].id]), /当前任务/);
  f.store.resolveRepairs(id, f.store.tasks(id)[0].id, [f.store.instructions(id)[0].id]);
  const context = organizeContext(JSON.parse(f.orchestrator.context(id)), 'developer');
  assert.equal(context.work.repairInstructions.length, 0); assert.equal(context.history.resolvedRepairIds.length, 1);
  assert.equal(f.store.instructions(id)[0].content, '修复旧路径');
});

// 手动评估先定位真实运行分工，并保持命令验收规则可供修复时引用。
test('立即评估区分触发方式并压缩重复任务详情', t => {
  const f = fixture(t), id = f.project.id, task = f.store.tasks(id)[0];
  f.store.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('running', task.id);
  const context = JSON.parse(f.orchestrator.context(id));
  const work = organizeContext(context, 'evaluator').work;
  assert.equal(work.evaluation.scope, '当前目标整体进度');
  assert.equal(work.evaluation.activeAssignments[0].assignee, 'developer');
  assert.equal(work.tasks[0].spec, undefined);
  assert.equal(work.tasks[0].done_when, undefined);
  assert.equal(work.checks[0].command, undefined);
  assert.equal(work.acceptance.checks[0].command, 'node verify.mjs');
  const manual = phasePrompt('evaluator', { context: JSON.stringify(context), trigger: 'manual' });
  const scheduled = phasePrompt('evaluator', { context: JSON.stringify(context) });
  assert.match(manual, /手动立即进度检查/);
  assert.match(manual, /运行中的检查尚无结果时返回 continue/);
  assert.match(scheduled, /定时进度检查/);
  assert.doesNotMatch(manual, /所有员工、所有阶段必需/);
  assert.doesNotMatch(manual, /"spec":/);
});

for (const scheduled of [false, true]) test(`${scheduled ? '队列' : '串行'}恢复流程仅需求变更触发重新规划`, async t => {
  const f = fixture(t), id = f.project.id;
  const engine = scheduled ? new GoalScheduler({ store: f.store, git: {}, runtime: {} }) : f.orchestrator;
  if (scheduled) t.mock.method(engine, 'engine', () => ({ store: f.store }));
  t.mock.method(engine, 'pause', async () => {}); t.mock.method(engine, 'start', () => {});
  await engine.steer(id, '已处理宿主路径', undefined, 'repair');
  assert.equal(f.store.project(id).resume_phase, 'execute');
  await engine.steer(id, '继续当前目标'); assert.equal(f.store.project(id).resume_phase, 'execute');
  await engine.steer(id, '增加手柄支持'); assert.equal(f.store.project(id).resume_phase, 'plan');
});

test('修复入口预览采用原执行阶段，需求入口才预览规划', t => {
  const f = fixture(t), id = f.project.id;
  const request = previewRequest(`/projects/${id}/steer`, { content: '修复路径', intent: 'repair' });
  assert.equal(request.value.intent, 'repair');
  const preview = previewPrompts(f, id, request.value);
  assert.equal(preview.entries[0].title, '员工执行'); assert.match(preview.entries[0].input, /修复路径/);
  const replan = previewPrompts(f, id, { action: 'steer', instruction: '增加模式', intent: 'requirement' });
  assert.equal(replan.entries[0].title, '负责人规划');
});

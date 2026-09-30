// 本文件验证员工进展的证据边界、输入交接与目标隔离，避免日志冒充验收结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressEvents, inputContext, currentEmployeeTask, renderEmployeeWork, renderProgress } from '../public/work-progress.js';
import { organizeContext } from '../lib/context.mjs';
import { Store } from '../lib/store.mjs';
import { createApp } from '../lib/app.mjs';

test('运行中没有最终输出仍展示真实工作进展，诊断与推理事件不冒充工作说明', () => {
  const rows = progressEvents([
    { id: 1, kind: 'agent.diagnostic', content: '模型连接重试' },
    { id: 2, kind: 'agent.item.completed', content: '已接入战斗；下一步检查存档', created_at: '2026-09-29T08:00:00Z' },
    { id: 3, kind: 'agent.item.completed', content: JSON.stringify({ item: { type: 'file_change', changes: [{ path: 'scripts/battle.gd' }] } }) },
    { id: 4, kind: 'agent.item.completed', content: JSON.stringify({ item: { type: 'reasoning', text: '内部推理' } }) },
    { id: 5, kind: 'agent.item.started', content: 'powershell -File scripts/verify.ps1' },
  ]);
  assert.equal(rows.length, 3); assert.equal(rows[0].category, 'report');
  assert.equal(rows[1].category, 'tool'); assert.equal(rows[2].category, 'tool');
  assert.match(renderProgress(rows), /下一步检查存档/);
  assert.doesNotMatch(renderProgress(rows), /内部推理|连接重试|已通过/);
  assert.match(renderProgress([], 'running'), /尚未收到/);
});

test('实际输入概览来自记录，不混入提示词中的其他文字', () => {
  const input = '前言\n<project-data>\n当前需求：\n{"effective":{"summary":"当前 Godot 目标"}}\n\n本轮任务：\n{"task":{"title":"存档"}}\n</project-data>\n后续职责';
  assert.equal(inputContext(input).work.task.title, '存档');
  assert.deepEqual(inputContext('旧格式'), {});
});

test('员工面板显示当前分工 plan.md 与上下文文档，不显示项目总目标', () => {
  const task = { id: 'one', assignmentId: 'one', title: '实现战斗', description: '处理受击', assignee: 'jim', status: 'running', documents: {} };
  const project = { id: 'project', goal: '整个游戏', viewed_goal_id: 'goal', taskDocuments: {}, tasks: [task,
    { id: 'two', title: '实现存档', assignee: 'kelly', status: 'running', documents: {} }], runs: [] };
  const actor = { id: 'jim' };
  const html = renderEmployeeWork(project, actor, { taskId: 'one', text: '# Plan\n- [ ] <检查资源>' });
  assert.match(html, /实现战斗/);
  assert.match(html, /<h4>Plan<\/h4>/);
  assert.match(html, /&lt;检查资源&gt;/);
  assert.match(html, /assignment.md|requirements.md|sources.md/);
  assert.doesNotMatch(html, /整个游戏|实现存档|<检查资源>/);
  assert.equal(currentEmployeeTask(project, { id: 'lead', isLead: true }).id, 'one');
  assert.match(renderEmployeeWork(project, { id: 'test' }), /当前没有正在执行的分工/);
});

test('前置任务的完成结果是当前执行输入，无关已完成任务不注入', () => {
  const task = { id: 'game', depends_on: ['design'], check_ids: [] };
  const context = organizeContext({ tasks: [task, { id: 'design', status: 'done', result: '资源在 assets，界面在 docs/presentation.json' }, { id: 'old', status: 'done', result: '过期成果' }] }, 'developer', task);
  assert.match(context.work.tasks.find(item => item.id === 'design').result, /presentation.json/);
  assert.ok(!context.work.tasks.some(item => item.id === 'old'));
});

test('需求快照按目标读取，需求变化后不把旧范围标为有效', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '进展测试', goal: '第一目标', settings: {} });
  const first = project.active_goal_id, input = store.requirementInput(project.id);
  store.db.prepare('INSERT INTO requirement_snapshots VALUES(?,?,?,?,?)').run(project.id, first, input.revision, JSON.stringify({ summary: '第一范围', sourceRevision: input.revision }), new Date().toISOString());
  store.publishTaskDocuments(project.id, { summary: '第一范围', sourceRevision: input.revision, sourceIds: ['goal'], included: [], deferred: [], excluded: [] });
  assert.equal(store.detail(project.id).requirements.status, 'consolidated');
  const second = store.enqueueGoal(project.id, { goal: '第二目标' }, false);
  assert.equal(store.detail(project.id, second).requirements.effective, null);
  store.instruction(project.id, '新增需求');
  assert.equal(store.detail(project.id, first).requirements.status, 'needs-consolidation');
});

test('执行记录 API 返回运行中的流事件，静态进展模块可加载', async t => {
  const store = new Store(':memory:');
  const project = store.create({ name: '流事件', goal: '测试', settings: {} });
  const run = store.beginRun(project.id, 'developer', '输入');
  store.event(project.id, 'agent.item.completed', '正在验证存档', run);
  const app = createApp({ store, runtime: {}, git: {}, orchestrator: { controls: new Map() } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); store.close(); });
  const url = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${url}/api/runs/${run}`), value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.output, '');
  assert.ok(value.events.some(event => event.content === '正在验证存档'));
  assert.equal((await fetch(`${url}/work-progress.js`)).status, 200);
});


// 验证计划正文只取当前分工，旧轮次的任务计划不混入页面。
test('员工执行计划以当前分工文档为准', () => {
  const tasks = [{ id: 'old', assignee: 'kelly', title: '旧任务', status: 'done' },
    { id: 'current', assignee: 'kelly', title: '当前任务', status: 'running', documents: {} }];
  const project = { id: 'project', viewed_goal_id: 'goal', tasks, runs: [] };
  const actor = { id: 'kelly' };
  assert.equal(currentEmployeeTask(project, actor).id, 'current');
  assert.match(renderEmployeeWork(project, actor, { taskId: 'old', text: '旧步骤' }), /正在读取当前分工/);
  assert.doesNotMatch(renderEmployeeWork(project, actor, { taskId: 'old', text: '旧步骤' }), /旧步骤/);
  assert.match(renderEmployeeWork(project, actor, { taskId: 'current', text: '- [x] 完成新步骤' }), /完成新步骤/);
});

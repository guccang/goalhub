// 本文件验证员工进展的证据边界、输入交接与目标隔离，避免日志冒充验收结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressEvents, inputContext, renderEmployeeWork, renderProgress } from '../public/work-progress.js';
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

test('员工面板区分任务完成和自报进展，转义内容并隔离其他目标的运行', () => {
  const actor = { id: 'jim', run: { id: 'run' }, events: [{ kind: 'agent.output', content: '<script>已做</script>' }], context: { work: { task: { title: '本轮战斗' } } } };
  const project = { goal: '游戏', tasks: [{ id: 'one', title: '战斗', assignee: 'jim', status: 'running', check_ids: ['check'] }, { id: 'two', title: '存档', assignee: 'jim', status: 'pending', depends_on: ['one'] }], checks: [{ id: 'check', title: '受击', expectation: '生命减少', command: 'node test.mjs', status: 'pending' }], runs: [{ id: 'run', employee_id: 'jim', status: 'running' }] };
  const html = renderEmployeeWork(project, actor);
  for (const text of ['目标是什么', '正在做什么', '计划与剩余任务', '已经做了什么', '上下文有哪些', '剩余 2 项', '生命减少', '尚未执行本项验收']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.match(html, /暂无已通过验收的任务/);
  assert.doesNotMatch(renderEmployeeWork({ ...project, runs: [] }, actor), /本轮战斗|&lt;script&gt;/);
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


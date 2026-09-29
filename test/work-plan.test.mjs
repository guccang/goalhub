// 验证计划文件兼容用户格式、运行隔离和结束时的最后状态采集。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkPlan, prepareWorkPlan } from '../lib/work-plan.mjs';
import { progressEvents } from '../public/work-progress.js';

test('兼容中文勾选和标准 Markdown，忽略示例代码块', () => {
  assert.deepEqual(parseWorkPlan('- [ ] 【X】任务1\n- [ ] 【】 任务2\n- [x] 任务3\n说明\n```md\n- [x] 示例\n```'), [
    { text: '任务1', completed: true }, { text: '任务2', completed: false }, { text: '任务3', completed: true },
  ]);
});

test('不同运行使用独立文件，实时同步和结束采集都生成可展示步骤', async t => {
  const root = mkdtempSync(join(tmpdir(), 'goalhub-plan-'));
  const updates = [], otherUpdates = [];
  const one = prepareWorkPlan(root, 'one', steps => updates.push(steps), 10);
  const two = prepareWorkPlan(root, 'two', steps => otherUpdates.push(steps), 10);
  t.after(() => { one.stop(); two.stop(); rmSync(root, { recursive: true, force: true }); });
  assert.notEqual(one.path, two.path);
  assert.match(one.instruction, /只读/);
  writeFileSync(one.path, '- [ ] 实施\n- [ ] 验证');
  for (let i = 0; !updates.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updates.length, 1);
  assert.equal(otherUpdates.length, 0);
  writeFileSync(one.path, '');
  one.stop();
  assert.equal(updates.length, 1);
  writeFileSync(one.path, '- [x] 实施\n- [ ] 验证');
  one.stop();
  assert.equal(updates.length, 2);
  const rows = progressEvents([{ kind: 'agent.plan.updated', content: JSON.stringify({ item: { type: 'todo_list', items: updates.at(-1) } }) }]);
  assert.equal(rows[0].steps[0].completed, true);
  assert.equal(rows[0].steps[1].completed, false);
});

// 通过真实调度与 SQLite 确认降级文件落库，原生事件优先且不会被文件覆盖。
test('调度器保存文件计划，原生计划保持优先', async t => {
  const { Store } = await import('../lib/store.mjs');
  const { Orchestrator } = await import('../lib/orchestrator.mjs');
  const root = mkdtempSync(join(tmpdir(), 'goalhub-plan-agent-'));
  const store = new Store(':memory:');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.create({ name: '计划降级', goal: '验证计划', settings: {} });
  for (const native of [false, true]) {
    const runtime = { dataDir: root, async host(options) {
      const path = options.input.match(/本轮个人计划文件：([^\n]+)/)[1];
      writeFileSync(path, '- [x] 文件步骤\n- [ ] 文件验证');
      if (native) options.onEvent('item.updated', JSON.stringify({ item: { type: 'todo_list', items: [{ text: '原生步骤', completed: false }] } }));
      return { done: Promise.resolve({ code: 0, finalMessage: '{}' }), stop() {} };
    } };
    const orchestrator = new Orchestrator({ store, git: {}, runtime });
    const control = { id: project.id, busyEmployees: new Set(), handles: new Set(), interrupted: new Set(), abort: new AbortController() };
    await orchestrator.agent(control, 'planner', root, '只读规划');
    const run = store.db.prepare('SELECT input,plan_steps FROM runs ORDER BY rowid DESC LIMIT 1').get();
    assert.match(run.input, /本轮个人计划文件/);
    const steps = JSON.parse(run.plan_steps);
    assert.equal(steps[0].text, native ? '原生步骤' : '文件步骤');
    assert.equal(steps[0].completed, !native);
  }
});

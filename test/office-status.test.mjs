// 本文件验证当前失败告警与历史记录分离，避免旧员工失败长期污染办公室状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { buildOfficeSnapshot } from '../lib/office.mjs';

// fixture 使用真实数据库构造办公室状态，保留历史轮次供回归断言。
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '历史失败', goal: '推进项目', settings: {} });
  const orchestrator = { controls: new Map([[project.id, {}]]) };
  // actor 每次重新生成快照，模拟页面刷新后的员工卡片。
  const actor = (id = 'developer') => buildOfficeSnapshot(store, orchestrator, project.id).actors.find(member => member.id === id);
  store.update(project.id, { status: 'running' });
  const failed = store.beginRun(project.id, 'developer', '旧任务');
  store.finishRun(failed, 'failed', '历史失败详情');
  return { store, project, orchestrator, actor, failed };
}

test('当前失败仍显示，其他员工接手后撤销告警并保留历史记录', t => {
  const f = fixture(t);
  assert.equal(f.actor().state, 'error');
  f.store.update(f.project.id, { status: 'blocked' });
  assert.equal(f.actor().state, 'blocked');
  const next = f.store.beginRun(f.project.id, 'planner', '负责人继续推进');
  f.store.update(f.project.id, { status: 'running' });
  assert.equal(f.actor().state, 'idle');
  assert.equal(f.actor('planner').state, 'working');
  assert.equal(f.actor().run.id, f.failed);
  assert.equal(f.store.run(f.failed).output, '历史失败详情');
  f.store.finishRun(next, 'failed', '新的失败');
  f.store.update(f.project.id, { status: 'blocked' });
  assert.equal(f.actor().state, 'idle');
  assert.equal(f.actor('planner').state, 'blocked');
});

test('完成目标及切换新目标后不再显示旧目标失败', t => {
  const f = fixture(t);
  f.store.update(f.project.id, { status: 'completed' });
  assert.equal(f.actor().state, 'idle');
  f.store.createGoal(f.project.id, { goal: '新目标', settings: f.project.settings });
  f.store.update(f.project.id, { status: 'running' });
  assert.equal(f.actor().state, 'idle');
  assert.equal(f.actor().run.id, f.failed);
});

test('并行目标的最新失败不会被另一目标的进展覆盖', t => {
  const f = fixture(t);
  const goalId = f.store.enqueueGoal(f.project.id, { goal: '并行目标', settings: f.project.settings });
  f.store.forGoal(f.project.id, goalId).beginRun(f.project.id, 'planner', '另一个目标正在推进');
  f.orchestrator.state = {};
  assert.equal(f.actor().state, 'error');
});

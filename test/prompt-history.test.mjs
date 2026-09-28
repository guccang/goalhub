// 本文件验证提示词不读取或注入历史目标，完整历史记录仍可查看。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';

test('一千轮历史不进入提示词，完整记录仍然保留', () => {
  const store = new Store(':memory:');
  try {
    const project = store.create({ name: '历史容量测试', goal: '新增五子棋小游戏', settings: {} });
    const orchestrator = new Orchestrator({ store, git: { paths() { return { repo: 'test-repo' }; } }, runtime: {} });
    const before = orchestrator.context(project.id);
    const insert = store.db.prepare('INSERT INTO goals(id,project_id,title,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 1000; i++) {
      const id = `history-${i}`, snapshot = { active_goal_id: id, status: 'completed', goal: '仅允许旧页面'.repeat(1000), summary: `成果${i}：` + '已完成验证。'.repeat(1000), merge_commit: 'a'.repeat(40), log: '旧工具日志'.repeat(1000) };
      insert.run(id, project.id, '历史目标', JSON.stringify(snapshot), '2020-01-01', '2020-01-01');
    }
    const originalGoals = store.goals;
    // 阻止提示词代码隐式读取全部历史，确保不依赖旧目标。
    store.goals = () => { throw new Error('提示词不得读取历史目标'); };
    const text = orchestrator.context(project.id);
    assert.equal(text, before);
    assert.doesNotMatch(text, /previousIterations|仅允许旧页面|旧工具日志|成果999/);
    assert.equal(JSON.parse(text).goal, '新增五子棋小游戏');
    assert.equal(originalGoals.call(store, project.id).length, 1001);
  } finally { store.close(); }
});

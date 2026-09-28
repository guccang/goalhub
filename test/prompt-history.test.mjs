// 本文件验证历史迭代数量增加时提示词历史仍保持固定上限，且完整记录不丢失。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { previousIteration } from '../lib/prompt-context.mjs';

test('一千轮历史只注入最近一轮摘要，旧目标和长日志不进入提示词', () => {
  const store = new Store(':memory:');
  try {
    const project = store.create({ name: '历史容量测试', goal: '新增五子棋小游戏', settings: {} });
    assert.deepEqual(store.promptHistory(project.id), []);
    const insert = store.db.prepare('INSERT INTO goals(id,project_id,title,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 1000; i++) {
      const id = `history-${i}`, snapshot = { active_goal_id: id, status: 'completed', goal: '仅允许旧页面'.repeat(1000), summary: `成果${i}：` + '已完成验证。'.repeat(1000), merge_commit: 'a'.repeat(40), log: '旧工具日志'.repeat(1000) };
      insert.run(id, project.id, '历史目标', JSON.stringify(snapshot), '2020-01-01', '2020-01-01');
    }
    const history = store.promptHistory(project.id), text = JSON.stringify(history);
    assert.equal(history.length, 1);
    assert.equal(history[0].id, 'history-999');
    assert.equal(history[0].summary.length, 240);
    assert.ok(text.length < 400);
    assert.doesNotMatch(text, /仅允许旧页面|旧工具日志/);
    assert.equal(store.goals(project.id).length, 1001);
    assert.equal(history[0].mergeCommit, 'a'.repeat(40));
  } finally { store.close(); }
});

test('草稿预览与已保存历史使用同一摘要边界', () => {
  const snapshot = { active_goal_id: 'old', status: 'completed', goal: '不应注入的旧目标', summary: '完成日历。'.repeat(100), merge_commit: 'abc' };
  const result = previousIteration(snapshot);
  assert.equal(result[0].summary.length, 240);
  assert.equal(result[0].mergeCommit, 'abc');
  assert.equal(Object.hasOwn(result[0], 'goal'), false);
  assert.deepEqual(previousIteration(null), []);
});

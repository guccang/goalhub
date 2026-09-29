// 本文件验证错误归档保留执行现场、隔离员工轮次、去重并遮蔽凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { executionError } from '../lib/execution-errors.mjs';

test('员工命令失败保存身份、输入和文档快照；不同轮次分别记录', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '错误分析', goal: '测试', settings: {} });
  const run = store.beginRun(project.id, 'developer', '执行上下文 api_key=sk-secret-value', { id: 'jim', configKey: 'test' });
  const event = { type: 'item.completed', item: { type: 'command_execution', id: 'command-1', command: 'node broken.mjs', exit_code: 1, aggregated_output: '断言失败 password=private-value' } };
  const failure = executionError(event);
  store.recordError(project.id, run, failure);
  store.recordError(project.id, run, failure);
  let errors = store.errors(project.id, { includeContext: true });
  assert.equal(errors.length, 1); assert.equal(errors[0].employee_id, 'jim'); assert.equal(errors[0].exit_code, 1);
  assert.equal(errors[0].task_id, project.active_goal_id);
  assert.match(errors[0].context.run.input, /执行上下文/);
  assert.ok(errors[0].context.documents['requirements.md']);
  assert.doesNotMatch(JSON.stringify(errors), /sk-secret-value|private-value/);
  const second = store.beginRun(project.id, 'developer', '第二轮', { id: 'jim', configKey: 'test' });
  store.recordError(project.id, second, failure);
  assert.equal(store.errors(project.id).length, 2);
  assert.equal(store.errors(project.id)[0].context, undefined);
  assert.equal(store.errors(project.id, { employeeId: 'other' }).length, 0);
});

test('失败退出自动归档，正常完成和主动中断不被误报', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '执行失败', goal: '测试', settings: {} });
  for (const status of ['completed', 'interrupted', 'failed']) {
    const run = store.beginRun(project.id, 'developer', status);
    store.finishRun(run, status, '发生错误');
  }
  assert.equal(store.errors(project.id).length, 1);
  assert.equal(executionError('普通进展中提到 error'), null);
  assert.equal(executionError({ item: { type: 'command_execution', exit_code: 0 } }), null);
  assert.equal(executionError({ type: 'turn.failed', error: { message: '宿主断开' } }).kind, 'host');
});

test('事件诊断、工具失败和验收失败都能记录，损坏文档保留读取错误', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '诊断', goal: '测试', settings: {} });
  const run = store.beginRun(project.id, 'test', 'node verify.mjs', { id: 'quality', configKey: 'x' });
  store.documents.read = () => { throw new Error('文档损坏'); };
  store.event(project.id, 'agent.diagnostic', 'ERROR 连接失败', run);
  store.event(project.id, 'agent.item.completed', JSON.stringify({ item: { type: 'mcp_tool_call', id: 'x', status: 'failed', error: '工具失败' } }), run);
  store.finishRun(run, 'failed', '测试失败');
  const errors = store.errors(project.id, { includeContext: true });
  assert.equal(errors.length, 3);
  assert.equal(errors[0].kind, 'acceptance'); assert.equal(errors[0].context.documentReadError, '文档损坏');
});

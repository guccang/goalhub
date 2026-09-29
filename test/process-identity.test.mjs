// 本文件验证 PID 被系统服务复用时不会误阻断，同时保留真实残留进程保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import { processStartedAt, previousProcessAlive } from '../lib/process-identity.mjs';
import { Store } from '../lib/store.mjs';

// record 构造已经结束的旧员工轮次。
function record() { return { process_id: 123, process_started_at: '', finished_at: '2026-09-29T04:14:25.430Z' }; }

test('旧记录的 PID 已被晚于结束时间启动的进程复用时允许恢复', () => {
  assert.equal(previousProcessAlive(record(), { probe() {}, startedAt: () => '2026-09-29T15:28:10Z' }), false);
});

test('新记录核对创建时间，真实残留进程仍然阻断', () => {
  const run = { ...record(), process_started_at: '2026-09-29T04:13:46Z' };
  assert.equal(previousProcessAlive(run, { probe() {}, startedAt: () => run.process_started_at }), true);
  assert.equal(previousProcessAlive(run, { probe() {}, startedAt: () => '2026-09-29T15:28:10Z' }), false);
});

test('未知身份或无查询权限时保守阻断，明确退出时放行', () => {
  assert.equal(previousProcessAlive(record(), { probe() {}, startedAt: () => '' }), true);
  assert.equal(previousProcessAlive(record(), { probe() { throw Object.assign(new Error(), { code: 'EPERM' }); }, startedAt: () => '' }), true);
  assert.equal(previousProcessAlive(record(), { probe() { throw Object.assign(new Error(), { code: 'ESRCH' }); } }), false);
});

test('真实当前进程身份可保存并在恢复查询中读取', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '恢复', goal: '验证身份', settings: {} });
  const run = store.beginRun(project.id, 'developer', '测试');
  store.process(run, process.pid); store.finishRun(run, 'interrupted', '测试中断');
  const saved = store.interruptedProcesses(project.id)[0];
  if (process.platform === 'win32') {
    assert.ok(saved.process_started_at);
    assert.equal(Date.parse(saved.process_started_at), Date.parse(processStartedAt(process.pid)));
  }
  assert.equal(previousProcessAlive(saved), true);
});

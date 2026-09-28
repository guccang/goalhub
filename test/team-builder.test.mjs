// 本文件验证 God 组队的真实 API、持久化草稿、失败隔离与取消边界；模型返回由可控宿主模拟。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { createApp } from '../lib/app.mjs';
import { TeamBuilder } from '../lib/team-builder.mjs';
import { team } from '../lib/employees.mjs';

// proposal 构造具有项目专属分工的模型输出。
function proposal() { return { summary: '以客户端交付与验证为核心组建团队', employees: [
  { character: 'michael', isLead: true, position: '游戏项目负责人', instructions: '分配客户端开发任务并核对测试证据', profileId: 'god' },
  { character: 'jim', isLead: false, position: 'Unity 客户端工程师', instructions: '实现登录流程并提交自动化验证结果', profileId: 'god' },
] }; }

// fixture 创建独立数据库与可停止宿主，提供 HTTP 请求和显式完成控制。
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'goalhub-team-'));
  const store = new Store(join(directory, 'state.sqlite')), calls = [];
  let resolveDone;
  const runtime = { dataDir: directory,
    // host 捕获真实调用参数，仅在测试明确要求时结束。
    async host(options) { calls.push(options); return { done: new Promise(resolve => { resolveDone = resolve; }), stop() { resolveDone({ code: 1, error: 'stopped' }); } }; },
  };
  const git = { paths() { return {}; } }, orchestrator = new Orchestrator({ store, git, runtime });
  const server = createApp({ store, git, runtime, orchestrator });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const project = store.create({ name: '游戏客户端', goal: '完成 Unity 登录流程', settings: { hostType: 'codex', model: 'saved-model', reasoningEffort: 'high', context: '使用现有 Unity 工程' } });
  t.after(async () => { await orchestrator.close(); await server.hostSetup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, server, project, calls, orchestrator,
    // request 通过真实服务调用项目 API。
    async request(path, value) { const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); return { status: response.status, value: await response.json() }; },
    // finish 等待宿主启动，再返回模拟输出并等待持久化完成。
    async finish(value = proposal()) { for (let i = 0; !resolveDone && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(resolveDone); resolveDone({ code: 0, finalMessage: JSON.stringify(value) }); await server.teamBuilder.jobs.get(project.id)?.promise; },
  };
}

test('God 使用已保存配置生成可编辑草稿，保存前不改变项目团队', async t => {
  const f = await fixture(t), path = `/projects/${f.project.id}`, before = f.store.project(f.project.id).settings;
  assert.equal((await f.request(path + '/team-generation', {})).status, 202);
  await f.finish();
  assert.equal(f.calls[0].model, 'saved-model'); assert.equal(f.calls[0].reasoningEffort, 'high');
  assert.ok(f.calls[0].cwd.includes('team-builder')); assert.equal(f.calls[0].sessionId, '');
  assert.match(f.calls[0].input, /完成 Unity 登录流程/);
  assert.deepEqual(f.store.project(f.project.id).settings, before);
  const draft = (await f.request(path + '/team-generation')).value;
  assert.equal(draft.status, 'ready'); assert.equal(draft.result.employees[1].position, 'Unity 客户端工程师');
  assert.equal(draft.result.employees[0].id, team(f.project)[0].id);
  assert.equal(f.store.run(draft.runId).status, 'completed');
  draft.result.employees[1].position = '客户端主程';
  assert.equal((await f.request(path + '/employees', { employees: draft.result.employees })).status, 200);
  assert.equal(team(f.store.project(f.project.id))[1].position, '客户端主程');
  assert.equal((await f.request(path + '/team-generation')).value.stale, true);
  const other = f.store.create({ name: '其他项目' });
  assert.equal((await f.request(`/projects/${other.id}/team-generation`)).value, null);
});

test('生成期间禁止重复组队和并发修改，取消后保留原团队', async t => {
  const f = await fixture(t), path = `/projects/${f.project.id}`, before = f.store.project(f.project.id).settings;
  await f.request(path + '/team-generation', {});
  for (const action of ['team-generation', 'start', 'goals', 'employees', 'approve']) assert.equal((await f.request(path + '/' + action, {})).status, 400);
  assert.throws(() => f.orchestrator.start(f.project.id), /God/);
  assert.equal((await f.request('/host', { hostType: 'codex' })).status, 400);
  await f.request(path + '/team-generation/cancel', {});
  await f.server.teamBuilder.jobs.get(f.project.id)?.promise;
  assert.equal(f.server.teamBuilder.latest(f.project.id).status, 'cancelled');
  assert.deepEqual(f.store.project(f.project.id).settings, before);
});

test('未知配置、重复人物或缺少 God 的回复不会覆盖原团队', async t => {
  for (const mode of ['profile', 'character', 'lead', 'empty']) await t.test(mode, async t => {
    const f = await fixture(t), value = proposal(), before = f.store.project(f.project.id).settings;
    if (mode === 'profile') value.employees[1].profileId = 'invented';
    if (mode === 'character') value.employees[1].character = 'michael';
    if (mode === 'lead') value.employees[0].isLead = false;
    if (mode === 'empty') value.employees = [];
    f.server.teamBuilder.start(f.project.id); await f.finish(value);
    assert.equal(f.server.teamBuilder.latest(f.project.id).status, 'failed');
    assert.deepEqual(f.store.project(f.project.id).settings, before);
  });
});

test('空团队可使用全局宿主启动 God，完成方案可从数据库恢复', async t => {
  const f = await fixture(t);
  f.store.saveEmployees(f.project.id, []);
  f.store.db.prepare('INSERT INTO host_profile(id,value) VALUES(1,?)').run(JSON.stringify({ hostType: 'codex', model: 'global-model', reasoningEffort: 'medium' }));
  f.server.teamBuilder.start(f.project.id); await f.finish();
  assert.equal(f.calls[0].model, 'global-model');
  const restored = new TeamBuilder({ store: f.store, runtime: {}, orchestrator: f.orchestrator, hostSetup: f.server.hostSetup });
  assert.equal(restored.latest(f.project.id).status, 'ready');
  assert.equal(restored.latest(f.project.id).result.employees[0].model, 'global-model');
});

test('超时停止生成进程并持久化失败原因', async t => {
  const f = await fixture(t); f.server.teamBuilder.timeoutMs = 20;
  f.server.teamBuilder.start(f.project.id);
  await f.server.teamBuilder.jobs.get(f.project.id).promise;
  assert.equal(f.server.teamBuilder.latest(f.project.id).status, 'failed');
  assert.match(f.server.teamBuilder.latest(f.project.id).error, /超时/);
});

test('服务恢复中断记录，目标和执行锁通过后才允许生成', async t => {
  const f = await fixture(t), builder = f.server.teamBuilder;
  assert.throws(() => builder.start(f.project.id, { goal: ' ' }), /项目目标/);
  f.orchestrator.controls.set(f.project.id, {});
  assert.throws(() => builder.start(f.project.id), /暂停项目/);
  f.orchestrator.controls.delete(f.project.id);
  builder.start(f.project.id); await f.finish();
  const draft = builder.latest(f.project.id);
  f.store.db.prepare("UPDATE team_drafts SET status='running' WHERE id=?").run(draft.id);
  const restored = new TeamBuilder({ store: f.store, runtime: {}, orchestrator: f.orchestrator, hostSetup: f.server.hostSetup });
  assert.equal(restored.latest(f.project.id).status, 'interrupted');
  assert.match(restored.latest(f.project.id).error, /服务重启/);
  assert.equal(f.store.run(draft.runId).status, 'interrupted');
});

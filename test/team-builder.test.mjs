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
import { phasePrompt } from '../lib/prompts.mjs';
import { team } from '../lib/employees.mjs';

// proposal 构造具有项目专属分工的模型输出。
function proposal() { return { summary: '以客户端交付与验证为核心组建团队', employees: [
  { character: 'michael', isLead: true, position: '游戏项目负责人', instructions: '分配客户端开发任务并核对测试证据', profileId: 'default' },
  { character: 'jim', isLead: false, position: 'Unity 客户端工程师', instructions: '实现登录流程并提交自动化验证结果', profileId: 'default' },
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

test('独立 God 使用自身配置生成草稿，保存前不改变项目团队', async t => {
  const f = await fixture(t), path = `/projects/${f.project.id}`, before = f.store.project(f.project.id).settings;
  const god = (await f.request('/god')).value;
  await f.request('/god', { ...god, model: 'manager-model', reasoningEffort: 'medium' });
  assert.equal((await f.request(path + '/team-generation', {})).status, 202);
  await f.finish();
  assert.equal(f.calls[0].model, 'manager-model'); assert.equal(f.calls[0].reasoningEffort, 'medium');
  assert.equal(f.calls[0].id, 'goalhub-god'); assert.equal(f.calls[0].scope, 'goalhub');
  assert.ok(f.calls[0].cwd.includes('team-builder')); assert.equal(f.calls[0].sessionId, '');
  assert.match(f.calls[0].input, /完成 Unity 登录流程/);
  assert.deepEqual(f.store.project(f.project.id).settings, before);
  const draft = (await f.request(path + '/team-generation')).value;
  assert.equal(draft.status, 'ready'); assert.equal(draft.result.employees[1].position, 'Unity 客户端工程师');
  assert.equal(draft.result.employees[0].id, team(f.project)[0].id);
  assert.equal(f.store.run(draft.runId).status, 'completed');
  assert.equal(f.store.run(draft.runId).employee_id, 'goalhub-god');
  assert.equal(f.store.employeeRun(f.project.id, team(f.project)[0]), null);
  assert.ok(draft.result.employees.every(employee => employee.id !== 'goalhub-god'));
  assert.equal((await f.request('/god')).value.runs[0].id, draft.runId);
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
  const god = (await f.request('/god')).value;
  assert.equal(god.busy, true);
  assert.equal((await f.request('/god', { ...god, model: 'changed' })).status, 400);
  for (const action of ['team-generation', 'start', 'goals', 'employees', 'approve']) assert.equal((await f.request(path + '/' + action, {})).status, 400);
  assert.throws(() => f.orchestrator.start(f.project.id), /God/);
  assert.equal((await f.request('/host', { hostType: 'codex' })).status, 400);
  await f.request(path + '/team-generation/cancel', {});
  await f.server.teamBuilder.jobs.get(f.project.id)?.promise;
  assert.equal(f.server.teamBuilder.latest(f.project.id).status, 'cancelled');
  assert.deepEqual(f.store.project(f.project.id).settings, before);
});

test('未知配置、重复人物或缺少项目负责人 的回复不会覆盖原团队', async t => {
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

test('God 配置独立持久化，项目负责人和全局默认模型变更不会覆盖它', async t => {
  const f = await fixture(t), manager = f.server.teamBuilder.god;
  const initial = (await f.request('/god')).value;
  assert.equal(initial.id, 'goalhub-god'); assert.equal(initial.name, 'God');
  const changed = { ...initial, hostType: 'claudecode', model: 'god-claude', reasoningEffort: '', instructions: '为项目明确交付边界', timeoutMinutes: 7 };
  assert.equal((await f.request('/god', changed)).status, 200);
  assert.equal((await f.request('/god', { ...changed, reasoningEffort: 'high' })).status, 400);
  assert.equal((await f.request('/god', { ...changed, instructions: ' ' })).status, 400);
  f.store.db.prepare('INSERT INTO host_profile(id,value) VALUES(1,?)').run(JSON.stringify({ hostType: 'codex', model: 'project-default', reasoningEffort: 'high' }));
  const originalTeam = team(f.project);
  originalTeam[0].isLead = false; originalTeam[1].isLead = true;
  f.store.saveEmployees(f.project.id, originalTeam);
  const restored = new TeamBuilder({ store: f.store, runtime: {}, orchestrator: f.orchestrator, hostSetup: f.server.hostSetup });
  assert.deepEqual(restored.god.profile(), manager.profile());
  f.server.teamBuilder.start(f.project.id);
  const value = proposal(); value.employees[0].character = 'pam';
  await f.finish(value);
  assert.equal(f.calls[0].hostType, 'claudecode'); assert.equal(f.calls[0].model, 'god-claude');
  const draft = f.server.teamBuilder.latest(f.project.id);
  assert.equal(draft.status, 'ready'); assert.equal(draft.result.employees[0].character, 'pam');
  assert.equal(draft.result.employees[0].model, 'project-default');
  assert.equal(draft.result.employees[0].isLead, true);
  assert.equal(team(f.store.project(f.project.id))[1].isLead, true);
  assert.equal((await f.request(`/projects/${f.project.id}/employees`, { employees: [{ ...originalTeam[0], id: 'goalhub-god' }] })).status, 400);
});

// 预览与实际调用共用输入，预览本身不能创建执行记录或持久化 God 配置。
test('God 提示词预览使用当前草稿且没有执行副作用', async t => {
  const f = await fixture(t), path = `/projects/${f.project.id}`;
  const before = f.store.project(f.project.id);
  const values = { role: 'team-builder', goal: '预览新目标 <script>alert(1)</script>', context: '当前未保存的背景', language: 'en' };
  const preview = await f.request(path + '/prompt-preview', values);
  assert.equal(preview.status, 200);
  assert.match(preview.value.entries[0].input, /当前未保存的背景/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.server.teamBuilder.latest(f.project.id), null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM god_config').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  assert.deepEqual(f.store.project(f.project.id), before);
  await f.request(path + '/team-generation', values); await f.finish();
  assert.equal(f.calls[0].input, preview.value.entries[0].input);
});

// 逐阶段核对真实调用的身份、语言和协议，并确认预览不会调度执行。
test('所有项目阶段提供预览且与调用使用同一输入', async t => {
  const f = await fixture(t), id = f.project.id, path = `/projects/${id}/prompt-preview`;
  const all = await f.request(path, {});
  assert.equal(all.status, 200); assert.equal(all.value.entries.length, 5);
  assert.ok(all.value.entries.every(entry => entry.input && !entry.error));
  assert.equal(f.calls.length, 0);
  f.orchestrator.runtime.host = async options => { f.calls.push(options); return { done: Promise.resolve({ code: 0, finalMessage: '{}' }), stop() {} }; };
  for (const role of ['planner', 'coordinator', 'developer', 'evaluator', 'final-review']) {
    const preview = (await f.request(path, { role })).value.entries[0];
    const task = { title: '待规划或分配的任务', description: '实际调用时替换为已分配任务', assignee: '' };
    const input = phasePrompt(role, { context: f.orchestrator.context(id), task });
    const control = { id, busyEmployees: new Set(), handles: new Set(), interrupted: new Set() };
    await f.orchestrator.agent(control, role, '.', input, false, preview.executor.id);
    assert.equal(f.calls.at(-1).input, preview.input, role);
  }
  const edited = team(f.store.project(id)); edited[1].instructions = '未保存的工作说明';
  const draft = await f.request(path, { role: 'developer', employees: edited, employeeId: edited[1].id, language: 'en', context: '新背景' });
  assert.match(draft.value.entries[0].input, /未保存的工作说明/);
  assert.equal(draft.value.entries[0].executor.effectiveLanguage, 'en');
  assert.notEqual(team(f.store.project(id))[1].instructions, edited[1].instructions);
  assert.equal((await f.request(path, { role: 'unknown' })).status, 400);
  assert.equal((await f.request(path, { goal: 42 })).status, 400);
  assert.equal((await f.request(path, { answers: [{}] })).status, 400);
});

// 连通性预览仅生成带占位符的输入，保存配置和真实测试留给原操作。
test('宿主连通性预览复用测试协议且不产生探测记录', async t => {
  const f = await fixture(t);
  const preview = await f.request('/host/prompt-preview', { reasoningEffort: 'high' });
  assert.equal(preview.status, 200);
  assert.equal(preview.value.entries[0].input, f.server.hostSetup.prompt({ reasoningEffort: 'high' }));
  assert.match(preview.value.entries[0].input, /运行时生成的校验码/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_tests').get().n, 0);
  assert.equal((await f.request('/host/prompt-preview', { reasoningEffort: 'invalid' })).status, 400);
});
// 操作确认展示对应阶段和实际输入草稿，预览不得修改项目或启动模型。
test('调用确认按操作选择阶段，交付预览不保存配置或创建修复任务', async t => {
  const f = await fixture(t), id = f.project.id, path = `/projects/${id}/prompt-preview`;
  const planning = await f.request(path, { action: 'start' });
  assert.equal(planning.value.entries.length, 1); assert.match(planning.value.entries[0].input, /你是规划 Agent/);
  const evaluating = await f.request(path, { action: 'evaluate' });
  assert.match(evaluating.value.entries[0].input, /定时进度/);
  const config = { kind: 'source', instructions: '保存的说明' }; f.store.saveDelivery(id, config);
  const delivery = await f.request(path, { action: 'delivery/build' });
  assert.equal(delivery.value.entries.length, 1); assert.match(delivery.value.entries[0].input, /准备可使用的项目预览与交付/);
  assert.match(delivery.value.entries[0].input, /此前人工交付设置/);
  assert.deepEqual(f.store.project(id).settings.delivery, config); assert.equal(f.store.tasks(id).length, 0);
  assert.equal(f.store.instructions(id).length, 0); assert.equal(f.calls.length, 0);
  const newGoal = await f.request(path, { action: 'goals', role: 'planner', goal: '新的日历目标' });
  assert.match(newGoal.value.entries[0].input, /新的日历目标/);
  assert.equal(f.store.project(id).goal, f.project.goal);
});

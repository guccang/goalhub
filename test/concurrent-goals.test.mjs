// 本文件使用真实 SQLite 和 Git 验证多目标并发、员工互斥、队列接续与隔离合并。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { Store } from '../lib/store.mjs';
import { ProjectGit } from '../lib/git.mjs';
import { GoalScheduler, KeyLock } from '../lib/goal-scheduler.mjs';
import { createApp } from '../lib/app.mjs';
import { team } from '../lib/employees.mjs';
import { OfficeView } from '../public/office-view.js';

// 验证员工面板在等待确认时提供真正可点击的入口。
test('员工面板的确认和回答入口可用，离线时禁止操作', () => {
  const nodes = new Map();
  const view = { project: { status: 'awaiting_approval', active_goal_id: 'goal' }, online: true, snapshot: { actors: [] },
    // find 用最小节点替身检查实际渲染方法的输出。
    find(selector) { if (!nodes.has(selector)) nodes.set(selector, { dataset: {} }); return nodes.get(selector); } };
  OfficeView.prototype.renderControls.call(view);
  const control = view.find('#office-run-control');
  assert.equal(control.disabled, false); assert.equal(control.dataset.officeControl, 'attention'); assert.equal(control.textContent, '查看并确认计划');
  view.project.status = 'waiting_input'; OfficeView.prototype.renderControls.call(view);
  assert.equal(control.disabled, false); assert.equal(control.textContent, '回答问题');
  view.online = false; OfficeView.prototype.renderControls.call(view); assert.equal(control.disabled, true);
});

// waitUntil 等待真实异步流程，超时显示各目标状态。
async function waitUntil(predicate, diagnostics = () => '', timeout = 30000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待超时：' + diagnostics()); await new Promise(resolve => setTimeout(resolve, 20)); }
}

// fixture 构造两个员工和可控模型，所有文件断言与合并使用真实磁盘。
function fixture(t, pipeline = false) {
  const directory = mkdtempSync(join(tmpdir(), 'goalhub-concurrent-')), store = new Store(join(directory, 'state.sqlite'));
  const git = new ProjectGit(directory, store), held = new Map(), active = new Set(), calls = [], folders = new Set(); let max = 0;
  const runtime = { dataDir: directory,
    // host 模拟员工输出并统计重入，开发调用由测试释放。
    async host(options) {
      const role = options.input.includes('你是规划 Agent') ? 'planner' : options.input.includes('你是执行 Agent') ? 'developer' : options.input.includes('你是任务分配负责人') ? 'coordinator' : 'review';
      const goal = JSON.parse(options.input.split('\n')[0].split('：').slice(1).join('：'));
      const employee = options.input.match(/编号 ([^)）]+)/)[1];
      assert.ok(!active.has(employee), `员工重入：${employee}`); active.add(employee); max = Math.max(max, active.size); calls.push({ goal, role, employee, cwd: options.cwd });
      let finish;
      const done = new Promise(resolve => { finish = result => { active.delete(employee); resolve(result); }; });
      // reply 输出结构化结果，并实际生成当前目标对应的文件。
      const reply = () => {
        let value;
        if (role === 'planner') value = { needsInput: false, summary: goal, tasks: [{ id: 'one', title: goal, description: `生成 ${goal}.txt`, assignee: goal === 'B' && !pipeline ? 'planner' : 'developer', checkIds: ['file'] }], checks: [{ id: 'file', title: goal, command: goal, expectation: '文件内容等于目标名称' }] };
        else if (role === 'developer') {
          folders.add(options.cwd); writeFileSync(join(options.cwd, `${goal}.txt`), goal);
          writeFileSync(join(options.cwd, 'goalhub.delivery.json'), JSON.stringify({ kind: 'source', instructions: '纯文本文件，无运行界面；读取文件内容验证。' }));
          value = { status: 'done', summary: `完成 ${goal}` };
        } else if (role === 'coordinator') value = { needsInput: false, assignee: 'developer', summary: '修复' };
        else value = { action: 'complete', summary: `验收 ${goal}` };
        if (pipeline && role === 'planner' && goal === 'A') value.tasks.push({ id: 'qa', title: '验证 A', description: '测试 A', assignee: 'planner', requiredCapability: 'testing', dependsOn: ['one'], checkIds: ['file'] });
        finish({ code: 0, finalMessage: JSON.stringify(value) });
      };
      if (role === 'developer') held.set(goal, reply); else setTimeout(reply, 1);
      return { done, stop() { held.delete(goal); finish({ code: 1, error: '已停止' }); } };
    },
    // command 直接断言隔离目录中的真实产物。
    async command(command, cwd) {
      const passed = existsSync(join(cwd, `${command}.txt`)) && readFileSync(join(cwd, `${command}.txt`), 'utf8') === command;
      return { done: Promise.resolve({ code: passed ? 0 : 1 }), stop() {} };
    },
  };
  const scheduler = new GoalScheduler({ store, git, runtime, retryDelayMs: 1 });
  const project = store.create({ name: '并发项目', settings: { confirmationMode: 'auto', evaluationMinutes: 60, testTimeoutSeconds: 5 } });
  store.saveEmployees(project.id, team(project).slice(0, 2).map(employee => ({ ...employee, capabilities: pipeline ? (employee.isLead ? ['coordination', 'review', 'testing'] : ['development']) : [...employee.capabilities, 'development'] })));
  t.after(async () => { await scheduler.close(); store.close(); const suffix = relative(tmpdir(), directory); assert.ok(suffix.startsWith('goalhub-concurrent-') && !suffix.includes('..') && !isAbsolute(suffix)); rmSync(directory, { recursive: true, force: true }); });
  return { store, git, runtime, scheduler, held, calls, folders, active, directory, id: project.id, max: () => max, diagnostics: () => JSON.stringify(store.goals(project.id).map(goal => [goal.goal, goal.status, goal.summary])) };
}

test('两个员工并发开发独立 worktree，第三目标等待并自动接续，主分支保留全部成果', async t => {
  const f = fixture(t), ids = ['A', 'B', 'C'].map(goal => f.store.enqueueGoal(f.id, { goal }));
  f.scheduler.pump(f.id);
  await waitUntil(() => f.held.has('A') && f.held.has('B'), f.diagnostics);
  assert.equal(f.max(), 2); assert.equal(f.scheduler.state(f.id).running, 2);
  assert.deepEqual(f.scheduler.state(f.id).waiting.map(goal => goal.id), [ids[2]]);
  assert.notEqual(f.calls.find(call => call.goal === 'A').cwd, f.calls.find(call => call.goal === 'B').cwd);
  f.held.get('A')(); f.held.delete('A'); f.held.get('B')(); f.held.delete('B');
  await waitUntil(() => f.held.has('C'), f.diagnostics); f.held.get('C')(); f.held.delete('C');
  await waitUntil(() => f.store.goals(f.id).every(goal => goal.status === 'completed'), f.diagnostics);
  await waitUntil(() => !f.scheduler.controls.has(f.id));
  for (const goal of ['A', 'B', 'C']) assert.equal(readFileSync(join(f.git.paths(f.id).repo, `${goal}.txt`), 'utf8'), goal);
  for (const path of f.folders) assert.equal(existsSync(path), false);
  for (const id of ids) {
    assert.equal(f.store.tasks(f.id, id).length, 1); assert.equal(f.store.checks(f.id, id).length, 1);
    assert.equal(f.scheduler.delivery.snapshot(f.id, id).release.status, 'ready');
    const runs = f.store.db.prepare('SELECT input FROM runs WHERE goal_id=? AND role=?').all(id, 'developer');
    assert.equal(runs.length, 1);
  }
});

test('排队取消和重启恢复不丢目标、不自动重跑未知开发进程', async t => {
  const f = fixture(t), a = f.store.enqueueGoal(f.id, { goal: 'A' }), b = f.store.enqueueGoal(f.id, { goal: 'B' }), c = f.store.enqueueGoal(f.id, { goal: 'C' });
  f.scheduler.pump(f.id); await waitUntil(() => f.held.has('A') && f.held.has('B'), f.diagnostics);
  await f.scheduler.pause(f.id, c); assert.equal(f.store.forGoal(f.id, c).project(f.id).status, 'paused');
  await f.scheduler.close();
  const reopened = new Store(join(f.directory, 'state.sqlite'));
  try { reopened.recover(); for (const id of [a,b,c]) assert.equal(reopened.forGoal(f.id,id).project(f.id).status,'paused'); assert.equal(reopened.goals(f.id).length,3); }
  finally { reopened.close(); }
});

test('员工锁取消等待后能继续，释放函数重复调用不释放别人的锁', async () => {
  const pool = new KeyLock(), release = await pool.acquire('jim'), abort = new AbortController();
  const cancelled = pool.acquire('jim', abort.signal); abort.abort(); await assert.rejects(cancelled, /暂停/);
  let entered = false; const next = pool.acquire('jim').then(unlock => { entered = true; return unlock; });
  assert.equal(entered, false); release(); const unlock = await next; release(); assert.equal(pool.busy('jim'), true); unlock(); assert.equal(pool.busy('jim'), false);
});

// 真正经过 HTTP 路由验证新增、预览和单目标暂停，不绕过前端依赖的服务接口。
test('运行中可通过 API 新增目标，选择目标后预览和暂停不会影响另一目标', async t => {
  const f = fixture(t), server = createApp({ store: f.store, git: f.git, runtime: f.runtime, orchestrator: f.scheduler });
  server.hostSetup.verified = () => ({ hostType: 'codex', model: '', reasoningEffort: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.hostSetup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${f.id}`;
  // request 提交真实 JSON 请求并校验状态码。
  const request = async (path, value) => { const response = await fetch(base + path, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
  const a = await request('/goals', { goal: 'A', settings: { confirmationMode: 'auto' } });
  await waitUntil(() => f.held.has('A'), f.diagnostics);
  const b = await request('/goals', { goal: 'B', settings: { confirmationMode: 'auto' } });
  await waitUntil(() => f.held.has('B'), f.diagnostics);
  const c = await request('/goals', { goal: 'C', settings: { confirmationMode: 'auto' } });
  assert.equal(c.status, 'queued'); assert.equal(c.queue.waiting.length, 1);
  const detail = await request(`/goals/${b.active_goal_id}`); assert.equal(detail.historical, false); assert.equal(detail.goal, 'B'); assert.equal(detail.active, true);
  const preview = await request('/prompt-preview', { role: 'planner', goalId: b.active_goal_id });
  assert.ok(preview.entries[0].input.startsWith('当前目标（本轮唯一产品目标）："B"'));
  await request('/pause', { goalId: c.active_goal_id });
  await request('/pause', { goalId: a.active_goal_id });
  assert.equal(f.store.forGoal(f.id, a.active_goal_id).project(f.id).status, 'paused');
  assert.equal(f.scheduler.isGoalActive(f.id, b.active_goal_id), true);
  await request('/pause', { goalId: b.active_goal_id });
});

// 冲突时验证主分支不变、现场不清理，解决后可完成真正的合并提交。
test('API 默认自动执行，显式人工确认保留；切换自动复用三份计划并按容量排队', async t => {
  const f = fixture(t), server = createApp({ store: f.store, git: f.git, runtime: f.runtime, orchestrator: f.scheduler });
  server.hostSetup.verified = () => ({ hostType: 'codex', model: '', reasoningEffort: '' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.hostSetup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/projects/${f.id}`;
  // post 通过真实接口验证默认配置与已有目标迁移。
  const post = async (path, value) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
  const auto = await post('/goals', { goal: 'D', autoStart: false });
  assert.equal(auto.settings.confirmationMode, 'auto');
  const ids = [];
  for (const goal of ['A', 'B', 'C']) {
    const created = await post('/goals', { goal, settings: { confirmationMode: 'manual' } }); ids.push(created.active_goal_id);
    await waitUntil(() => f.store.forGoal(f.id, created.active_goal_id).project(f.id).status === 'awaiting_approval', f.diagnostics);
  }
  await waitUntil(() => !f.scheduler.controls.has(f.id));
  assert.equal(f.held.size, 0); assert.equal(f.scheduler.state(f.id).awaitingApproval.length, 3);
  const tasks = ids.map(id => f.store.tasks(f.id, id).map(task => task.id));
  await post('/confirmation-mode', { mode: 'auto' });
  await waitUntil(() => f.held.has('A') && f.held.has('B'), f.diagnostics);
  assert.equal(f.scheduler.state(f.id).running, 2); assert.deepEqual(f.scheduler.state(f.id).waiting.map(goal => goal.id), [ids[2]]);
  assert.equal(f.scheduler.state(f.id).awaitingApproval.length, 0);
  assert.equal(f.calls.filter(call => call.role === 'planner').length, 3);
  assert.deepEqual(ids.map(id => f.store.tasks(f.id, id).map(task => task.id)), tasks);
  for (const id of ids) { const goal = f.store.forGoal(f.id, id).project(f.id); assert.equal(goal.settings.confirmationMode, 'auto'); assert.equal(goal.plan_approved, 1); }
});

// 冲突时验证主分支不变、现场不清理，解决后可完成真正的合并提交。
test('并发修改同一文件时保留冲突现场，修复后合并双方内容', async t => {
  const f = fixture(t), a = f.store.enqueueGoal(f.id, { goal: 'A' }, false), b = f.store.enqueueGoal(f.id, { goal: 'B' }, false);
  const first = f.scheduler.engine(f.id, a), second = f.scheduler.engine(f.id, b);
  const p1 = await first.git.ensure(first.store.project(f.id)), p2 = await second.git.ensure(second.store.project(f.id));
  writeFileSync(join(p1.work, 'shared.txt'), '甲功能\n'); writeFileSync(join(p2.work, 'shared.txt'), '乙功能\n');
  await first.git.checkpoint(f.id, '实现甲'); await second.git.checkpoint(f.id, '实现乙');
  await first.git.complete(f.id);
  await assert.rejects(second.git.integrate(f.id), /Git 操作失败/);
  assert.equal(readFileSync(join(p1.repo, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n'), '甲功能\n');
  assert.ok(existsSync(p2.work)); assert.match(readFileSync(join(p2.work, 'shared.txt'), 'utf8'), /<<<<<<<|>>>>>>>/);
  await assert.rejects(second.git.checkpoint(f.id, '不能提交冲突标记'));
  writeFileSync(join(p2.work, 'shared.txt'), '甲功能\n乙功能\n');
  await second.git.checkpoint(f.id, '修复并保留双方功能'); await second.git.integrate(f.id); await second.git.complete(f.id);
  assert.equal(readFileSync(join(p1.repo, 'shared.txt'), 'utf8').replaceAll('\r\n', '\n'), '甲功能\n乙功能\n');
  assert.equal(existsSync(p2.work), false);
});

// 员工数量从真实启用配置计算，停用员工不占槽位；队列在重启后保留并恢复。
test('一名启用员工限制为单并发，重启后只自动恢复等待目标', async t => {
  const f = fixture(t), members = team(f.store.project(f.id)); members[1].enabled = false; f.store.saveEmployees(f.id, members);
  const first = f.store.enqueueGoal(f.id, { goal: 'B' }), second = f.store.enqueueGoal(f.id, { goal: 'B' });
  f.scheduler.pump(f.id); await waitUntil(() => f.held.has('B'), f.diagnostics);
  assert.equal(f.scheduler.state(f.id).capacity, 1); assert.equal(f.scheduler.state(f.id).running, 1);
  assert.deepEqual(f.scheduler.state(f.id).waiting.map(goal => goal.id), [second]);
  await f.scheduler.close(); f.store.recover();
  assert.equal(f.store.forGoal(f.id, first).project(f.id).status, 'paused');
  assert.equal(f.store.forGoal(f.id, second).project(f.id).status, 'queued');
  const recovered = new GoalScheduler({ store: f.store, git: f.git, runtime: f.runtime, retryDelayMs: 1 });
  try { recovered.recoverQueues(); await waitUntil(() => f.held.has('B'), f.diagnostics); assert.equal(recovered.isGoalActive(f.id, second), true); assert.equal(recovered.isGoalActive(f.id, first), false); }
  finally { await recovered.close(); }
});

// 各类运行证据都显式绑定目标，避免数据库默认触发器错误使用页面当前目标。
test('并发目标的问答、指令、事件和运行记录互不串线', t => {
  const f = fixture(t), a = f.store.enqueueGoal(f.id, { goal: 'A' }, false), b = f.store.enqueueGoal(f.id, { goal: 'B' }, false);
  const scoped = f.store.forGoal(f.id, b);
  scoped.ask(f.id, ['乙问题']); scoped.instruction(f.id, '乙指令'); scoped.commit(f.id, 'hash', '乙提交');
  const run = scoped.beginRun(f.id, 'test', '乙命令'); scoped.finishRun(run, 'completed', '通过');
  assert.equal(f.store.run(run).goal_id, b); assert.equal(f.store.questions(f.id, a).length, 0); assert.equal(scoped.questions(f.id)[0].prompt, '乙问题');
  assert.equal(f.store.instructions(f.id).length, 0); assert.equal(scoped.instructions(f.id)[0].content, '乙指令');
  scoped.update(f.id, { summary: '乙状态' }); assert.notEqual(f.store.project(f.id).summary, '乙状态');
  assert.equal(f.store.db.prepare('SELECT goal_id FROM commits WHERE title=?').get('乙提交').goal_id, b);
});

// 真实流程验证开发后才能测试，且测试和下一目标开发可由不同员工同时执行。
test('开发完成才进入测试，测试 A 与开发 B 并行且等待员工可见', async t => {
  const f = fixture(t, true);
  f.store.enqueueGoal(f.id, { goal: 'A' }); f.store.enqueueGoal(f.id, { goal: 'B' }); f.scheduler.pump(f.id);
  await waitUntil(() => f.held.has('A') && f.scheduler.state(f.id).assignments.some(item => item.waiting), f.diagnostics);
  assert.equal(f.calls.filter(call => call.role === 'developer').length, 1);
  assert.equal(f.calls.find(call => call.role === 'developer').employee, 'developer');
  const finishA = f.held.get('A'); f.held.delete('A'); finishA();
  await waitUntil(() => f.held.has('A') && f.held.has('B'), f.diagnostics);
  assert.equal(f.calls.filter(call => call.goal === 'A' && call.role === 'developer').at(-1).employee, 'planner');
  assert.ok(f.scheduler.state(f.id).assignments.some(item => item.label.includes('正在测试')));
  assert.ok(f.scheduler.state(f.id).assignments.some(item => item.label.includes('正在开发')));
});

// 同能力空闲员工可以接手，避免所有任务都排在同一个忙碌员工之后。
test('开发员工忙时优先调度明确具备开发能力的空闲员工', async t => {
  const f = fixture(t);
  f.store.enqueueGoal(f.id, { goal: 'A' }); f.scheduler.pump(f.id);
  await waitUntil(() => f.held.has('A'), f.diagnostics);
  f.store.enqueueGoal(f.id, { goal: 'C' }); f.scheduler.pump(f.id);
  await waitUntil(() => f.held.has('C'), f.diagnostics);
  assert.equal(f.calls.find(call => call.goal === 'C' && call.role === 'developer').employee, 'planner');
  assert.equal(f.max(), 2);
});

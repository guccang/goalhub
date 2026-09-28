// 本文件通过真实 SQLite/Git 和可控模拟宿主验证持续执行、失败修复、暂停、问答与 HTTP 边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { Store, redact } from '../lib/store.mjs';
import { ProjectGit } from '../lib/git.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { createApp } from '../lib/app.mjs';
import { validatePlan } from '../lib/protocol.mjs';
import { Runtime } from '../lib/runtime.mjs';
import { buildOfficeSnapshot } from '../lib/office.mjs';
import { sceneFrameBufs, SCENE_W, SCENE_H } from '../public/vendor/munder-difflin/portrait-art.js';

const plan = { needsInput: false, summary: '实现可验证的本地文件功能', tasks: [{ title: '实现功能', description: '生成 answer.txt，内容应为 42。', checkIds: ['file'] }], checks: [{ id: 'file', title: '验证结果文件', command: 'verify-answer', expectation: 'answer.txt 内容为 42' }] };

// waitUntil 有界等待异步状态，失败时输出实际状态以便诊断。
async function waitUntil(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// fixture 为测试创建隔离数据目录，并用真实 Git 管理模拟 Agent 的修改。
function fixture(t, behavior = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'goalhub-test-'));
  const store = new Store(join(directory, 'state.sqlite')), git = new ProjectGit(directory, store);
  const counts = { developer: 0, planner: 0, evaluator: 0, final: 0, test: 0 }, calls = [], stopped = [];
  const runtime = {
    // status 返回本地模拟模块状态。
    status() { return { available: true, message: '测试宿主' }; },
    // host 模拟可停止的公共 Agent 句柄，并写入真实源码文件。
    async host(options) {
      const role = options.input.includes('你是规划 Agent') ? 'planner' : options.input.includes('你是执行 Agent') ? 'developer' : options.input.includes('最终验收评估') ? 'final' : 'evaluator';
      const count = ++counts[role]; calls.push({ ...options, role });
      options.onSession?.(`${role}-session`); options.onEvent?.('output', `${role} 原始流事件`);
      let resolveDone, finished = false;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const handle = {
        done,
        // stop 模拟进程退出并记录停止动作。
        stop() { if (!finished) { finished = true; stopped.push(role); resolveDone({ code: 1, error: 'stopped', finalMessage: '' }); } },
      };
      // finish 模拟一次真实开发产出或结构化评估回复。
      async function finish() {
        try {
          const custom = behavior[role] ? await behavior[role]({ options, count, counts, directory }) : undefined;
          if (custom === 'hold' || finished) return;
          let reply = custom;
          if (reply === undefined && role === 'planner') reply = plan;
          if (reply === undefined && role === 'developer') { writeFileSync(join(options.cwd, 'answer.txt'), '42'); reply = { status: 'done', summary: '已生成结果文件并完成开发' }; }
          if (reply === undefined) reply = { action: role === 'final' ? 'complete' : 'continue', summary: '目标与测试证据一致' };
          finished = true;
          resolveDone({ code: 0, error: '', finalMessage: typeof reply === 'string' ? reply : JSON.stringify(reply) });
        } catch (error) { finished = true; resolveDone({ code: 1, error: error.message, finalMessage: '' }); }
      }
      setTimeout(finish, 2);
      return handle;
    },
    // command 验证实际文件内容，避免仅靠模拟 Agent 的完成声明通过测试。
    async command(command, cwd, onLine) {
      counts.test++;
      assert.equal(command, 'verify-answer');
      const passed = existsSync(join(cwd, 'answer.txt')) && readFileSync(join(cwd, 'answer.txt'), 'utf8') === '42';
      onLine('stdout', passed ? '断言通过：answer=42' : '断言失败：answer!=42');
      return { done: Promise.resolve({ code: passed ? 0 : 1, error: '' }), stop() {} };
    },
  };
  const orchestrator = new Orchestrator({ store, git, runtime, retryDelayMs: 1 });
  const project = store.create({ name: '测试目标', goal: '生成值为 42 的文件，使用真实断言确认。', settings: { hostType: 'codex', model: '', evaluationMinutes: 10, agentTimeoutMinutes: 1, testTimeoutSeconds: 5 } });
  // cleanup 先释放运行中的业务，再验证绝对路径位于测试临时目录后删除。
  t.after(async () => {
    await orchestrator.close(); store.close();
    const suffix = relative(tmpdir(), directory);
    assert.ok(suffix.startsWith('goalhub-test-') && !suffix.includes('..') && !isAbsolute(suffix));
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, git, runtime, orchestrator, project, directory, counts, calls, stopped };
}

// 完成必须依赖真实断言、最终评估和合并成功，同时保留全部运行记录。
test('目标完成后通过全部测试、合并 main 并移除开发 worktree', async (t) => {
  const f = fixture(t); f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '项目未结束');
  const result = f.store.detail(f.project.id);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(result.tasks[0].status, 'done'); assert.equal(result.checks[0].status, 'passed');
  assert.equal(f.counts.test, 2); assert.equal(f.counts.final, 1);
  const paths = f.git.paths(f.project.id);
  assert.equal(readFileSync(join(paths.repo, 'answer.txt'), 'utf8'), '42');
  assert.equal(existsSync(paths.work), false);
  assert.ok(result.commits.length >= 2);
  for (const run of result.runs) { const full = f.store.run(run.id); assert.ok(full.input); assert.ok(full.output); }
  assert.ok(f.store.events(f.project.id, { search: '原始流事件' }).length >= 3);
});

// 测试失败应自动把任务送回开发，而不是接受 Agent 的 done 声明。
test('任务验收失败自动修复，第二轮复用开发会话', async (t) => {
  const f = fixture(t, { developer: ({ options, count }) => {
    writeFileSync(join(options.cwd, 'answer.txt'), count === 1 ? 'wrong' : '42');
    return { status: 'done', summary: '完成当前开发轮次' };
  } });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '自动修复未结束');
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.counts.developer, 2); assert.equal(f.counts.test, 3);
  const calls = f.calls.filter((call) => call.role === 'developer');
  assert.equal(calls[1].sessionId, 'developer-session');
  assert.ok(calls[1].input.includes('断言失败'));
});

// 规划阶段缺少信息时，原目标及用户回答应进入后续规划输入。
test('必要问答暂停规划，回答后保留目标并继续执行', async (t) => {
  const f = fixture(t, { planner: ({ count }) => count === 1 ? { needsInput: true, summary: '需要确认输出值', questions: ['输出值是否为 42？'] } : plan });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '未等待用户输入');
  assert.equal(f.store.project(f.project.id).status, 'waiting_input');
  assert.throws(() => f.orchestrator.start(f.project.id), /回答/);
  const question = f.store.questions(f.project.id)[0];
  f.store.answer(f.project.id, question.id, '是，请使用 42');
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '回答后未继续');
  assert.equal(f.store.project(f.project.id).status, 'completed');
  const prompt = f.calls.filter((call) => call.role === 'planner')[1].input;
  assert.ok(prompt.includes(f.project.goal)); assert.ok(prompt.includes('是，请使用 42'));
});

// 暂停必须停止活动句柄，禁止旧轮次结果覆盖恢复后的状态。
test('暂停终止开发并保留源码，继续后可完成', async (t) => {
  const f = fixture(t, { developer: ({ count }) => count === 1 ? 'hold' : undefined });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => f.counts.developer === 1, '开发未启动');
  assert.throws(() => f.orchestrator.start(f.project.id), /仍在运行/);
  await f.orchestrator.pause(f.project.id);
  assert.equal(f.store.project(f.project.id).status, 'paused'); assert.ok(f.stopped.includes('developer'));
  assert.ok(existsSync(f.git.paths(f.project.id).work));
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '恢复未结束');
  assert.equal(f.store.project(f.project.id).status, 'completed');
});

// 定时评估在独立目录检查，并在修复前等待原开发句柄退出。
test('周期评估可中断阻塞开发并协调修复，检查目录独立', async (t) => {
  const f = fixture(t, { developer: ({ count }) => count === 1 ? 'hold' : undefined,
    evaluator: ({ count }) => count === 1 ? { action: 'repair', summary: '开发进程无进展，需要恢复', repair: '重新生成 answer.txt 并验证 42' } : undefined });
  f.store.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(JSON.stringify({ ...f.project.settings, evaluationMinutes: 0.005 }), f.project.id);
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '评估修复未结束', 20000);
  const result = f.store.project(f.project.id);
  assert.equal(result.status, 'completed', result.summary); assert.ok(f.counts.evaluator >= 1);
  assert.ok(f.stopped.includes('developer'));
  const review = f.calls.find((call) => call.role === 'evaluator');
  assert.notEqual(review.cwd, f.git.paths(f.project.id).work); assert.equal(existsSync(review.cwd), false);
  assert.ok(f.calls.filter((call) => call.role === 'developer')[1].input.includes('重新生成 answer.txt'));
});

// 无法解析宿主回复时明确阻断，避免把普通文字视为成功。
test('连续三轮协议错误进入阻断，并保留错误和输入输出', async (t) => {
  const f = fixture(t, { planner: () => 'I am done' }); f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '错误重试未结束');
  assert.equal(f.store.project(f.project.id).status, 'blocked'); assert.equal(f.counts.planner, 3);
  assert.equal(f.store.detail(f.project.id).runs.length, 3);
  assert.equal(f.store.events(f.project.id, { kind: 'execution.retry' }).length, 3);
});

// 最终评估拒绝完成时需要继续修复，而不能仅凭测试通过结束。
test('最终评估发现遗漏时增加修复任务并重新验收', async (t) => {
  const f = fixture(t, { final: ({ count }) => count === 1 ? { action: 'repair', summary: '补充完成说明', repair: '检查结果文件并完善实现' } : undefined });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '最终评估修复未结束');
  assert.equal(f.store.project(f.project.id).status, 'completed'); assert.equal(f.counts.developer, 2);
  assert.equal(f.store.tasks(f.project.id).length, 2); assert.equal(f.counts.final, 2);
});

// HTTP 层拒绝跨源写入、错误参数和任意文件读取，并支持记录过滤。
test('HTTP 接口可创建查询项目并拒绝跨源和无效输入', async (t) => {
  const f = fixture(t), server = createApp(f);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HTTP 项目', goal: '测试保存目标', autoStart: false }) });
  assert.equal(created.status, 201);
  const value = await created.json(); assert.equal(value.status, 'paused');
  const forbidden = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', goal: 'x', settings: { evaluationMinutes: -1 } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  const records = await (await fetch(`${base}/api/projects/${value.id}/events?search=保存`)).json();
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'goal.created');
  assert.equal((await fetch(base)).status, 200);
});

// 重启恢复保留任务与事件，显式中断未知运行状态。
test('数据库重启恢复状态且校验计划关联和敏感日志', (t) => {
  const f = fixture(t); f.store.update(f.project.id, { status: 'running' });
  f.store.plan(f.project.id, plan);
  const task = f.store.tasks(f.project.id)[0]; f.store.task(task.id, 'running');
  const run = f.store.beginRun(f.project.id, 'developer', '保持输入记录');
  f.store.recover();
  assert.equal(f.store.project(f.project.id).status, 'paused');
  assert.equal(f.store.tasks(f.project.id)[0].status, 'pending'); assert.equal(f.store.run(run).status, 'interrupted');
  f.store.process(run, process.pid);
  assert.throws(() => f.orchestrator.start(f.project.id), /进程.*仍存在/);
  assert.equal(redact('api_key=secret-value'), 'api_key=[已隐藏]');
  assert.throws(() => validatePlan(JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], checkIds: ['missing'] }] })), /引用已有/);
});

// Codex 接入必须先清理父进程认证覆盖，再创建宿主环境，避免错误 Key 覆盖本机登录。
test('公共运行模块按正确顺序构造 Codex 认证环境', async () => {
  const runtime = new Runtime(tmpdir());
  const steps = [];
  runtime.loaded = Promise.resolve({
    // codexAuthEnvironment 模拟公共模块清理认证覆盖。
    codexAuthEnvironment() { steps.push('auth'); return { NORMALIZED: 'yes' }; },
    // hostEnvironment 检查传入的认证环境是否经过标准化。
    hostEnvironment(directory, host, parent) { assert.equal(parent.NORMALIZED, 'yes'); steps.push('environment'); return parent; },
    // runHost 检查最终转交给宿主的环境与网络停止策略。
    runHost(options) { assert.equal(options.env.NORMALIZED, 'yes'); assert.equal(options.stopOnNetworkError, true); steps.push('run'); return { done: Promise.resolve({ code: 0 }), stop() {} }; },
  });
  await runtime.host({ hostType: 'codex', cwd: tmpdir(), input: '测试输入' });
  assert.deepEqual(steps, ['auth', 'environment', 'run']);
});

// 办公室必须忠实展示数据库与调度器状态，同时保持长期运行后的角色记录可见。
test('办公室映射并发角色、历史轮次和真实交接，不伪造运行', (t) => {
  const f = fixture(t); f.store.plan(f.project.id, plan); f.store.update(f.project.id, { status: 'running' });
  const planner = f.store.beginRun(f.project.id, 'planner', '规划输入'); f.store.finishRun(planner, 'completed', '规划完成');
  for (let i = 0; i < 105; i++) { const run = f.store.beginRun(f.project.id, 'developer', `第 ${i} 轮`); f.store.finishRun(run, 'completed', '开发结果'); }
  const developer = f.store.beginRun(f.project.id, 'developer', '正在开发');
  f.store.event(f.project.id, 'agent.output', '编写真实源码', developer);
  f.store.beginRun(f.project.id, 'evaluator', '正在评估'); f.store.event(f.project.id, 'plan.created', '真实任务交接');
  const active = { controls: new Map([[f.project.id, {}]]) };
  const snapshot = buildOfficeSnapshot(f.store, active, f.project.id);
  assert.equal(snapshot.actors.find((actor) => actor.id === 'planner').run.id, planner);
  assert.equal(snapshot.actors.filter((actor) => actor.state === 'working').length, 2);
  assert.equal(snapshot.actors.find((actor) => actor.id === 'test').run, null);
  assert.ok(snapshot.actors.find((actor) => actor.id === 'developer').recentOutput.includes('真实源码'));
  assert.equal(snapshot.messages[0].from, 'planner'); assert.equal(snapshot.messages[0].to, 'developer');
  assert.equal(snapshot.progress.total, 1);
  const offline = buildOfficeSnapshot(f.store, { controls: new Map() }, f.project.id);
  assert.equal(offline.actors.some((actor) => actor.state === 'working'), false);
});

// 补充要求必须先停止旧开发进程，再持久化并进入新轮次，不能只改变画面。
test('办公室补充指令保存进度并恢复真实开发，要求进入后续上下文', async (t) => {
  const f = fixture(t, { developer: ({ count }) => count === 1 ? 'hold' : undefined });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => f.counts.developer === 1, '未启动开发');
  await f.orchestrator.steer(f.project.id, '请先验证中文输入，再完成结果文件');
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '补充要求未执行完毕', 20000);
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.ok(f.stopped.includes('developer'));
  assert.equal(f.store.instructions(f.project.id)[0].content, '请先验证中文输入，再完成结果文件');
  assert.equal(f.store.tasks(f.project.id).length, 2);
  assert.ok(f.calls.filter((call) => call.role === 'developer')[1].input.includes('请先验证中文输入'));
  assert.equal(f.store.events(f.project.id, { kind: 'control.steer' }).length, 1);
  await assert.rejects(f.orchestrator.steer(f.project.id, '新的要求'), /项目已完成/);
});

// 新接口与原控制接口共用状态机和来源校验，并暴露可本地加载的上游模块。
test('办公室 HTTP 快照、补充指令与上游模块可访问，跨源写入被拒绝', async (t) => {
  const f = fixture(t), server = createApp(f);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = `${base}/api/projects/${f.project.id}`;
  const initial = await (await fetch(`${endpoint}/office`)).json();
  assert.equal(initial.actors.length, 4); assert.ok(initial.actors.every((actor) => actor.state === 'idle'));
  const script = await fetch(`${base}/vendor/munder-difflin/portrait-art.js`);
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  assert.ok((await script.text()).includes('sceneFrameBufs'));
  assert.equal((await fetch(`${base}/office-license.txt`)).status, 200);
  const forbidden = await fetch(`${endpoint}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' }, body: JSON.stringify({ content: '外部指令' }) });
  assert.equal(forbidden.status, 403); assert.equal(f.store.instructions(f.project.id).length, 0);
  const sent = await fetch(`${endpoint}/steer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '保持无需第三方依赖' }) });
  assert.equal(sent.status, 200);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), 'HTTP 指令未执行完毕');
  const complete = await (await fetch(endpoint)).json();
  assert.equal(complete.status, 'completed'); assert.equal(complete.office.instructions[0].content, '保持无需第三方依赖');
  assert.equal(complete.office.progress.passed, 1);
});

// 直接加载固定版本的上游程序化绘图，确认无需商业贴图或额外运行依赖。
test('上游像素角色可生成非空的前后视图与行走帧', () => {
  for (const name of ['michael', 'jim', 'dwight', 'pam']) {
    const frames = sceneFrameBufs(name);
    assert.equal(frames.front.length, 3); assert.equal(frames.back.length, 3);
    assert.equal(frames.front[0].length, SCENE_W * SCENE_H * 4);
    assert.ok(frames.front[0].some((value, index) => index % 4 === 3 && value === 255));
    assert.notDeepEqual(frames.front[0], frames.front[1]);
  }
});

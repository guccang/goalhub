// 本文件通过真实 SQLite/Git 和可控模拟宿主验证持续执行、失败修复、暂停、问答与 HTTP 边界。
import { effectiveLanguage, validateLanguage } from '../lib/languages.mjs';
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
import { team, validateTeam, assignEmployee, requireTeam } from '../lib/employees.mjs';
import { buildOfficeSnapshot } from '../lib/office.mjs';
import { sceneFrameBufs, SCENE_W, SCENE_H } from '../public/vendor/munder-difflin/portrait-art.js';

const plan = { needsInput: false, summary: '实现可验证的本地文件功能', tasks: [{ assignee: 'developer', title: '实现功能', description: '生成 answer.txt，内容应为 42。', checkIds: ['file'] }], checks: [{ id: 'file', title: '验证结果文件', command: 'verify-answer', expectation: 'answer.txt 内容为 42' }] };

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
  const counts = { coordinator: 0, probe: 0, developer: 0, planner: 0, evaluator: 0, final: 0, test: 0 }, calls = [], stopped = [];
  const runtime = {
    dataDir: directory,
    // load 使用公共配置模块，模型调用仍由下方可控宿主模拟。
    async load() { return new Runtime(directory).load(); },
    // status 返回本地模拟模块状态。
    status() { return { available: true, message: '测试宿主' }; },
    // host 模拟可停止的公共 Agent 句柄，并写入真实源码文件。
    async host(options) {
      const role = options.input.includes('这是宿主连通性测试') ? 'probe' : options.input.includes('你是任务分配负责人') ? 'coordinator' : options.input.includes('你是规划 Agent') ? 'planner' : options.input.includes('你是执行 Agent') ? 'developer' : options.input.includes('最终验收评估') ? 'final' : 'evaluator';
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
          // 此夹具交付纯文本文件，明确声明源码交付；Web 与安装包使用独立的真实进程测试。
          if (role === 'developer') writeFileSync(join(options.cwd, 'goalhub.delivery.json'), JSON.stringify({ kind: 'source', instructions: '这是纯文本结果文件，读取 answer.txt 并核对值为 42，无需安装。' }));
          const custom = behavior[role] ? await behavior[role]({ options, count, counts, directory }) : undefined;
          if (custom === 'hold' || finished) return;
          let reply = custom;
          if (reply === undefined && role === 'probe') reply = options.input.match(/GOALHUB_OK_[a-f0-9-]+/)[0];
          if (reply === undefined && role === 'planner') reply = plan;
          if (reply === undefined && role === 'coordinator') reply = { needsInput: false, assignee: 'developer', summary: '根据职位安排开发员工修复' };
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
test('交付配置缺失触发修复，补齐真实交付验证后才能完成', async t => {
  const f = fixture(t, {
    // developer 第一轮刻意遗漏交付文件，第二轮沿用默认夹具补齐。
    developer({ options, count }) { if (count === 1) rmSync(join(options.cwd, 'goalhub.delivery.json')); },
  });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '交付修复未结束', 30000);
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.counts.developer, 2);
  assert.equal(f.orchestrator.delivery.snapshot(f.project.id).release.status, 'ready');
  assert.ok(f.store.tasks(f.project.id).some(task => task.title === '补齐可使用的项目交付'));
});

test('已完成项目从交付入口交给员工修复，保留目标并自动处理缺失配置', async t => {
  const f = fixture(t, {
    // developer 第一次重新交付遗漏配置，验证系统再次安排员工修复而非停在报错。
    developer({ options, count }) { if (count === 2) rmSync(join(options.cwd, 'goalhub.delivery.json')); },
  });
  const id = f.project.id;
  f.orchestrator.start(id);
  await waitUntil(() => !f.orchestrator.controls.has(id), '初始目标未完成', 30000);
  f.store.saveDelivery(id, { kind: 'web', port: 4789, build: '过时命令', preview: '过时启动命令', instructions: '保留原端口' });
  const server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await server.hostSetup.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/projects/${id}/delivery/build`;
  const request = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await request()).status, 202);
  assert.equal((await request()).status, 400);
  assert.equal(f.store.project(id).settings.delivery, undefined);
  await waitUntil(() => !f.orchestrator.controls.has(id), '员工交付未完成', 60000);
  assert.equal(f.store.project(id).status, 'completed', f.store.project(id).summary);
  assert.equal(f.store.project(id).active_goal_id, f.project.active_goal_id);
  assert.equal(f.store.goals(id).length, 1);
  assert.equal(f.counts.developer, 3);
  assert.ok(f.counts.coordinator >= 2);
  assert.match(f.calls.filter(call => call.role === 'developer')[1].input, /4789/);
  assert.match(f.calls.filter(call => call.role === 'developer')[1].input, /不要求用户填写技术命令/);
  assert.equal(f.orchestrator.delivery.snapshot(id).release.status, 'ready');
  assert.ok(!existsSync(f.git.paths(id).work));
});

test('同项目两次迭代保留首轮证据，重启后协调者及开发会话续接且读取已合并代码', async t => {
  const f = fixture(t, {
    // planner 验证第二个目标确实看到首轮代码，并模拟可去重的宿主统计。
    planner({ options, count }) {
      options.onTelemetry({ key: 'turn', source: 'codex', usage: { input: 100, output: 20, cached: 30 } });
      options.onTelemetry({ key: 'turn', source: 'codex', usage: { input: 100, output: 20, cached: 30 } });
      options.onTelemetry({ source: 'codex', context: { window: 1000, used: 250 } });
      if (count === 2) {
        assert.equal(options.sessionId, 'planner-session');
        assert.equal(readFileSync(join(options.cwd, 'answer.txt'), 'utf8'), '42');
        assert.match(options.input, /previousIterations/);
      }
    },
  });
  const id = f.project.id, first = f.project.active_goal_id;
  f.orchestrator.start(id);
  await waitUntil(() => !f.orchestrator.controls.has(id), '首轮未完成');
  assert.equal(f.store.project(id).status, 'completed');
  const firstTasks = f.store.tasks(id), firstGoal = f.store.goals(id)[0];
  const reopened = new Store(join(f.directory, 'state.sqlite'));
  reopened.recover();
  assert.equal(reopened.latestSession(id, 'planner'), 'planner-session');
  reopened.close();
  f.store.createGoal(id, { goal: '保留原文件并进行第二轮验收', title: '第二轮' });
  assert.equal(f.store.tasks(id).length, 0);
  f.orchestrator.start(id);
  await waitUntil(() => !f.orchestrator.controls.has(id), '第二轮未完成');
  assert.equal(f.store.project(id).status, 'completed', f.store.project(id).summary);
  assert.deepEqual(f.store.tasks(id, first), firstTasks);
  assert.equal(f.store.detail(id, first).historical, true);
  assert.equal(f.store.detail(id, first).goalUsage.total, 120);
  assert.equal(f.store.usage(id).total, 240);
  assert.equal(f.store.usage().total, 240);
  assert.equal(f.store.sessions(id)[0].remainingPercent, 75);
  assert.equal(f.store.goals(id)[1].base_commit, firstGoal.merge_commit);
  assert.equal(f.calls.filter(call => call.role === 'developer')[1].sessionId, 'developer-session');
  assert.ok(!existsSync(f.git.paths(id).work));
  f.store.resetSessions(id);
  assert.equal(f.store.latestSession(id, 'planner'), '');
  assert.equal(f.store.usage(id).total, 240);
});

// 未完成目标不能被新迭代覆盖，主分支在验收之前保持原有代码。
test('项目添加不调用模型，未完成目标不能覆盖，检查点不提前合并主分支', async t => {
  const f = fixture(t);
  assert.throws(() => f.store.createGoal(f.project.id, { goal: '覆盖' }), /先完成/);
  const registered = f.store.create({ name: '独立项目' });
  assert.equal(registered.status, 'ready');
  assert.equal(f.store.goals(registered.id).length, 0);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.orchestrator.start(registered.id), /提出需求/);
  const paths = await f.git.ensure(f.project);
  writeFileSync(join(paths.work, 'not-verified.txt'), 'draft');
  await f.git.checkpoint(f.project.id, 'save draft');
  assert.equal(existsSync(join(paths.repo, 'not-verified.txt')), false);
  assert.equal(existsSync(join(paths.work, 'not-verified.txt')), true);
});

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
test('项目登记和目标 API 分离，计划可编辑且历史目标归属受校验', async t => {
  const f = fixture(t), server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // post 发送同源业务请求。
  const post = (path, value) => fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const registered = await (await post('/projects/register', { name: '长期项目', path: '' })).json();
  assert.equal(registered.status, 'ready');
  assert.equal(f.calls.length, 0);
  await server.hostSetup.save({ hostType: 'codex', model: '' });
  const probe = server.hostSetup.start(); await waitUntil(() => !server.hostSetup.job, '宿主未就绪');
  assert.equal((await post(`/projects/${registered.id}/goals`, { title: '首轮', goal: '首轮需求', hostTestId: probe.id, autoStart: false })).status, 200);
  const goalId = f.store.project(registered.id).active_goal_id;
  f.store.plan(registered.id, plan); f.store.update(registered.id, { status: 'awaiting_approval' });
  assert.equal((await post(`/projects/${registered.id}/plan`, { ...plan, summary: '修改后的总体计划' })).status, 200);
  assert.equal(f.store.project(registered.id).summary, '修改后的总体计划');
  assert.equal(f.store.project(registered.id).plan_approved, 0);
  assert.equal((await post(`/projects/${registered.id}/goals`, { goal: '不能覆盖', hostTestId: probe.id })).status, 400);
  assert.equal((await fetch(`${base}/api/projects/${f.project.id}/goals/${goalId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/usage`)).status, 200);
  assert.equal(f.counts.developer, 0);
});

// 续接会话的累计计数只能按基线差值归属当前目标，重复事件不能重复消费。
test('跨目标累计计数差分、未知值与项目隔离统计', t => {
  const f = fixture(t), id = f.project.id;
  const first = f.store.beginRun(id, 'planner', '首轮'); f.store.session(first, 'same-session');
  const sample = { key: 'codex-turn', source: 'codex', cumulative: true, usage: { input: 100, output: 20, cached: 30 } };
  f.store.telemetry(first, sample); f.store.finishRun(first, 'completed', '首轮');
  f.store.update(id, { status: 'completed' });
  f.store.createGoal(id, { goal: '第二轮' });
  const second = f.store.beginRun(id, 'planner', '第二轮'); f.store.session(second, 'same-session');
  const next = { ...sample, resumed: true, usage: { input: 240, output: 50, cached: 70 } };
  f.store.telemetry(second, next); f.store.telemetry(second, next);
  assert.equal(f.store.usage(id).total, 290);
  assert.equal(f.store.usage(id, f.store.project(id).active_goal_id).total, 170);
  const other = f.store.create({ name: '其他项目', goal: '其他目标', settings: f.project.settings });
  const unknown = f.store.beginRun(other.id, 'planner', '旧会话'); f.store.session(unknown, 'legacy-session');
  f.store.telemetry(unknown, { ...sample, resumed: true });
  assert.equal(f.store.usage(other.id).total, null);
  assert.equal(f.store.usage(other.id).known_runs, 0);
  assert.equal(f.store.usage().total, 290);
});

// 旧数据补录首个目标，重复迁移不重复生成目标或丢失任务、问答、执行记录。
test('旧项目迁移生成唯一首个目标并保留全部关联记录', t => {
  const f = fixture(t), legacy = f.store.create({ name: '旧项目' });
  f.store.db.prepare("UPDATE projects SET goal='旧需求',status='paused' WHERE id=?").run(legacy.id);
  const run = f.store.beginRun(legacy.id, 'planner', '旧输入');
  f.store.ask(legacy.id, ['旧问题']);
  f.store.migrateProjects();
  const goal = f.store.project(legacy.id).active_goal_id;
  assert.ok(goal); assert.equal(f.store.run(run).goal_id, goal);
  assert.equal(f.store.questions(legacy.id)[0].prompt, '旧问题');
  f.store.migrateProjects();
  assert.equal(f.store.goals(legacy.id).length, 1);
});

test('HTTP 接口可创建查询项目并拒绝跨源和无效输入', async (t) => {
  const f = fixture(t), server = createApp(f);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await server.hostSetup.save({ hostType: 'codex', model: '' });
  const probe = server.hostSetup.start();
  await waitUntil(() => !server.hostSetup.job, '宿主测试未结束');
  const created = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'HTTP 项目', goal: '测试保存目标', autoStart: false, hostTestId: probe.id }) });
  assert.equal(created.status, 201);
  const value = await created.json(); assert.equal(value.status, 'paused');
  // 同一份全局宿主测试可被多个目标复用，创建目标不修改配置或触发新探测。
  const another = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '复用全局宿主', goal: '第二个独立目标', autoStart: false, hostTestId: probe.id }) });
  assert.equal(another.status, 201); assert.equal((await another.json()).settings.hostTestId, probe.id);
  assert.equal(f.counts.probe, 1); assert.equal(server.hostSetup.profile().revision, probe.revision);

  const forbidden = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', goal: 'x', hostTestId: probe.id, settings: { evaluationMinutes: -1 } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  const records = await (await fetch(`${base}/api/projects/${value.id}/events?search=保存`)).json();
  assert.equal(records.length, 1); assert.equal(records[0].kind, 'goal.created');
  assert.equal((await fetch(base)).status, 200);
  const headers = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: '禁止跳过', goal: '未经测试' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/projects/${value.id}/start`, { method: 'POST', headers, body: '{}' })).status, 200);
  await waitUntil(() => !f.orchestrator.controls.has(value.id), '预览未完成');
  assert.equal(f.store.project(value.id).status, 'awaiting_approval'); assert.equal(f.counts.developer, 0);
  assert.equal((await fetch(`${base}/api/projects/${value.id}/start`, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(`${base}/api/projects/${value.id}/approve`, { method: 'POST', headers, body: '{}' })).status, 200);
  await waitUntil(() => !f.orchestrator.controls.has(value.id), '确认后未完成');
  assert.equal(f.store.project(value.id).status, 'completed');

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
  f.store.beginRun(f.project.id, 'evaluator', '正在评估'); f.store.event(f.project.id, 'plan.created', JSON.stringify(plan));
  const active = { controls: new Map([[f.project.id, {}]]) };
  const snapshot = buildOfficeSnapshot(f.store, active, f.project.id);
  assert.equal(snapshot.actors.find((actor) => actor.id === 'planner').run.id, planner);
  assert.equal(snapshot.actors.filter((actor) => actor.state === 'working').length, 2);
  assert.equal(snapshot.actors.find((actor) => actor.id === 'test').run, null);
  assert.ok(snapshot.actors.find((actor) => actor.id === 'developer').recentOutput.includes('真实源码'));
  assert.equal(snapshot.messages[0].from, 'planner'); assert.equal(snapshot.messages[0].to, 'developer');
  assert.equal(snapshot.progress.total, 1);
  // 测试命令只驱动工作站，质量工程师只在真实最终验收轮次中工作。
  f.store.beginRun(f.project.id, 'test', '执行测试');
  let separated = buildOfficeSnapshot(f.store, active, f.project.id);
  assert.equal(separated.actors.find(actor => actor.id === 'test').kind, 'facility');
  assert.equal(separated.actors.find(actor => actor.id === 'test').state, 'working');
  assert.equal(separated.actors.find(actor => actor.id === 'quality').state, 'idle');
  f.store.beginRun(f.project.id, 'final-review', '核对交付');
  separated = buildOfficeSnapshot(f.store, active, f.project.id);
  assert.equal(separated.actors.find(actor => actor.id === 'quality').state, 'working');
  assert.equal(separated.actors.filter(actor => actor.kind === 'employee').length, 4);
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
  assert.equal(initial.actors.length, 5); assert.ok(initial.actors.every((actor) => actor.state === 'idle'));
  const script = await fetch(`${base}/vendor/munder-difflin/portrait-art.js`);
  assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
  assert.ok((await script.text()).includes('sceneFrameBufs'));
  assert.equal((await fetch(`${base}/office-license.txt`)).status, 200);
  const engine = await fetch(`${base}/office-engine/engine.js`); assert.equal(engine.status, 200);
  const asset = (await engine.text()).match(/\/office-engine\/assets\/office-tileset-[A-Z0-9]+\.png/)[0];
  const image = await fetch(`${base}${asset}`); assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${base}/office-engine/ASSET-LICENSE.txt`)).status, 200);
  assert.equal((await fetch(`${base}/office-engine/../../server.mjs`)).status, 404);

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

// 人工确认必须先停在预览，恢复服务和普通继续均不能绕过确认。
test('人工确认计划门槛在重启后仍生效，确认后才开发', async (t) => {
  const f = fixture(t);
  const project = f.store.create({ name: '预览目标', goal: '生成结果文件', settings: { ...f.project.settings, confirmationMode: 'manual' } });
  f.orchestrator.start(project.id);
  await waitUntil(() => !f.orchestrator.controls.has(project.id), '规划未结束');
  assert.equal(f.store.project(project.id).status, 'awaiting_approval');
  assert.equal(f.counts.developer, 0); assert.equal(f.counts.test, 0);
  assert.equal(f.store.tasks(project.id).length, 1); assert.equal(f.store.checks(project.id).length, 1);
  f.store.recover(); assert.equal(f.store.project(project.id).status, 'awaiting_approval');
  assert.throws(() => f.orchestrator.start(project.id), /确认计划/);
  await assert.rejects(f.orchestrator.steer(project.id, '绕过'), /确认计划/);
  f.orchestrator.approve(project.id);
  await waitUntil(() => !f.orchestrator.controls.has(project.id), '执行未结束');
  assert.equal(f.store.project(project.id).status, 'completed'); assert.equal(f.counts.developer, 1);
  assert.ok(f.store.events(project.id).some(event => event.kind === 'plan.approved'));
});

// 真实探测成功与配置版本绑定，失败和旧配置结果不能授权新项目。
test('宿主测试记录完整输入输出，配置变更使旧测试失效', async (t) => {
  const f = fixture(t), server = createApp(f), setup = server.hostSetup;
  t.after(() => setup.close());
  await setup.save({ hostType: 'codex', model: '' });
  const first = setup.start(); await waitUntil(() => !setup.job, '探测未结束');
  assert.equal(setup.test(first.id).status, 'passed'); assert.match(setup.test(first.id).output, /GOALHUB_OK_/);
  assert.equal(setup.verified(first.id).hostType, 'codex');
  await setup.save({ hostType: 'codex', model: 'changed' });
  assert.throws(() => setup.verified(first.id), /连通性测试/);
  f.runtime.host = async () => ({ done: Promise.resolve({ code: 0, finalMessage: 'incorrect reply' }), stop() {} });
  const failed = setup.start(); await waitUntil(() => !setup.job, '失败探测未结束');
  assert.equal(setup.test(failed.id).status, 'failed'); assert.throws(() => setup.verified(failed.id));
});

// 自动确认选择直接进入开发，同时必须保留自动确认的审计记录。
test('自动确认模式生成计划后持续执行并记录确认', async (t) => {
  const f = fixture(t);
  const project = f.store.create({ name: '自动目标', goal: '生成文件', settings: { ...f.project.settings, confirmationMode: 'auto' } });
  f.orchestrator.start(project.id); await waitUntil(() => !f.orchestrator.controls.has(project.id), '自动执行未完成');
  assert.equal(f.store.project(project.id).status, 'completed');
  assert.ok(f.store.events(project.id, { kind: 'plan.approved' }).some(event => event.content.includes('自动确认')));
});

// 员工配置必须影响真实调度参数，并随轮次留存，不能只是办公室外观。
test('项目员工宿主模型思考强度传入执行并保留审计快照', async t => {
  const f = fixture(t), employees = team(f.project);
  employees[0].model = 'planning-model'; employees[0].reasoningEffort = 'high';
  employees[1].position = '前端工程师'; employees[1].hostType = 'claudecode'; employees[1].model = 'vendor/frontend'; employees[1].instructions = '优先保证可访问性';
  f.store.saveEmployees(f.project.id, validateTeam(employees));
  f.orchestrator.start(f.project.id); await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '员工执行未完成');
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.calls.find(call => call.role === 'planner').reasoningEffort, 'high');
  assert.equal(f.calls.find(call => call.role === 'planner').model, 'planning-model');
  const developer = f.calls.find(call => call.role === 'developer');
  assert.equal(developer.hostType, 'claudecode'); assert.equal(developer.model, 'vendor/frontend'); assert.match(developer.input, /优先保证可访问性/);
  const run = f.store.employeeRun(f.project.id, employees[1]);
  assert.equal(JSON.parse(run.executor).name, 'Jim'); assert.equal(JSON.parse(run.executor).position, '前端工程师');
  f.store.saveEmployees(f.project.id, employees.filter(employee => employee.role !== 'developer'));
  assert.ok(f.store.run(run.id)); assert.doesNotThrow(() => requireTeam(f.store.project(f.project.id)));
  const other = f.store.create({ name: '另一项目', goal: '独立设置', settings: f.project.settings });
  assert.equal(team(other)[1].hostType, 'codex');
});

// 按任务明确指派员工，职位或模型变化后隔离原会话。
test('员工明确分配与模型切换隔离会话，重复编号和不支持的参数被拒绝', t => {
  const f = fixture(t), employees = team(f.project);
  employees.push({ ...employees[1], id: 'second-dev', name: '第二开发员工' });
  f.store.saveEmployees(f.project.id, validateTeam(employees));
  const first = assignEmployee(f.store, f.store.project(f.project.id), 'developer', 'developer');
  const run = f.store.beginRun(f.project.id, 'developer', '任务', first); f.store.session(run, 'session-first'); f.store.finishRun(run, 'completed', 'done');
  const second = assignEmployee(f.store, f.store.project(f.project.id), 'developer', 'second-dev'); assert.equal(second.id, 'second-dev');
  assert.equal(f.store.employeeSession(f.project.id, 'developer', second.configKey), '');
  assert.equal(f.store.employeeSession(f.project.id, 'developer', first.configKey), 'session-first');
  employees.splice(-1); employees[1].model = 'another-model'; f.store.saveEmployees(f.project.id, employees);
  const changed = assignEmployee(f.store, f.store.project(f.project.id), 'developer', 'developer');
  assert.notEqual(changed.configKey, first.configKey); assert.equal(f.store.employeeSession(f.project.id, 'developer', changed.configKey), '');
  assert.throws(() => validateTeam([...employees, employees[0]]), /重复/);
  assert.throws(() => validateTeam([{ ...employees[0], hostType: 'claudecode', reasoningEffort: 'high' }]), /仅 Codex/);
});

// HTTP 层必须拒绝运行中修改与跨源写入，暂停后可独立保存项目员工。
test('员工管理接口拒绝运行中变更并在暂停后持久化', async t => {
  const f = fixture(t), server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/projects/${f.project.id}/employees`;
  const original = await (await fetch(url)).json(); assert.equal(original.employees.length, 4);
  original.employees[1].model = 'project-specific';
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: original.employees }) };
  f.orchestrator.controls.set(f.project.id, {});
  assert.equal((await fetch(url, request)).status, 400); f.orchestrator.controls.delete(f.project.id);
  assert.equal((await fetch(url, { ...request, headers: { ...request.headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, request)).status, 200);
  assert.equal((await (await fetch(url)).json()).employees[1].model, 'project-specific');
  assert.ok(f.store.events(f.project.id).some(event => event.kind === 'team.updated'));
});

// 验证继承、覆盖、持久化、运行快照与提示词使用同一套语言规则。
test('项目语言和员工母语分别保存，真实调度输入携带有效语言', async t => {
  const f = fixture(t), employees = team(f.project);
  assert.equal(effectiveLanguage(f.project), 'zh-CN');
  employees[1].nativeLanguage = 'ja'; employees[0].nativeLanguage = 'ko';
  f.store.saveEmployees(f.project.id, validateTeam(employees), 'en');
  const project = f.store.project(f.project.id);
  assert.equal(effectiveLanguage(project, employees[0]), 'ko');
  assert.equal(effectiveLanguage(project, employees[1]), 'ja');
  const before = assignEmployee(f.store, project, 'developer', 'developer').configKey;
  f.store.saveEmployees(f.project.id, validateTeam(employees), 'zh-CN');
  assert.notEqual(assignEmployee(f.store, f.store.project(f.project.id), 'developer', 'developer').configKey, before);
  f.store.saveEmployees(f.project.id, validateTeam(employees), 'en');
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '语言配置执行未结束');
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.match(f.calls.find(call => call.role === 'planner').input, /한국어 \(ko\)/);
  assert.match(f.calls.find(call => call.role === 'developer').input, /日本語 \(ja\)/);
  assert.match(f.calls.find(call => call.role === 'final').input, /한국어 \(ko\)/);
  assert.match(f.calls.find(call => call.role === 'developer').input, /JSON 字段名/);
  const runs = f.store.detail(f.project.id).runs;
  assert.equal(JSON.parse(f.store.run(runs.find(run => run.role === 'developer').id).executor).effectiveLanguage, 'ja');
  const snapshot = buildOfficeSnapshot(f.store, f.orchestrator, f.project.id);
  assert.equal(snapshot.actors.find(actor => actor.id === 'developer').effectiveLanguage, 'ja');
  assert.throws(() => validateTeam([{ ...employees[0], nativeLanguage: 'invalid' }]), /语言/);
  assert.throws(() => validateLanguage(''), /语言/);
});
// HTTP 配置只允许支持的语言，并保证非法输入不会部分修改员工。
test('语言接口保存四种语言且拒绝非法配置', async t => {
  const f = fixture(t), server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/api/projects/${f.project.id}/employees`;
  const original = await (await fetch(url)).json();
  assert.equal(original.language, 'zh-CN'); assert.equal(Object.keys(original.languages).length, 4);
  for (const language of ['en', 'ja', 'ko', 'zh-CN']) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: original.employees, language }) });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(url)).json()).language, language);
  }
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: [], language: 'xx' }) });
  assert.equal(response.status, 400); assert.equal(team(f.store.project(f.project.id)).length, 4);
});

// 模型目录接口复用运行时查询，不改变宿主配置或连通性测试结果。
test('动态模型 HTTP 接口返回宿主目录和前端组件', async t => {
  const f = fixture(t), server = createApp(f);
  f.runtime.models = async type => ({ supported: true, models: [{ model: type + '-dynamic', displayName: '来自宿主' }] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await (await fetch(base + '/api/host/models?type=codex')).json();
  assert.equal(result.models[0].model, 'codex-dynamic');
  assert.equal((await fetch(base + '/model-picker.js')).status, 200);
  assert.equal(server.hostSetup.profile().revision, '');
});

// 任意员工编号和职位都能完成真实调度，负责人不依赖旧 planner 职责。
test('两人项目按自定义职位分配任务，负责人和执行宿主真实生效', async t => {
  const f = fixture(t, { planner: () => ({ ...plan, tasks: [{ ...plan.tasks[0], assignee: 'unity-worker' }] }) });
  const defaults = team(f.project);
  const manager = { ...defaults[0], id: 'lead-pam', character: 'pam', role: undefined, position: '项目负责人', model: 'lead-model' };
  const worker = { ...defaults[1], id: 'unity-worker', role: undefined, position: 'Unity 客户端开发', instructions: '遵循组件架构，完成协议接入和验证。', hostType: 'claudecode', model: 'unity-model' };
  f.store.saveEmployees(f.project.id, validateTeam([manager, worker]), 'zh-CN', '项目使用组件架构；协议版本不得改变。');
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '两人团队未结束', 30000);
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.store.tasks(f.project.id)[0].assignee, 'unity-worker');
  const execution = f.calls.find(call => call.role === 'developer');
  assert.equal(execution.model, 'unity-model'); assert.equal(execution.hostType, 'claudecode');
  assert.match(execution.input, /Unity 客户端开发/); assert.match(execution.input, /协议版本不得改变/);
  assert.equal(f.calls.find(call => call.role === 'final').model, 'lead-model');
  const snapshot = buildOfficeSnapshot(f.store, f.orchestrator, f.project.id);
  assert.equal(snapshot.actors.find(actor => actor.isLead).id, 'lead-pam');
  assert.equal(snapshot.actors.find(actor => actor.id === 'lead-pam').name, 'Pam');
  assert.equal(snapshot.actors.find(actor => actor.id === 'unity-worker').kind, 'employee');
  assert.ok(snapshot.messages.some(message => message.from === 'lead-pam' && message.to === 'unity-worker'));
  assert.ok(snapshot.messages.some(message => message.from === 'unity-worker' && message.to === 'lead-pam'));
  assert.equal(f.store.sessions(f.project.id).length, 2);
});

// 负责人自己执行时不能启动同一个员工的并发评估。
test('单员工项目可自行完成任务，执行期间负责人评估不会重入', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, {
    planner: () => ({ ...plan, tasks: [{ ...plan.tasks[0], assignee: 'solo' }] }),
    // developer 保持任务运行，便于触发进度检查验证员工互斥。
    async developer() { await pending; },
  });
  f.store.saveEmployees(f.project.id, validateTeam([{ ...team(f.project)[0], id: 'solo', role: undefined }]));
  f.orchestrator.start(f.project.id);
  await waitUntil(() => f.counts.developer === 1, '负责人没有开始执行', 30000);
  f.orchestrator.evaluateNow(f.project.id);
  assert.equal(f.counts.evaluator, 0);
  release();
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '单员工任务没有完成', 30000);
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.store.detail(f.project.id).runs.filter(run => run.role !== 'test').every(run => f.store.run(run.id).employee_id === 'solo'), true);
});

// 员工离开后任务重新分配，已完成任务和原运行快照不被改写。
test('移除已分配员工后由负责人重新安排，恢复不依赖旧职责', async t => {
  const f = fixture(t, { coordinator: () => ({ needsInput: false, assignee: 'quality', summary: '由具备验证能力的 Pam 接手' }) });
  f.store.plan(f.project.id, plan);
  f.store.saveEmployees(f.project.id, validateTeam(team(f.project).filter(employee => employee.id !== 'developer')));
  assert.equal(f.store.tasks(f.project.id)[0].assignee, '');
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '重新分配未完成', 30000);
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.store.tasks(f.project.id)[0].assignee, 'quality');
  assert.equal(f.counts.coordinator, 1);
  const run = f.store.detail(f.project.id).runs.find(run => run.role === 'developer');
  assert.equal(f.store.run(run.id).employee_id, 'quality');
  assert.ok(f.store.events(f.project.id).some(event => event.kind === 'task.assigned'));
});

// 不完整草稿可保存，启动条件与负责人唯一性必须在服务端执行。
test('职位草稿、唯一负责人和跨项目会话隔离', t => {
  const f = fixture(t), employees = team(f.project);
  assert.doesNotThrow(() => validateTeam([]));
  assert.throws(() => validateTeam([{ ...employees[0], enabled: false }]), /负责人必须/);
  assert.throws(() => validateTeam([employees[0], { ...employees[1], isLead: true }]), /只能指定/);
  f.store.saveEmployees(f.project.id, validateTeam([{ ...employees[0], position: '' }]));
  assert.throws(() => f.orchestrator.start(f.project.id), /职位名称/);
  f.store.saveEmployees(f.project.id, validateTeam([employees[0]]));
  assert.doesNotThrow(() => requireTeam(f.store.project(f.project.id)));
  const first = assignEmployee(f.store, f.store.project(f.project.id), 'planner');
  const run = f.store.beginRun(f.project.id, 'planner', '项目 A', first); f.store.session(run, 'only-project-a'); f.store.finishRun(run, 'completed', '结果');
  const other = f.store.create({ name: '项目 B', settings: f.store.project(f.project.id).settings });
  assert.equal(f.store.employeeSession(other.id, 'planner', first.configKey), '');
  f.store.saveEmployees(other.id, validateTeam([{ ...employees[0], position: '研究负责人' }]));
  assert.equal(team(f.store.project(f.project.id))[0].position, '项目负责人');
  assert.equal(team(f.store.project(other.id))[0].position, '研究负责人');
});

// 规划必须指向启用员工，拒绝无法执行的指派且不会启动开发。
test('负责人反复分配不存在员工时阻断并保存原因', async t => {
  const f = fixture(t, { planner: () => ({ ...plan, tasks: [{ ...plan.tasks[0], assignee: 'outsider' }] }) });
  f.orchestrator.start(f.project.id);
  await waitUntil(() => !f.orchestrator.controls.has(f.project.id), '非法分配没有结束', 30000);
  assert.equal(f.store.project(f.project.id).status, 'blocked');
  assert.equal(f.counts.developer, 0); assert.equal(f.store.tasks(f.project.id).length, 0);
  assert.match(f.store.project(f.project.id).summary, /本项目启用员工/);
});

// 旧团队只迁移一次，重启保留职位、员工编号、任务指派及历史执行快照。
test('旧职责迁移和重启保留项目员工与历史证据', t => {
  const f = fixture(t), original = team(f.project);
  const legacy = original.map(({ position, isLead, ...employee }) => ({ ...employee, name: '历史名称', instructions: '' }));
  const { teamVersion, ...settings } = f.project.settings;
  f.store.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(JSON.stringify({ ...settings, employees: legacy }), f.project.id);
  f.store.plan(f.project.id, plan);
  const runId = f.store.beginRun(f.project.id, 'developer', '历史输入', { ...legacy[1], configKey: 'old-key' });
  f.store.finishRun(runId, 'completed', '历史结果');
  const reopened = new Store(join(f.directory, 'state.sqlite'));
  try {
    const project = reopened.project(f.project.id), employees = team(project);
    assert.equal(project.settings.teamVersion, 2);
    assert.equal(employees.find(employee => employee.isLead).id, 'planner');
    assert.equal(employees[1].position, '开发工程师');
    assert.ok(employees[1].instructions); assert.equal(employees[1].name, 'Jim');
    assert.equal(reopened.tasks(f.project.id)[0].assignee, 'developer');
    assert.equal(JSON.parse(reopened.run(runId).executor).name, '历史名称');
    const updated = employees.map(employee => ({ ...employee, position: employee.id === 'developer' ? '自定义客户端职位' : employee.position }));
    reopened.saveEmployees(project.id, validateTeam(updated), 'zh-CN', '持续维护项目架构');
  } finally { reopened.close(); }
  const again = new Store(join(f.directory, 'state.sqlite'));
  try {
    assert.equal(team(again.project(f.project.id))[1].position, '自定义客户端职位');
    assert.equal(again.project(f.project.id).settings.context, '持续维护项目架构');
  } finally { again.close(); }
});

// 默认团队继承项目创建时的宿主强度，员工保存的独立设置优先。
test('项目默认员工继承 Codex 全局强度且允许独立覆盖', t => {
  const f = fixture(t);
  const project = f.store.create({ name: '继承宿主强度', settings: { ...f.project.settings, employees: undefined, reasoningEffort: 'high' } });
  assert.ok(team(project).every(employee => employee.reasoningEffort === 'high'));
  const employees = team(project); employees[1].reasoningEffort = 'low';
  project.settings.employees = employees;
  assert.equal(team(project)[1].reasoningEffort, 'low');
  assert.ok(team({ ...f.project, settings: { hostType: 'claudecode', reasoningEffort: 'high' } }).every(employee => employee.reasoningEffort === ''));
});

// 服务启动后新增的前端模块应立即可读，非公开路径仍不能访问。
test('新增前端模块无需重启且不会暴露项目源码', async t => {
  const f = fixture(t), server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const name = `startup-regression-${process.pid}.js`;
  const file = new URL(`../public/${name}`, import.meta.url);
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(file, { force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/${name}`)).status, 404);
  writeFileSync(file, '// 临时回归模块，不包含业务数据。\nexport const loaded = true;');
  const response = await fetch(`${base}/${name}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  assert.match(await response.text(), /loaded = true/);
  assert.equal((await fetch(`${base}/lib/app.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/data/goalhub.sqlite`)).status, 404);
});
// 主页展示偏好在执行期间可独立更新，旧项目默认展示且不会改变目标状态。
test('办公室展示选项持久化、隔离项目并校验参数', async t => {
  const f = fixture(t), other = f.store.create({ name: '另一个办公室' }), server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // postDisplay 通过真实 HTTP 路由更新显示偏好。
  const postDisplay = value => fetch(`${base}/api/projects/${f.project.id}/display`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ showOfficeOnHome: value }) });
  const before = f.store.project(f.project.id);
  assert.equal(before.settings.showOfficeOnHome, true);
  assert.equal((await postDisplay(false)).status, 200);
  let list = await (await fetch(`${base}/api/projects?offices=1`)).json();
  assert.equal(list.find(row => row.id === f.project.id).office, undefined);
  assert.equal(list.find(row => row.id === other.id).office.projectId, other.id);
  assert.equal(f.store.project(f.project.id).active_goal_id, before.active_goal_id);
  assert.equal(f.store.project(f.project.id).status, before.status);
  assert.equal((await postDisplay('false')).status, 400);
  assert.equal(f.store.project(f.project.id).settings.showOfficeOnHome, false);
  const reopened = new Store(join(f.directory, 'state.sqlite'));
  try { assert.equal(reopened.project(f.project.id).settings.showOfficeOnHome, false); } finally { reopened.close(); }
  assert.equal((await postDisplay(true)).status, 200);
  list = await (await fetch(`${base}/api/projects?offices=1`)).json();
  assert.equal(list.find(row => row.id === f.project.id).office.projectId, f.project.id);
  assert.equal((await fetch(`${base}/office-card.html`)).status, 200);
});

// 重复原始输出不进入下一轮提示词，但必要需求、问答和失败证据完整可达。
test('上下文去重保留当前目标与阻断，历史交付不作为当前覆盖', t => {
  const f = fixture(t), id = f.project.id;
  f.store.plan(id, plan);
  f.store.ask(id, ['真正缺少的外部凭据？']);
  f.store.instruction(id, '用户明确要求保留键盘操作');
  f.store.event(id, 'agent.output', '重复工具日志'.repeat(20000));
  f.store.check(f.store.checks(id)[0].id, 'failed', '失败原因：计算结果错误');
  const text = f.orchestrator.context(id), context = JSON.parse(text);
  assert.equal(context.goal, f.store.project(id).goal);
  assert.equal(context.questions[0].prompt, '真正缺少的外部凭据？');
  assert.equal(context.instructions[0].content, '用户明确要求保留键盘操作');
  assert.match(text, /失败原因：计算结果错误/); assert.doesNotMatch(text, /重复工具日志/);
  assert.equal(context.delivery.configSource, 'repository'); assert.equal(context.delivery.savedConfig, null);
  assert.ok(text.length < 6000, `小任务上下文过大：${text.length}`);
});

// 上下文较短的会话继续复用；达到轮数或容量阈值时仅更换宿主会话，不删除项目证据。
test('长员工会话自动换新，短会话继续复用且保留历史证据', t => {
  const f = fixture(t), id = f.project.id, key = 'test-key';
  for (let index = 0; index < 4; index++) {
    const run = f.store.beginRun(id, 'developer', '已持久化的任务');
    f.store.db.prepare('UPDATE runs SET config_key=? WHERE id=?').run(key, run);
    f.store.session(run, 'long-session'); f.store.finishRun(run, 'completed', '结果');
    assert.equal(f.store.employeeSession(id, 'developer', key), index < 3 ? 'long-session' : '');
  }
  const fresh = f.store.beginRun(id, 'developer', '新会话');
  f.store.db.prepare('UPDATE runs SET config_key=? WHERE id=?').run(key, fresh);
  f.store.session(fresh, 'fresh-session');
  assert.equal(f.store.employeeSession(id, 'developer', key), 'fresh-session');
  f.store.telemetry(fresh, { context: { window: 200000, used: 48000 } });
  assert.equal(f.store.employeeSession(id, 'developer', key), '');
  assert.equal(f.store.run(fresh).input, '新会话');
});

// 首次常规重试直接继续当前员工；不为相同修复额外发起负责人模型调用。
test('员工首次可修复重试沿用分配，仍需真实测试和最终验收', async t => {
  const f = fixture(t, { developer: ({ count }) => count === 1 ? { status: 'retry', summary: '已定位错误，继续修复', questions: [] } : undefined });
  f.store.plan(f.project.id, { ...plan, tasks: plan.tasks.map(task => ({ ...task, assignee: 'developer' })) });
  f.orchestrator.start(f.project.id); await f.orchestrator.controls.get(f.project.id).promise;
  assert.equal(f.store.project(f.project.id).status, 'completed');
  assert.equal(f.counts.developer, 2); assert.equal(f.counts.coordinator, 0);
  assert.equal(f.counts.final, 1); assert.ok(f.counts.test > 0);
});

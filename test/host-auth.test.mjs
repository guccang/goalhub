// 本文件验证认证隔离、CLI 参数、设备码生命周期和第三方 Claude 模型配置，不请求外部模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { Runtime } from '../lib/runtime.mjs';
import { HostSetup } from '../lib/host-setup.mjs';
import { HostAuth, saveCodex, inspectCodex } from '../lib/host-auth.mjs';

// fixture 使用临时数据库及公共模块，只有进程启动由测试替身接管。
async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'goalhub-auth-'));
  const store = new Store(join(dataDir, 'state.sqlite')), runtime = new Runtime(dataDir);
  const module = await runtime.load();
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, runtime, module };
}

// tick 等待事件回调进入可观察状态，避免依赖真实网络时间。
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('Codex API 登录走 stdin 并隔离凭据，读取不回显密钥，空值保留与清除可用', async t => {
  const f = await fixture(t); const secret = 'test-secret-never-in-arguments'; let calls = 0;
  const module = { ...f.module, runProcess(command, args, options) {
    calls++;
    assert.equal(command, 'codex'); assert.ok(args.includes('--with-api-key')); assert.ok(!args.join(' ').includes(secret));
    assert.equal(options.input, secret + '\n'); assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.CODEX_HOME, join(f.dataDir, 'codex-auth', 'api'));
    writeFileSync(join(options.env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }));
    return { done: Promise.resolve({ code: 0 }), stop() {} };
  } };
  await saveCodex(module, f.dataDir, { authMode: 'api', apiKey: secret });
  assert.equal(inspectCodex(f.dataDir).hasApiKey, true); assert.ok(!JSON.stringify(inspectCodex(f.dataDir)).includes(secret));
  await saveCodex(module, f.dataDir, { authMode: 'api', apiKey: '' }); assert.equal(calls, 1);
  assert.ok(!readFileSync(join(f.dataDir, 'host-settings', 'codex-auth.json'), 'utf8').includes(secret));
  await saveCodex(module, f.dataDir, { authMode: 'api', clearApiKey: true }); assert.equal(inspectCodex(f.dataDir).hasApiKey, false);
  await assert.rejects(saveCodex(module, f.dataDir, { authMode: 'api' }), /API Key/);
  await assert.rejects(saveCodex(module, f.dataDir, { authMode: 'invalid' }), /认证方式/);
});

test('设备码只展示官方地址，完成清除临时代码，取消和超时终止进程', async t => {
  const f = await fixture(t); let finish, stopped = 0, starts = 0;
  f.runtime.loaded = Promise.resolve({ ...f.module, runProcess(command, args, options) {
    starts++; assert.ok(args.includes('--device-auth'));
    assert.equal(options.env.CODEX_HOME, join(f.dataDir, 'codex-auth', 'device'));
    options.onLine('stdout', 'https://evil.example/login');
    options.onLine('stdout', 'https://auth.openai.com/codex/device\nABCDE-12345');
    return { done: new Promise(resolve => { finish = resolve; }), stop() { stopped++; finish({ code: 1 }); } };
  } });
  const auth = new HostAuth(f.store, f.runtime, 60); t.after(() => auth.close());
  auth.start(); auth.start(); await tick(); assert.equal(starts, 1);
  assert.equal(auth.snapshot().url, 'https://auth.openai.com/codex/device'); assert.equal(auth.snapshot().code, 'ABCDE-12345');
  finish({ code: 0 }); await auth.job.promise; assert.equal(auth.snapshot().status, 'ready'); assert.equal(auth.snapshot().code, '');
  assert.ok(!JSON.stringify(auth.snapshot().history).includes('ABCDE-12345'));
  auth.start(); await tick(); const cancelled = auth.job.promise; auth.cancel(); await cancelled;
  assert.equal(stopped, 1); assert.equal(auth.snapshot().url, '');
  auth.start(); await auth.job.promise; assert.equal(stopped, 2); assert.match(auth.snapshot().message, /过期/);
});

test('运行时使用对应认证环境，Claude 第三方含斜杠模型使用全局 URL 和 API Key', async t => {
  const f = await fixture(t); let received, invocation;
  f.runtime.loaded = Promise.resolve({ ...f.module, runHost(options) { received = options; return { done: Promise.resolve({ code: 0 }) }; }, runProcess(command, args, options) { invocation = { command, args, options }; } });
  await saveCodex(f.module, f.dataDir, { authMode: 'device' });
  await f.runtime.host({ hostType: 'codex', cwd: f.dataDir, input: 'hello' });
  received.execute('codex', ['exec'], { env: received.env });
  assert.ok(invocation.args.includes('forced_login_method="chatgpt"')); assert.equal(received.env.CODEX_HOME, join(f.dataDir, 'codex-auth', 'device'));
  f.module.saveHostSettings(f.dataDir, 'claudecode', { baseUrl: 'https://gateway.example', apiKey: 'third-party-secret', provider: 'deepseek' });
  await f.runtime.host({ hostType: 'claudecode', model: 'vendor/model', cwd: f.dataDir, input: 'hello' });
  assert.equal(received.env.ANTHROPIC_API_KEY, 'third-party-secret'); assert.equal(received.env.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(received.env.ANTHROPIC_MODEL, 'vendor/model'); assert.equal(received.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'vendor/model');
  assert.equal(received.env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(received.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('设备码登录期间禁止保存、测试和创建目标，登录使旧验证版本失效', async t => {
  const f = await fixture(t); let finish;
  f.runtime.loaded = Promise.resolve({ ...f.module, runProcess() { return { done: new Promise(resolve => { finish = resolve; }), stop() { finish({ code: 1 }); } }; } });
  const setup = new HostSetup(f.store, f.runtime); t.after(() => setup.close());
  await setup.save({ hostType: 'codex', model: '', authMode: 'device' }); const revision = setup.profile().revision;
  setup.login(); await tick(); assert.notEqual(setup.profile().revision, revision);
  await assert.rejects(setup.save({ hostType: 'codex', model: '' }), /等待/);
  assert.throws(() => setup.start(), /等待/); assert.throws(() => setup.verified('old'), /等待/);
  const pending = setup.auth.job.promise; setup.auth.cancel(); await pending;
  assert.equal(setup.auth.snapshot().status, 'idle');
});

// 各宿主状态按自己的配置版本判断，其他宿主的记录数量不会覆盖其结果。
test('全部宿主状态独立展示，配置变更与跨宿主切换不会误报可用', async t => {
  const f = await fixture(t), setup = new HostSetup(f.store, f.runtime);
  let state = await setup.snapshot();
  assert.equal(state.hosts.length, 4); assert.ok(state.hosts.every(host => host.status === 'untested'));
  await setup.save({ hostType: 'codex', model: 'codex-model' });
  const revision = setup.profile().revision;
  f.store.db.prepare('INSERT INTO host_tests(id,revision,host_type,model,status,input,created_at) VALUES(?,?,?,?,?,?,?)').run('codex-test', revision, 'codex', 'codex-model', 'passed', 'probe', new Date().toISOString());
  await setup.save({ hostType: 'claudecode', model: 'vendor/model' });
  for (let i = 0; i < 12; i++) f.store.db.prepare('INSERT INTO host_tests(id,revision,host_type,model,status,input,created_at) VALUES(?,?,?,?,?,?,?)').run('claude-' + i, setup.profile().revision, 'claudecode', 'vendor/model', 'failed', 'probe', new Date().toISOString());
  state = await setup.snapshot();
  assert.equal(state.hosts.find(host => host.hostType === 'codex').status, 'passed');
  assert.equal(state.hosts.find(host => host.hostType === 'codex').active, false);
  assert.equal(state.hosts.find(host => host.hostType === 'claudecode').status, 'failed');
  assert.equal(state.hosts.find(host => host.hostType === 'claudecode').model, 'vendor/model');
  await setup.save({ hostType: 'codex', model: 'changed' });
  state = await setup.snapshot(); assert.equal(state.hosts.find(host => host.hostType === 'codex').status, 'stale');
  await setup.close();
});

// 模型目录查询必须与运行认证一致，并将并发员工查询合并为一个进程。
test('动态模型查询隔离设备认证、合并并发并回收进程', async t => {
  const f = await fixture(t); let calls = 0, stopped = 0;
  await saveCodex(f.module, f.dataDir, { authMode: 'device' });
  f.runtime.loaded = Promise.resolve({ ...f.module,
    // runProcess 模拟目录协议，不调用模型推理。
    runProcess(command, args, options) {
      calls++; assert.equal(command, 'codex'); assert.ok(args.includes('forced_login_method="chatgpt"'));
      assert.equal(options.env.CODEX_HOME, join(f.dataDir, 'codex-auth', 'device'));
      let finish; const done = new Promise(resolve => { finish = resolve; });
      return { done,
        // stop 记录协议完成后的回收。
        stop() { stopped++; finish({ code: 0 }); },
        // write 根据握手或目录请求发送响应。
        write(line) { const request = JSON.parse(line); if (request.method === 'initialized') return;
          queueMicrotask(() => options.onLine('stdout', JSON.stringify({ id: request.id, result: request.method === 'initialize' ? {} : { data: [{ model: 'dynamic-model', displayName: '动态模型', isDefault: true }], nextCursor: null } })));
        }
      };
    }
  });
  const [a,b] = await Promise.all([f.runtime.models('codex'), f.runtime.models('codex')]);
  assert.deepEqual(a,b); assert.equal(a.models[0].model,'dynamic-model'); assert.equal(calls,1); assert.equal(stopped,1);
  await f.runtime.models('codex'); assert.equal(calls,2);
  assert.equal((await f.runtime.models('claudecode')).supported,false);
  await assert.rejects(f.runtime.models('invalid'), /不支持/);
});

// 全局思考强度保存后必须传入真实探测，并使之前的验证结果失效。
test('Codex 全局思考强度持久化、探测传参及版本失效', async t => {
  const f = await fixture(t), setup = new HostSetup(f.store, f.runtime); let actual;
  t.after(() => setup.close());
  f.runtime.host = async options => {
    actual = options;
    return { done: Promise.resolve({ code: 0, finalMessage: options.input.match(/GOALHUB_OK_[a-f0-9-]+/)[0] }), stop() {} };
  };
  await setup.save({ hostType: 'codex', model: 'test-model', reasoningEffort: 'high' });
  const probe = setup.start(); await setup.job.promise;
  assert.equal(actual.reasoningEffort, 'high'); assert.equal(setup.test(probe.id).status, 'passed');
  assert.equal(setup.verified(probe.id).reasoningEffort, 'high');
  assert.equal((await setup.snapshot()).hosts.find(host => host.hostType === 'codex').reasoningEffort, 'high');
  await setup.save({ hostType: 'codex', model: 'test-model', reasoningEffort: 'low' });
  assert.throws(() => setup.verified(probe.id), /测试/);
  await assert.rejects(setup.save({ hostType: 'codex', model: '', reasoningEffort: 'invalid' }), /强度无效/);
  await assert.rejects(setup.save({ hostType: 'claudecode', model: '', reasoningEffort: 'high' }), /仅 Codex/);
  assert.equal(setup.profile().reasoningEffort, 'low');
});

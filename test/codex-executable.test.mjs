// 本文件验证没有桌面 PATH 的后端仍可定位 CLI，且不会误报登录失败或泄漏凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexInvocation, runCodexProcess } from '../lib/codex-executable.mjs';
import { HostAuth } from '../lib/host-auth.mjs';
import { Store } from '../lib/store.mjs';

// fixture 用隔离目录模拟不同安装方式，不依赖开发机 PATH。
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'goalhub-codex-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { Path: '', LOCALAPPDATA: root, APPDATA: root };
  // file 创建假的程序路径，仅检查发现逻辑，不执行占位文件。
  function file(...parts) { const path = join(root, ...parts); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, ''); return path; }
  return { root, env, file };
}

test('没有 PATH 时发现桌面 Codex，升级删除旧版本后重新定位', t => {
  const f = fixture(t), old = f.file('OpenAI', 'Codex', 'bin', 'old', 'codex.exe');
  assert.equal(codexInvocation({}, ['login'], f.env, 'win32').command, old);
  const current = f.file('OpenAI', 'Codex', 'bin', 'new', 'codex.exe');
  utimesSync(old, new Date(0), new Date(0));
  assert.equal(codexInvocation({}, [], f.env, 'win32').command, current);
  rmSync(current); assert.equal(codexInvocation({}, [], f.env, 'win32').command, old);
});

test('显式路径和 PATH 优先，错误显式路径不能悄悄改用其他安装', t => {
  const f = fixture(t), path = f.file('custom', 'codex.exe'), configured = f.file('explicit', 'codex.exe');
  const env = { ...f.env, Path: join(f.root, 'custom') };
  assert.equal(codexInvocation({}, [], env, 'win32').command, path);
  assert.equal(codexInvocation({}, [], { ...env, GOALHUB_CODEX_PATH: configured }, 'win32').command, configured);
  assert.throws(() => codexInvocation({}, [], { ...env, GOALHUB_CODEX_PATH: 'missing.exe' }, 'win32'), /绝对路径/);
  assert.throws(() => codexInvocation({}, [], f.env, 'win32'), /登录之前/);
});

test('npm 入口复用共享解析器，认证参数及 stdin 不经 shell 修改', t => {
  const f = fixture(t), node = f.file('node.exe');
  const module = { processCommand(command, args, env) { assert.match(env.Path, /npm/); return { command: node, args: ['cli.js', ...args] }; } };
  assert.deepEqual(codexInvocation(module, ['login', '--with-api-key'], f.env, 'win32'), { command: node, args: ['cli.js', 'login', '--with-api-key'] });
  let received;
  const options = { input: 'secret\n', env: { ...f.env, GOALHUB_CODEX_PATH: node } };
  const handle = runCodexProcess({ runProcess(...args) { received = args; return 'handle'; } }, 'codex', ['login'], options);
  assert.equal(handle, 'handle'); assert.deepEqual(received, [node, ['login'], options]);
  assert.deepEqual(codexInvocation({}, ['exec'], {}, 'linux'), { command: 'codex', args: ['exec'] });
});

test('设备码启动失败保留系统错误并清除设备码，日志不回显令牌', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new HostAuth(store, { dataDir: '.', async load() { throw new Error('spawn codex ENOENT; access_token=secret-token'); } });
  auth.start(); await auth.job.promise;
  assert.match(auth.snapshot().message, /spawn codex ENOENT/);
  assert.equal(auth.snapshot().code, ''); assert.equal(auth.snapshot().url, '');
  assert.doesNotMatch(JSON.stringify(auth.snapshot()), /secret-token/);
});

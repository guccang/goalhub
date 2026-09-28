// 本文件使用真实 Git、Node 子进程、HTTP 服务和文件下载验证完整交付生命周期。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { ProjectGit } from '../lib/git.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { createApp } from '../lib/app.mjs';
import { validateDelivery } from '../lib/delivery.mjs';

// unusedPort 获取暂未使用的明确端口，测试真正启动指定端口而非模拟就绪。
async function unusedPort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
// fixture 建立真实开发 worktree 和可终止子进程，所有源码均位于测试临时目录。
async function fixture(t, manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'goalhub-delivery-')), store = new Store(join(directory, 'state.sqlite'));
  const git = new ProjectGit(directory, store);
  const runtime = { dataDir: directory,
    // command 仅解析本测试固定的 Node 命令，实际运行构建、校验和 HTTP 服务。
    async command(command, cwd, onLine) {
      assert.ok(command.startsWith('node '));
      const child = spawn(process.execPath, command.slice(5).split(' '), { cwd, windowsHide: true });
      child.stdout.on('data', chunk => onLine('stdout', chunk.toString())); child.stderr.on('data', chunk => onLine('stderr', chunk.toString()));
      const done = new Promise(resolve => { child.on('error', error => resolve({ code: -1, error: error.message })); child.on('close', code => resolve({ code, error: '' })); });
      return { pid: child.pid, done, stop() { child.kill(); } };
    },
  };
  const orchestrator = new Orchestrator({ store, git, runtime }), manager = orchestrator.delivery;
  const project = store.create({ name: '真实交付测试', goal: '交付可使用的软件', settings: {} });
  const paths = await git.ensure(project);
  writeFileSync(join(paths.work, 'package.json'), '{"type":"module"}');
  if (manifest) writeFileSync(join(paths.work, 'goalhub.delivery.json'), JSON.stringify(manifest));
  writeFileSync(join(paths.work, 'build.mjs'), `// 测试构建生成真实文件，字节仅用于下载完整性测试。\nimport{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.html','<h1>Preview ready</h1>');writeFileSync('dist/App.exe',Buffer.from([77,90,1,2,3,4]));console.log('BUILD_OK');`);
  writeFileSync(join(paths.work, 'verify.mjs'), `// 验证构建夹具文件，不能用来声称真实安装器通过安装。\nimport{statSync}from'node:fs';if(statSync('dist/App.exe').size!==6)process.exit(1);console.log('VERIFY_OK');`);
  writeFileSync(join(paths.work, 'serve.mjs'), `// 在指定回环端口提供真实 HTTP 响应。\nimport{createServer}from'node:http';import{readFileSync}from'node:fs';createServer((q,s)=>{s.writeHead(process.argv[3]==='fail'?500:200);s.end(readFileSync('dist/index.html'))}).listen(Number(process.argv[2]),'127.0.0.1');`);
  writeFileSync(join(paths.work, 'fail.mjs'), `// 真实非零退出供失败门槛测试使用。\nconsole.error('BUILD_BROKEN');process.exit(7);`);
  writeFileSync(join(paths.work, 'hold.mjs'), `// 直到取消前保持运行，验证进程确实被回收。\nsetInterval(()=>{},1000);`);
  await git.checkpoint(project.id, 'fixture delivery scripts');
  const server = createApp({ store, git, runtime, orchestrator });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await orchestrator.close(); await server.hostSetup.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    const sub = relative(tmpdir(), directory); assert.ok(sub.startsWith('goalhub-delivery-') && !sub.includes('..') && !isAbsolute(sub)); rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, git, runtime, orchestrator, manager, project, paths,
    // request 走真实同源接口，返回 Response 以验证二进制下载。
    request(path, value) { return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); },
  };
}

test('Web 从持久化快照构建，开发 worktree 删除后仍能指定端口预览并停止', async t => {
  const port = await unusedPort(), f = await fixture(t, { kind: 'web', build: 'node build.mjs', preview: 'node serve.mjs {port} 127.0.0.1', port, instructions: '打开首页' });
  const id = await f.manager.prepare(f.project.id, f.paths.work);
  assert.equal(f.manager.row(id).status, 'verified');
  await f.git.complete(f.project.id); f.manager.publish(id);
  assert.equal(existsSync(f.paths.work), false);
  const previewPort = await unusedPort();
  assert.equal((await f.request(`/deliveries/${id}/preview/start`, { port: previewPort })).status, 200);
  assert.match(await (await fetch(`http://127.0.0.1:${previewPort}`)).text(), /Preview ready/);
  assert.equal(f.manager.snapshot(f.project.id).release.url, `http://127.0.0.1:${previewPort}`);
  assert.equal((await f.request(`/deliveries/${id}/preview/stop`, {})).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${previewPort}`));
  assert.equal(f.manager.snapshot(f.project.id).release.preview, 'stopped');
});

test('安装产物真实校验并保存哈希，未发布不可下载，发布后跨迭代保留', async t => {
  const f = await fixture(t, { kind: 'desktop', build: 'node build.mjs', verify: 'node verify.mjs', artifacts: ['dist/App.exe'], instructions: 'Windows 夹具，仅验证下载字节' });
  const id = await f.manager.prepare(f.project.id, f.paths.work);
  assert.equal((await f.request(`/deliveries/${id}/files/0`)).status, 400);
  await f.git.complete(f.project.id); f.manager.publish(id); f.store.update(f.project.id, { status: 'completed' });
  const snapshot = f.manager.snapshot(f.project.id), file = snapshot.release.files[0];
  const response = await f.request(`/deliveries/${id}/files/0`), bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(bytes.length, 6); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  assert.match(snapshot.release.log, /VERIFY_OK/);
  f.store.createGoal(f.project.id, { title: '第二次', goal: '新目标', settings: f.project.settings });
  assert.equal(f.manager.snapshot(f.project.id).release, null);
  assert.equal(f.manager.snapshot(f.project.id, f.project.active_goal_id).release.id, id);
  assert.equal((await f.request(`/deliveries/${id}/files/0`)).status, 200);
  assert.equal((await f.request(`/deliveries/${id}/files/9`)).status, 400);
  writeFileSync(join(f.directory, 'deliveries', id, 'files', '0'), Buffer.from([77, 90, 9, 9, 9, 9]));
  assert.equal((await f.request(`/deliveries/${id}/files/0`)).status, 400);
});

test('构建非零退出和缺少安装包不会发布交付', async t => {
  for (const build of ['node fail.mjs', 'node build.mjs']) await t.test(build, async t => {
    const f = await fixture(t, { kind: 'desktop', build, verify: 'node verify.mjs', artifacts: ['dist/missing.exe'], instructions: '安装说明' });
    await assert.rejects(f.manager.prepare(f.project.id, f.paths.work));
    assert.equal(f.manager.snapshot(f.project.id).release.status, 'failed');
    assert.equal(f.manager.snapshot(f.project.id).release.files.length, 0);
    assert.equal(existsSync(f.paths.work), true);
  });
});

test('占用端口不会被终止，HTTP 500 不会被判定为可预览', async t => {
  const port = await unusedPort(), f = await fixture(t, { kind: 'web', build: 'node build.mjs', preview: 'node serve.mjs {port} fail 127.0.0.1', port, instructions: '预览说明' });
  f.manager.readyTimeoutMs = 500;
  await assert.rejects(f.manager.prepare(f.project.id, f.paths.work), /未就绪/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  const server = createServer(); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  try { await assert.rejects(f.manager.prepare(f.project.id, f.paths.work), /未就绪/); assert.match(f.manager.snapshot(f.project.id).release.log, /自动使用/); assert.equal(server.listening, true); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('缺少交付文件阻止完成，人工配置可持久化并恢复仓库配置', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.prepare(f.project.id, f.paths.work), /goalhub.delivery.json/);
  const path = `/projects/${f.project.id}/delivery/config`;
  const config = { kind: 'source', instructions: '仅源码库，调用导出的函数，无需安装器' };
  assert.equal((await f.request(path, config)).status, 202);
  assert.equal(f.store.project(f.project.id).settings.delivery.kind, 'source');
  const id = await f.manager.prepare(f.project.id, f.paths.work); assert.equal(f.manager.row(id).status, 'verified');
  await f.request(path, { useFile: true }); assert.equal(f.store.project(f.project.id).settings.delivery, undefined);
});

test('取消和超时终止构建进程，不会产生可下载产物', async t => {
  const f = await fixture(t, { kind: 'desktop', build: 'node hold.mjs', verify: 'node verify.mjs', artifacts: ['dist/App.exe'], instructions: '说明' });
  f.manager.buildTimeoutMs = 80;
  await assert.rejects(f.manager.prepare(f.project.id, f.paths.work), /超时/);
  const control = { cancelled: true, handles: new Set() };
  await assert.rejects(f.manager.prepare(f.project.id, f.paths.work, control), /取消/);
  assert.equal(f.manager.jobs.size, 0);
});

test('交付配置拒绝路径穿越、绝对路径、非安装包和错误端口', () => {
  for (const path of ['../secret.exe', 'C:\\secret.exe', '/tmp/secret.exe', '.git/config.exe', 'dist/app.txt']) assert.throws(() => validateDelivery({ kind: 'desktop', build: 'node build.mjs', verify: 'node verify.mjs', artifacts: [path], instructions: '说明' }));
  assert.throws(() => validateDelivery({ kind: 'android', build: 'build', verify: 'verify', artifacts: ['dist/app.aab'], instructions: '说明' }));
  assert.throws(() => validateDelivery({ kind: 'web', build: 'build', preview: 'serve --port {port}', port: 80, instructions: '说明' }));
});

// 构建验证自行避开被占用端口，历史配置不得伪装成人工覆盖。
test('旧交付与人工设置明确分离，验证端口冲突不触发员工修复', async t => {
  const port = await unusedPort(), f = await fixture(t, { kind: 'web', build: 'node build.mjs', preview: 'node serve.mjs {port} 127.0.0.1', port, instructions: '预览计算器' });
  const occupied = createServer(); await new Promise(resolve => occupied.listen(port, '127.0.0.1', resolve));
  try {
    const id = await f.manager.prepare(f.project.id, f.paths.work), state = f.manager.snapshot(f.project.id);
    assert.equal(state.configSource, 'repository'); assert.equal(state.config, null);
    assert.equal(state.release.config.port, port); assert.notEqual(state.release.port, port);
    assert.equal(state.release.status, 'verified'); assert.equal(occupied.listening, true);
    f.manager.publish(id);
    await assert.rejects(f.manager.startPreview(id, port), /EADDRINUSE/);
    assert.equal(occupied.listening, true);
    f.store.saveDelivery(f.project.id, { kind: 'source', instructions: '人工设置' });
    assert.equal(f.manager.snapshot(f.project.id).configSource, 'saved');
    assert.equal(f.manager.snapshot(f.project.id).config.kind, 'source');
    f.store.saveDelivery(f.project.id, undefined);
    assert.equal(f.manager.snapshot(f.project.id).config, null);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

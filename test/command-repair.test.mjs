// 本文件验证真实 Windows 命令传参及验收命令修订的事务边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../lib/runtime.mjs';
import { windowsArguments } from '../lib/command.mjs';
import { Store } from '../lib/store.mjs';
import { validateWork, validateEvaluation, validateDispatch } from '../lib/protocol.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Windows 参数解析保留脚本变量、空参数、空格路径及嵌入引号', () => {
  assert.deepEqual(windowsArguments('"C:\\Program Files\\pwsh.exe" -Command "$b=1; foreach ($i in @(1)) { Write-Output $i }"'), ['C:\\Program Files\\pwsh.exe', '-Command', '$b=1; foreach ($i in @(1)) { Write-Output $i }']);
  assert.deepEqual(windowsArguments('node "" "a\\\"b"'), ['node', '', 'a"b']);
  assert.throws(() => windowsArguments('node "unfinished'), /未闭合/);
});

test('真实 PowerShell 不经外层展开，变量及非零退出码完整保留', { skip: process.platform !== 'win32' }, async () => {
  const runtime = new Runtime('.');
  let output = '';
  const handle = await runtime.command('powershell -NoProfile -Command "$b=@(1,2); foreach ($i in $b) { Write-Output ($i+40) }; exit 7"', process.cwd(), (_, line) => { output += line + '\n'; });
  const result = await handle.done;
  assert.equal(result.error, ''); assert.equal(result.code, 7);
  assert.match(output, /41\r?\n42/);
});

test('Windows 普通命令保留引号、中文、组合命令及失败退出码', { skip: process.platform !== 'win32' }, async () => {
  const runtime = new Runtime('.');
  let output = '';
  const handle = await runtime.command('node -e "console.log(\'中文 space $b\')" && node -e "process.exit(9)"', process.cwd(), (_, line) => { output += line; });
  const result = await handle.done;
  assert.equal(result.error, ''); assert.equal(result.code, 9);
  assert.match(output, /中文 space \$b/);
});

test('脚本路径含空格时 PowerShell File 与 npm 批处理入口均能执行', { skip: process.platform !== 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'goalhub-command-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'verify scope.ps1'), 'exit 6');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(8)"' } }));
  const runtime = new Runtime('.');
  for (const [command, expected] of [['powershell -NoProfile -ExecutionPolicy Bypass -File "verify scope.ps1"', 6], ['npm run verify', 8]]) {
    const handle = await runtime.command(command, directory, () => {});
    const result = await handle.done;
    assert.equal(result.error, ''); assert.equal(result.code, expected);
  }
});

// fixture 用独立数据库保留真实目标和任务编号，避免跨项目修订。
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const project = store.create({ name: '修订测试', goal: '验证结果', settings: {} });
  store.plan(project.id, { summary: '计划', tasks: [{ id: 'task', title: '任务', description: '验证', checkIds: ['a'], assignee: 'developer' }], checks: [{ id: 'a', title: '验收', command: 'old', expectation: '结果为42' }, { id: 'b', title: '其他', command: 'other', expectation: '不变' }] });
  const check = store.checks(project.id)[0], task = store.tasks(project.id)[0];
  return { store, project, check, task, update: { id: check.id, previousCommand: 'old', command: 'new', reason: '修复引用脚本' } };
}

test('修订原子保存、清除旧结论、保留验收目标和审计证据', t => {
  const f = fixture(t);
  f.store.check(f.check.id, 'failed', '旧错误');
  f.store.reviseChecks(f.project.id, [f.update], { taskId: f.task.id, source: 'developer' });
  const check = f.store.checks(f.project.id)[0];
  assert.equal(check.command, 'new'); assert.equal(check.expectation, '结果为42');
  assert.equal(check.status, 'pending'); assert.equal(check.output, '');
  const event = f.store.events(f.project.id, { kind: 'check.command.updated' })[0];
  assert.equal(JSON.parse(event.content).previousCommand, 'old');
  assert.throws(() => f.store.reviseChecks(f.project.id, [f.update]), /已变更/);
});

test('越界、过期及批量非法修订全部回滚，不留下半份命令', t => {
  const f = fixture(t);
  for (const bad of [{ ...f.update, id: 'foreign' }, { ...f.update, id: f.store.checks(f.project.id)[1].id, previousCommand: 'other' }]) {
    assert.throws(() => f.store.reviseChecks(f.project.id, [f.update, bad], { taskId: f.task.id }), /当前任务/);
    assert.equal(f.store.checks(f.project.id)[0].command, 'old');
    assert.equal(f.store.events(f.project.id, { kind: 'check.command.updated' }).length, 0);
  }
});

test('所有修复阶段接收结构化修订，评估不能边换命令边宣布完成', t => {
  const { update } = fixture(t);
  for (const [validate, reply] of [[validateWork, { status: 'done' }], [validateDispatch, { assignee: 'developer' }], [validateEvaluation, { action: 'repair', repair: '修复命令' }]]) {
    assert.deepEqual(validate(JSON.stringify({ ...reply, summary: '修复', checkUpdates: [update] })).checkUpdates, [update]);
    assert.throws(() => validate(JSON.stringify({ ...reply, summary: '修复', checkUpdates: [{ ...update, expectation: '绕过目标' }] })), /不支持/);
  }
  assert.throws(() => validateEvaluation(JSON.stringify({ action: 'complete', summary: '完成', checkUpdates: [update] })), /重新执行/);
});

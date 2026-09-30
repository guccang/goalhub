// 本文件验证 Markdown 是任务正文的唯一来源，数据库仅保留索引和运行事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { documentText, parseDocument, handoffSections } from '../lib/task-documents.mjs';
import { organizeContext } from '../lib/context.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';
import { createApp } from '../lib/app.mjs';
import { taskDocumentLinks, taskDocumentUrl } from '../public/task-documents.js';

// fixture 创建两个前后衔接的员工分工，实际文件位于测试专属目录。
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'goalhub-doc-test-')), path = join(root, 'state.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = store.create({ name: '交接', goal: '接入资源', settings: {} });
  const input = store.requirementInput(project.id);
  store.plan(project.id, { summary: '设计后开发', requirements: { summary: '当前需求', included: ['接入资源'], deferred: [], excluded: [], sourceRevision: input.revision, sourceIds: ['goal'] },
    tasks: [{ id: 'design', title: '设计', description: '设计资源映射', assignee: 'developer', checkIds: ['check'] }, { id: 'implementation', title: '开发', description: '按前置设计实现', assignee: 'quality', dependsOn: ['design'], checkIds: ['check'] }],
    checks: [{ id: 'check', title: '运行验证', command: 'node verify.mjs', expectation: '资源可用' }] });
  return { project, path, get store() { return store; }, reopen() { store.close(); store = new Store(path); }, root };
}

test('同一总任务共用 taskId 与时间目录，分工与文件名独立且使用英文', t => {
  const f = fixture(t), tasks = f.store.tasks(f.project.id), group = f.store.documentGroup(f.project.id);
  assert.equal(tasks[0].taskId, tasks[1].taskId); assert.notEqual(tasks[0].assignmentId, tasks[1].assignmentId);
  assert.match(group.directory, /[a-f0-9-]{36}_\d{8}_\d{6}$/);
  for (const path of readdirSync(group.directory, { recursive: true })) assert.doesNotMatch(String(path), /[\u3400-\u9fff]/);
  f.reopen(); assert.equal(f.store.documentGroup(f.project.id).directory, group.directory);
});

test('修改 Markdown 后立即读取最新正文，数据库旧副本不参与员工交接', t => {
  const f = fixture(t), tasks = f.store.tasks(f.project.id), first = tasks[0];
  writeFileSync(first.documents.assignment, readFileSync(first.documents.assignment, 'utf8').replace('设计资源映射', '文件中最新分工'));
  writeFileSync(first.documents.handoff, readFileSync(first.documents.handoff, 'utf8').replace('尚未提交实现说明。', '接口位于 game/lpc.gd，待后续实测。'));
  f.store.db.prepare('UPDATE tasks SET description=?,result=?,handoff=? WHERE id=?').run('数据库旧正文', '旧完成摘要', '旧交接', first.id);
  const current = f.store.tasks(f.project.id);
  assert.equal(current[0].description, '文件中最新分工'); assert.match(current[0].handoff, /game\/lpc.gd/);
  const engine = new Orchestrator({ store: f.store, runtime: {}, git: { paths() { return { repo: f.root }; } } });
  const input = organizeContext(JSON.parse(engine.context(f.project.id)), 'developer', current[1]);
  assert.match(JSON.stringify(input), /game\/lpc.gd/); assert.doesNotMatch(JSON.stringify(input), /数据库旧正文|旧完成摘要|旧交接/);
});

test('文件勾选与员工交接不会把平台任务或验收状态改成完成', t => {
  const f = fixture(t), task = f.store.tasks(f.project.id)[0];
  writeFileSync(task.documents.plan, '- [x] 已完成\n- [x] 已验证');
  f.store.saveWorkHandoff(f.project.id, task.id, { status: 'done', summary: '员工自述完成' });
  assert.equal(f.store.tasks(f.project.id)[0].status, 'pending');
  assert.equal(f.store.checks(f.project.id)[0].status, 'pending');
  assert.match(readFileSync(task.documents.handoff, 'utf8'), /员工自述完成/);
});

test('文档缺失明确失败，重启不悄悄从 SQLite 恢复旧正文', t => {
  const f = fixture(t), task = f.store.tasks(f.project.id)[0]; unlinkSync(task.documents.handoff);
  f.reopen(); assert.throws(() => f.store.tasks(f.project.id), /ENOENT/);
});

test('验收命令来自文件，变更后旧通过结论失效；无效批次不留下半份修改', t => {
  const f = fixture(t), check = f.store.checks(f.project.id)[0], group = f.store.documentGroup(f.project.id);
  f.store.check(check.id, 'passed', '曾通过');
  const path = join(group.directory, 'checks', check.id + '.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('node verify.mjs', 'node new-verify.mjs'));
  const next = f.store.checks(f.project.id)[0];
  assert.equal(next.command, 'node new-verify.mjs'); assert.equal(next.status, 'pending');
  assert.throws(() => f.store.reviseChecks(f.project.id, [
    { id: check.id, previousCommand: next.command, command: 'node third.mjs', reason: '修订' },
    { id: 'missing', previousCommand: 'x', command: 'y', reason: '非法' },
  ]), /只能修订/);
  assert.equal(f.store.checks(f.project.id)[0].command, next.command);
});

test('需求以 MD 为准，新决定更新来源并使旧有效需求失效', t => {
  const f = fixture(t), group = f.store.documentGroup(f.project.id), path = join(group.directory, 'requirements.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace('当前需求', '文件最新需求'));
  assert.equal(f.store.requirementSnapshot(f.project.id).summary, '文件最新需求');
  const before = f.store.requirementInput(f.project.id).revision;
  f.store.instruction(f.project.id, '增加新的角色外观');
  assert.notEqual(f.store.requirementInput(f.project.id).revision, before);
  assert.match(readFileSync(join(group.directory, 'sources.md'), 'utf8'), /增加新的角色外观/);
  assert.equal(f.store.detail(f.project.id).requirements.status, 'needs-consolidation');
});

test('文档端点可查看固定文件并拒绝跨目标、路径穿越', async t => {
  const f = fixture(t), task = f.store.tasks(f.project.id)[0];
  const app = createApp({ store: f.store, runtime: {}, git: {}, orchestrator: { controls: new Map() } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}/api/projects/${f.project.id}/task-documents`;
  const response = await fetch(`${base}?assignmentId=${task.id}&file=handoff.md`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/plain/);
  for (const heading of handoffSections) assert.match(await f.store.documents.read(task.documents.handoff), new RegExp('## ' + heading));
  assert.equal((await fetch(`${base}?file=../../goalhub.sqlite`)).status, 400);
  assert.equal((await fetch(`${base}?assignmentId=not-this-task`)).status, 404);
  assert.match(taskDocumentLinks(f.store.detail(f.project.id), task), /assignmentId=/);
  const planUrl = taskDocumentUrl(f.store.detail(f.project.id), task, 'plan.md');
  assert.match(await (await fetch(`http://127.0.0.1:${app.address().port}${planUrl}`)).text(), /# Plan/);
});

test('写入日志在重启后重放，保留固定格式和代码块内的标题', t => {
  const f = fixture(t), group = f.store.documentGroup(f.project.id), task = f.store.tasks(f.project.id)[0];
  const doc = parseDocument(readFileSync(task.documents.handoff, 'utf8'), handoffSections);
  doc.sections.Implementation = '接口示例\n```md\n## Next\n```\n恢复后存在';
  const text = documentText('Handoff', doc.metadata, doc.sections);
  const files = { [f.store.documents.assignmentRelative(group, task.id, 'handoff.md')]: text };
  writeFileSync(join(group.directory, 'transaction.md'), documentText('Document transaction', { files }, { Recovery: '恢复' }));
  f.reopen(); assert.match(f.store.tasks(f.project.id)[0].handoff, /恢复后存在/);
  assert.equal(parseDocument(text, handoffSections).sections.Next, doc.sections.Next);
});

test('平台事务回滚时恢复旧文档，提交后文件与状态同时保留', t => {
  const f = fixture(t), group = f.store.documentGroup(f.project.id), task = f.store.tasks(f.project.id)[0];
  const old = readFileSync(task.documents.handoff, 'utf8');
  f.store.db.exec('BEGIN');
  f.store.documents.batch(group.directory, { [f.store.documents.assignmentRelative(group, task.id, 'handoff.md')]: old.replace('尚未提交实现说明。', '未提交的结果') });
  f.store.db.exec('ROLLBACK');
  f.store.documents.finishPublications();
  assert.equal(readFileSync(task.documents.handoff, 'utf8'), old);
  f.store.db.exec('BEGIN');
  f.store.documents.batch(group.directory, { [f.store.documents.assignmentRelative(group, task.id, 'handoff.md')]: old.replace('尚未提交实现说明。', '正式提交的结果') });
  f.store.db.exec('COMMIT');
  // 故意不清理事务日志，重启根据已提交标识完成恢复。
  f.reopen();
  assert.match(f.store.tasks(f.project.id)[0].handoff, /正式提交的结果/);
});

// 目录名是稳定展示名称，内部身份保持 UUID，旧引用迁移后仍能读取相同正文。
test('分工目录采用时间与四位随机数字，改派重启后稳定，旧目录可重复迁移', t => {
  const f = fixture(t), task = f.store.tasks(f.project.id)[0], group = f.store.documentGroup(f.project.id);
  const name = f.store.documents.assignmentDirectory(group, task.id);
  assert.match(name, /^\d{8}-\d{6}-\d{4}$/);
  f.store.assignTask(f.project.id, task.id, 'quality', '改派');
  assert.equal(f.store.documents.assignmentDirectory(group, task.id), name);
  f.reopen();
  assert.equal(f.store.documents.assignmentDirectory(group, task.id), name);
  const newRoot = join(group.directory, 'assignments', name), legacy = join(group.directory, 'assignments', task.id);
  renameSync(newRoot, legacy);
  f.store.db.prepare('DELETE FROM task_assignment_directories WHERE goal_id=? AND assignment_id=?').run(group.goal_id, task.id);
  const source = join(group.directory, 'handoff.md');
  writeFileSync(source, readFileSync(source, 'utf8').replaceAll(`assignments/${name}/`, `assignments/${task.id}/`));
  writeFileSync(join(legacy, 'evidence', 'notes.md'), '真实证据');
  f.store.documents.migrateAssignmentDirectories(group);
  const migrated = f.store.documents.assignmentDirectory(group, task.id);
  assert.match(migrated, /^\d{8}-\d{6}-\d{4}$/);
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(group.directory, 'assignments', migrated, 'evidence', 'notes.md'), 'utf8'), '真实证据');
  assert.ok(readFileSync(source, 'utf8').includes(`assignments/${migrated}/handoff.md`));
  f.store.documents.migrateAssignmentDirectories(group);
  assert.equal(f.store.documents.assignmentDirectory(group, task.id), migrated);
  assert.equal(f.store.tasks(f.project.id)[0].id, task.id);
});

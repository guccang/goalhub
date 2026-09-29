// 本文件管理任务的英文 Markdown 文档；正文从文件读取，SQLite 仅定位目录和保存执行状态。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, lstatSync, openSync, closeSync, fsyncSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { requirementSources } from './context.mjs';
import { randomUUID, randomInt } from 'node:crypto';

export const handoffSections = ['Identity', 'Requirements', 'Implementation', 'Verification', 'Remaining', 'Next'];

// documentText 生成固定章节；结构化标识不和员工可自由书写的正文混在一起。
export function documentText(title, metadata, sections) {
  return `# ${title}\n\n<!-- task-metadata -->\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n<!-- /task-metadata -->\n` + Object.entries(sections).map(([heading, body]) => `\n## ${heading}\n\n${body || ''}\n`).join('');
}

// parseDocument 只解析固定元数据和二级章节，代码块里的标题不参与解析。
export function parseDocument(text, headings) {
  const match = text.match(/<!-- task-metadata -->\s*```json\r?\n([\s\S]*?)\r?\n```\s*<!-- \/task-metadata -->/);
  if (!match) throw new Error('任务文档缺少 task-metadata，不能使用旧数据库正文替代');
  const metadata = JSON.parse(match[1]), sections = {};
  let current = '', fence = '';
  for (const line of text.slice(match.index + match[0].length).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = ''; }
    const heading = !fence && line.match(/^## ([A-Za-z][A-Za-z0-9 ]*)\s*$/);
    if (heading && headings.includes(heading[1])) {
      current = heading[1];
      if (Object.hasOwn(sections, current)) throw new Error(`任务文档章节重复：${current}`);
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  for (const heading of headings) if (!Object.hasOwn(sections, heading)) throw new Error(`任务文档缺少章节：${heading}`);
  return { metadata, sections: Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()])) };
}

// timestamp 使用首次派发的本地时间，重试和重新分工均复用目录。
function timestamp(value) {
  const date = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// bullets 将需求列表序列化为可读清单，续行缩进不产生额外条目。
function bullets(items = []) { return items.map(item => '- ' + item.replaceAll('\n', '\n  ')).join('\n'); }

// listItems 恢复需求清单，空章节表示无此类要求。
function listItems(text) { return text ? text.split(/\n(?=- )/).map(item => item.replace(/^- /, '').replace(/\n  /g, '\n').trim()).filter(Boolean) : []; }

export class TaskDocuments {
  // constructor 建立轻量目录索引，文档正文不会从索引表读取。
  constructor(root, db) {
    this.root = resolve(root); this.db = db; this.pending = new Set();
    mkdirSync(this.root, { recursive: true });
    db.exec(`CREATE TABLE IF NOT EXISTS task_document_groups (goal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, directory TEXT NOT NULL, created_at TEXT NOT NULL);`);
    db.exec('CREATE TABLE IF NOT EXISTS task_assignment_directories (goal_id TEXT NOT NULL, assignment_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(goal_id, assignment_id), UNIQUE(goal_id, name))');
    db.exec('CREATE TABLE IF NOT EXISTS task_document_publications (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    // 同时扫描未建立目录索引就发生中断的首次迁移，不能遗漏未提交的文档事务。
    for (const entry of readdirSync(this.root, { withFileTypes: true })) if (entry.isDirectory() && /^[a-f0-9-]{36}_\d{8}_\d{6}$/.test(entry.name)) this.recover(join(this.root, entry.name));
  }
  // safe 限制文档操作在受管根目录内，拒绝符号链接跳转和目录穿越。
  safe(path) {
    const target = resolve(path), within = value => { const rel = relative(this.root, value); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
    if (!within(target)) throw new Error('任务文档路径超出受管目录');
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!within(realpathSync(ancestor))) throw new Error('任务文档路径包含越界链接');
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('任务文档不能是符号链接');
    return target;
  }
  // read 每次直接读取磁盘，使后续员工看到最新交接正文。
  read(path) { return readFileSync(this.safe(path), 'utf8'); }
  // write 同目录原子替换，避免读取半份文档。
  write(path, text) {
    path = this.safe(path); mkdirSync(dirname(path), { recursive: true });
    const temporary = this.safe(path + '.tmp');
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  }
  // batch 先保存可重放日志，重启时完成被中断的多文件更新。
  batch(directory, files) {
    const journal = join(directory, 'transaction.md');
    const previousJournal = existsSync(journal) ? parseDocument(this.read(journal), ['Recovery']).metadata : null;
    const previous = previousJournal?.previous || {};
    for (const name of Object.keys(files)) if (!Object.hasOwn(previous, name)) {
      const path = this.safe(join(directory, name)); previous[name] = existsSync(path) ? this.read(path) : null;
    }
    const publicationId = previousJournal?.publicationId || randomUUID();
    const next = { publicationId, previous, files: { ...previousJournal?.files, ...files } };
    this.pending.add(directory);
    this.write(journal, documentText('Document transaction', next, { Recovery: '此文件由平台恢复，勿手动修改。' }));
    // 此标记与平台状态处于同一 SQLite 事务，重启后据此选择完成写入或恢复旧文件。
    this.db.prepare('INSERT OR IGNORE INTO task_document_publications VALUES(?,?)').run(publicationId, new Date().toISOString());
    this.apply(directory, files);
    if (!this.db.isTransaction) this.finishPublications();
  }
  // recover 重放持久化写入，不依赖运行日志或旧数据库正文。
  recover(directory) {
    const journal = this.safe(join(directory, 'transaction.md'));
    if (!existsSync(journal)) return;
    const { metadata } = parseDocument(this.read(journal), ['Recovery']);
    const committed = !metadata.publicationId || this.db.prepare('SELECT 1 FROM task_document_publications WHERE id=?').get(metadata.publicationId);
    this.apply(directory, committed ? metadata.files : metadata.previous);
    unlinkSync(journal);
  }
  // apply 只写入或恢复任务目录内受管文件，不能被日志中的路径越权。
  apply(directory, files) {
    for (const [name, text] of Object.entries(files)) {
      if (!/^[a-zA-Z0-9_./-]+\.md$/.test(name) || name.split('/').includes('..')) throw new Error('非法任务文档文件名');
      const path = resolve(directory, name);
      if (relative(directory, path).startsWith('..')) throw new Error('非法事务文件路径');
      if (text === null) { if (existsSync(this.safe(path))) unlinkSync(path); }
      else this.write(path, text);
    }
  }
  // finishPublications 必须在平台事务提交或回滚后调用，按真实提交状态清理日志。
  finishPublications() {
    if (this.db.isTransaction) return;
    for (const directory of this.pending) this.recover(directory);
    this.pending.clear();
  }
  // group 同一个主管目标作为共享 taskId，原 tasks.id 作为独立 assignmentId。
  group(projectId, goalId) {
    if (!goalId) return null;
    let row = this.db.prepare('SELECT * FROM task_document_groups WHERE goal_id=? AND project_id=?').get(goalId, projectId);
    if (row) return row;
    const goal = this.db.prepare('SELECT * FROM goals WHERE id=? AND project_id=?').get(goalId, projectId);
    if (!goal) throw new Error('任务目标不存在');
    const created = goal.created_at || new Date().toISOString();
    const directory = join(this.root, `${goalId}_${timestamp(created)}`);
    mkdirSync(this.safe(directory), { recursive: true });
    row = { goal_id: goalId, project_id: projectId, task_id: goalId, directory, created_at: created };
    // 只有首次迁移允许读取旧正文；索引建立后文件缺失会明确报错，绝不回退数据库。
    const tasks = this.db.prepare('SELECT * FROM tasks WHERE project_id=? AND goal_id=? ORDER BY position').all(projectId, goalId);
    const checks = this.db.prepare('SELECT * FROM checks WHERE project_id=? AND goal_id=? ORDER BY rowid').all(projectId, goalId);
    const snapshot = this.db.prepare('SELECT content FROM requirement_snapshots WHERE goal_id=?').get(goalId);
    const requirement = snapshot ? JSON.parse(snapshot.content) : null;
    const files = this.planFiles(row, tasks, checks, requirement, goal.plan_summary || '', true);
    const modules = JSON.parse(this.db.prepare('SELECT content FROM goal_modules WHERE goal_id=?').get(goalId)?.content || '[]');
    files['modules.md'] = documentText('Modules', { taskId: goalId, modules }, { Overview: modules.map(item => `- ${item.title}: ${item.scope}`).join('\n') || '暂无模块分组。' });
    const saved = JSON.parse(goal.snapshot);
    const sources = requirementSources({ goalId, goal: saved.goal || '', projectContext: saved.settings?.context || '', questions: this.db.prepare('SELECT * FROM questions WHERE project_id=? AND goal_id=?').all(projectId, goalId), instructions: this.db.prepare('SELECT * FROM instructions WHERE project_id=? AND goal_id=? ORDER BY id').all(projectId, goalId) });
    files['sources.md'] = this.sourcesText(row, sources.sources, saved.settings?.context || '');
    this.batch(directory, files);
    this.db.prepare('INSERT INTO task_document_groups VALUES(?,?,?,?,?)').run(goalId, projectId, goalId, directory, created);
    return row;
  }
  // assignmentDirectory 独立保存展示目录名，重试、改派和重启不改变分工编号及目录。
  assignmentDirectory(group, id, migrate = false) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('非法分工编号');
    const legacy = this.safe(join(group.directory, 'assignments', id));
    let row = this.db.prepare('SELECT name FROM task_assignment_directories WHERE goal_id=? AND assignment_id=?').get(group.goal_id, id);
    if (!row && existsSync(legacy) && !migrate) return id;
    if (!row) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const name = timestamp(new Date()).replace('_', '-') + '-' + String(randomInt(10000)).padStart(4, '0');
        if (existsSync(this.safe(join(group.directory, 'assignments', name)))) continue;
        const result = this.db.prepare('INSERT OR IGNORE INTO task_assignment_directories VALUES(?,?,?)').run(group.goal_id, id, name);
        if (result.changes) { row = { name }; break; }
      }
      if (!row) throw new Error('分工目录分配失败，请重试');
    }
    if (!/^\d{8}-\d{6}-\d{4}$/.test(row.name)) throw new Error('非法分工目录索引');
    const target = this.safe(join(group.directory, 'assignments', row.name));
    // 先持久化映射再原子改名，中途退出后可按原映射继续，不重新生成随机数。
    if (existsSync(legacy)) {
      if (this.db.isTransaction) throw new Error('旧分工目录需要在事务外迁移');
      if (existsSync(target)) throw new Error('新旧分工目录同时存在，拒绝覆盖');
      renameSync(legacy, target);
    }
    return row.name;
  }
  // assignmentRelative 所有发布和链接共用同一目录映射，避免重新写回 UUID 目录。
  assignmentRelative(group, id, file = 'assignment.md') { return `assignments/${this.assignmentDirectory(group, id)}/${file}`; }
  // assignmentPath 定位共享任务下的一个独立分工。
  assignmentPath(group, id, file = 'assignment.md') { return join(group.directory, this.assignmentRelative(group, id, file)); }
  // migrateAssignmentDirectories 仅在停止员工后执行，保留正文、证据及历史文件并更新 Markdown 引用。
  migrateAssignmentDirectories(group) {
    if (this.db.isTransaction) throw new Error('目录迁移不能在事务中运行');
    this.recover(group.directory);
    const root = this.safe(join(group.directory, 'assignments'));
    if (!existsSync(root)) return [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name)) this.assignmentDirectory(group, entry.name, true);
    }
    const mappings = this.db.prepare('SELECT assignment_id,name FROM task_assignment_directories WHERE goal_id=?').all(group.goal_id);
    // rewrite 递归修订 Markdown 中的路径，身份证明和数据库历史不做替换。
    const rewrite = directory => {
      for (const entry of readdirSync(this.safe(directory), { withFileTypes: true })) {
        const path = this.safe(join(directory, entry.name));
        if (entry.isDirectory()) rewrite(path);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const original = this.read(path);
          let text = original;
          for (const row of mappings) {
            text = text.replaceAll(`../${row.assignment_id}/`, `../${row.name}/`)
              .replaceAll(`assignments/${row.assignment_id}/`, `assignments/${row.name}/`)
              .replaceAll(`assignments\\${row.assignment_id}\\`, `assignments\\${row.name}\\`);
          }
          if (path === join(group.directory, 'handoff.md')) for (const row of mappings) text = text.replaceAll(` · assignmentId: ${row.assignment_id}`, '');
          if (text !== original) this.write(path, text);
        }
      }
    };
    rewrite(group.directory);
    return mappings;
  }
  // assignmentText 使用固定章节保存分工正文与调度所需依赖标识。
  assignmentText(group, task) {
    const spec = typeof task.spec === 'string' ? JSON.parse(task.spec) : task.spec || {};
    return documentText('Assignment', { taskId: group.task_id, assignmentId: task.id, version: task.version || 1, assignee: task.assignee, dependsOn: typeof task.depends_on === 'string' ? JSON.parse(task.depends_on) : task.depends_on || [], checkIds: typeof task.check_ids === 'string' ? JSON.parse(task.check_ids) : task.check_ids || [], requiredCapability: task.required_capability || 'development', phase: spec.phase || 'implementation', module: spec.module || '' }, { Title: task.title, Description: task.description, 'Done When': task.done_when || task.description, Scope: spec.scope || '', Inputs: spec.inputs || '', Outputs: spec.outputs || '' });
  }
  // handoffText 迁移旧摘要时明确证据边界，绝不把旧文本包装成新验收。
  handoffText(group, task, summary = '', legacy = false) {
    return documentText('Handoff', { taskId: group.task_id, assignmentId: task.id, version: task.version || 1, employeeId: task.assignee || '', updatedAt: new Date().toISOString() }, {
      Identity: `taskId: ${group.task_id}\nassignmentId: ${task.id}\nemployeeId: ${task.assignee || '未分配'}`,
      Requirements: '[assignment.md](assignment.md)\n[requirements.md](../../requirements.md)',
      Implementation: summary || '尚未提交实现说明。',
      Verification: legacy ? '由历史交接迁移。原执行记录仅作历史证据，未在迁移时重新测试。' : '尚未提交验证证据。',
      Remaining: legacy ? '请根据上面的历史结果和当前需求核对剩余工作。' : '按 assignment.md 完成并验证本轮分工。',
      Next: '接手员工先核对当前需求、前置交接及引用的证据，再执行自己的分工。',
    });
  }
  // requirementsText 需求正文采用 Markdown 清单，元数据仅保存来源与身份。
  requirementsText(group, value) {
    return documentText('Requirements', { taskId: group.task_id, sourceRevision: value?.sourceRevision || '', sourceIds: value?.sourceIds || [], consolidated: !!value }, { Summary: value?.summary || '等待主管整理当前需求。', Included: bullets(value?.included), Deferred: bullets(value?.deferred), Excluded: bullets(value?.excluded) });
  }
  // sourcesText 将用户决定逐条保存成正文，元数据仅记录身份、时间和问题原文。
  sourcesText(group, sources, background) {
    return documentText('Requirement sources', { taskId: group.task_id, sources: sources.map(({ content, ...identity }) => identity) }, { Background: background || '', ...Object.fromEntries(sources.map((source, index) => [`Source ${index + 1}`, source.content])) });
  }
  // sources 直接读取需求来源文档，后台旧问答摘要不覆盖已经保存的用户决定。
  sources(group) {
    const text = this.read(join(group.directory, 'sources.md'));
    const first = parseDocument(text, ['Background']);
    const headings = first.metadata.sources.map((_, index) => `Source ${index + 1}`);
    const parsed = parseDocument(text, ['Background', ...headings]);
    if (parsed.metadata.taskId !== group.task_id) throw new Error('需求来源不属于当前任务');
    return { background: parsed.sections.Background, sources: first.metadata.sources.map((source, index) => ({ ...source, content: parsed.sections[headings[index]] })) };
  }
  // planFiles 准备主管发布的文档，既有交接保留；分工版本变化时归档旧版。
  planFiles(group, tasks, checks, requirement, summary, migration = false) {
    const files = { 'requirements.md': this.requirementsText(group, requirement) };
    files['handoff.md'] = documentText('Supervisor handoff', { taskId: group.task_id, updatedAt: new Date().toISOString() }, { Identity: `taskId: ${group.task_id}`, Requirements: '[requirements.md](requirements.md)', Implementation: summary || '主管尚未发布分工。', Verification: '各分工的验收状态由平台执行记录确定；本目录文档为员工报告。', Remaining: tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled').map(t => `- ${t.title}`).join('\n') || '暂无待执行分工。', Next: tasks.map(t => `- [${t.title}](${this.assignmentRelative(group, t.id, 'handoff.md')})`).join('\n') || '等待主管派发。' });
    for (const task of tasks) {
      const prefix = `assignments/${this.assignmentDirectory(group, task.id)}/`, existing = this.assignmentPath(group, task.id, 'handoff.md');
      files[prefix + 'assignment.md'] = this.assignmentText(group, task);
      if (!existsSync(existing)) files[prefix + 'handoff.md'] = this.handoffText(group, task, task.handoff || task.result || '', migration);
      else {
        const old = parseDocument(this.read(existing), handoffSections);
        if (old.metadata.version !== (task.version || 1)) {
          files[prefix + `history/v${old.metadata.version}/handoff.md`] = this.read(existing);
          files[prefix + 'handoff.md'] = this.handoffText(group, task);
        }
      }
      mkdirSync(this.safe(join(group.directory, prefix, 'evidence')), { recursive: true });
      if (!existsSync(this.assignmentPath(group, task.id, 'plan.md'))) files[prefix + 'plan.md'] = '# Plan\n\n- [ ] 完成本次分工\n- [ ] 验证本次分工\n';
    }
    for (const check of checks) files[`checks/${check.id}.md`] = documentText('Acceptance check', { taskId: group.task_id, checkId: check.id }, { Title: check.title, Command: check.command, Expectation: check.expectation });
    return files;
  }
  // requirements 每轮直接解析需求文件，缺少文件时拒绝使用历史副本。
  requirements(group) {
    const { metadata, sections } = parseDocument(this.read(join(group.directory, 'requirements.md')), ['Summary', 'Included', 'Deferred', 'Excluded']);
    if (metadata.taskId !== group.task_id) throw new Error('需求文档不属于当前任务');
    if (!metadata.consolidated) return null;
    return { summary: sections.Summary, sourceRevision: metadata.sourceRevision, sourceIds: metadata.sourceIds, included: listItems(sections.Included), deferred: listItems(sections.Deferred), excluded: listItems(sections.Excluded) };
  }
  // assignment 以文件为正文来源，并将共享编号与可查看路径交给页面。
  assignment(group, row) {
    const path = this.assignmentPath(group, row.id), handoffPath = this.assignmentPath(group, row.id, 'handoff.md');
    const { metadata: meta, sections: s } = parseDocument(this.read(path), ['Title', 'Description', 'Done When', 'Scope', 'Inputs', 'Outputs']);
    if (meta.taskId !== group.task_id || meta.assignmentId !== row.id || meta.version !== row.version) throw new Error('分工文档身份或版本不匹配');
    const handoff = this.read(handoffPath), parsed = parseDocument(handoff, handoffSections);
    if (parsed.metadata.taskId !== group.task_id || parsed.metadata.assignmentId !== row.id || parsed.metadata.version !== row.version) throw new Error('交接文档身份或版本不匹配');
    return { ...row, taskId: group.task_id, assignmentId: row.id, title: s.Title, description: s.Description, done_when: s['Done When'], assignee: meta.assignee, depends_on: meta.dependsOn, check_ids: meta.checkIds, required_capability: meta.requiredCapability, spec: JSON.stringify({ module: meta.module, phase: meta.phase, scope: s.Scope, inputs: s.Inputs, outputs: s.Outputs }), handoff, documents: { directory: group.directory, assignment: path, handoff: handoffPath, requirements: join(group.directory, 'requirements.md'), plan: this.assignmentPath(group, row.id, 'plan.md') } };
  }
  // check 从 Markdown 获取验收命令和预期，不把旧命令当成本轮输入。
  check(group, row) {
    const { metadata, sections } = parseDocument(this.read(join(group.directory, 'checks', row.id + '.md')), ['Title', 'Command', 'Expectation']);
    if (metadata.taskId !== group.task_id || metadata.checkId !== row.id || !sections.Command) throw new Error('验收文档身份或命令无效');
    return { ...row, title: sections.Title, command: sections.Command, expectation: sections.Expectation };
  }
}


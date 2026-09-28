// 本文件使用 SQLite 保存项目状态、任务、验收、问答和每轮 Agent 的输入输出。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// redact 遮蔽日志中常见的凭据，避免诊断信息直接暴露给页面。
export function redact(value) {
  return String(value ?? '').replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/gi, '$1[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}\b/g, '[已隐藏]');
}

// decode 将数据库中的 JSON 字段还原为业务对象。
function decode(row) {
  if (!row) return null;
  const value = { ...row };
  for (const key of ['settings', 'check_ids']) if (key in value) value[key] = JSON.parse(value[key]);
  return value;
}

export class Store {
  // constructor 初始化持久化表与索引，并使用 WAL 支持记录查询。
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        settings TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', resume_phase TEXT NOT NULL DEFAULT 'plan',
        failures INTEGER NOT NULL DEFAULT 0, next_evaluation TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), position INTEGER NOT NULL,
        title TEXT NOT NULL, description TEXT NOT NULL, check_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS checks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
        command TEXT NOT NULL, expectation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '', checked_at TEXT);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL,
        input TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running', process_id INTEGER, created_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT,
        kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), prompt TEXT NOT NULL,
        answer TEXT, created_at TEXT NOT NULL, answered_at TEXT);
      CREATE TABLE IF NOT EXISTS commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
        hash TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
        content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_project_role ON runs(project_id,role,created_at);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);`);
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'process_id')) this.db.exec('ALTER TABLE runs ADD COLUMN process_id INTEGER');
  }

  // create 保存目标和调度参数，尚不启动模型调用。
  create({ name, goal, settings }) {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare('INSERT INTO projects(id,name,goal,status,settings,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, name, goal, 'paused', JSON.stringify(settings), now, now);
    this.event(id, 'goal.created', goal);
    return this.project(id);
  }

  // project 查询一个项目。
  project(id) { return decode(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }

  // list 返回项目列表及实际任务进度。
  list() {
    return this.db.prepare(`SELECT p.*, (SELECT count(*) FROM tasks WHERE project_id=p.id) task_count,
      (SELECT count(*) FROM tasks WHERE project_id=p.id AND status='done') done_count
      FROM projects p ORDER BY p.created_at DESC`).all().map(decode);
  }

  // update 仅允许修改明确列出的项目字段。
  update(id, values) {
    const allowed = ['status', 'summary', 'resume_phase', 'failures', 'next_evaluation'];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE projects SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id);
  }

  // event 记录一个按时间排列的安全文本事件。
  event(projectId, kind, content, runId = null) {
    this.db.prepare('INSERT INTO events(project_id,run_id,kind,content,created_at) VALUES(?,?,?,?,?)')
      .run(projectId, runId, kind, redact(content), new Date().toISOString());
  }

  // events 支持关键字、事件类型和双向游标查询。
  events(projectId, { after = 0, before = Number.MAX_SAFE_INTEGER, search = '', kind = '', limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM events WHERE project_id=? AND id>? AND id<?
      AND instr(lower(content),lower(?))>0 AND (?='' OR kind=?) ORDER BY id DESC LIMIT ?`)
      .all(projectId, after, before, search, kind, kind, limit);
    return rows.reverse();
  }

  // tasks 读取项目的执行顺序。
  tasks(id) { return this.db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY position').all(id).map(decode); }

  // checks 读取项目的所有验收项。
  checks(id) { return this.db.prepare('SELECT * FROM checks WHERE project_id=? ORDER BY rowid').all(id).map(decode); }

  // plan 原子保存规划，规划失败时不会留下半份任务列表。
  plan(id, plan) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM tasks WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM checks WHERE project_id=?').run(id);
      const keys = new Map();
      for (const check of plan.checks) {
        const key = randomUUID(); keys.set(check.id, key);
        this.db.prepare('INSERT INTO checks(id,project_id,title,command,expectation) VALUES(?,?,?,?,?)')
          .run(key, id, check.title, check.command, check.expectation);
      }
      for (const [index, task] of plan.tasks.entries()) {
        this.db.prepare('INSERT INTO tasks(id,project_id,position,title,description,check_ids) VALUES(?,?,?,?,?,?)')
          .run(randomUUID(), id, index, task.title, task.description, JSON.stringify(task.checkIds.map(key => keys.get(key))));
      }
      this.update(id, { summary: plan.summary, resume_phase: 'execute', failures: 0 });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // task 更新单个任务并保留尝试次数。
  task(id, status, result = '', increment = false) {
    this.db.prepare('UPDATE tasks SET status=?, result=?, attempts=attempts+? WHERE id=?').run(status, redact(result), Number(increment), id);
  }

  // repair 添加最终评估发现的遗漏任务，重新执行全部验收项。
  repair(id, description, title = '修复评估发现的问题') {
    this.db.prepare('INSERT INTO tasks(id,project_id,position,title,description,check_ids) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), id, this.tasks(id).length, title, description, JSON.stringify(this.checks(id).map(check => check.id)));
  }

  // check 保存一次实际执行的测试结果。
  check(id, status, output) {
    this.db.prepare('UPDATE checks SET status=?,output=?,checked_at=? WHERE id=?')
      .run(status, redact(output), new Date().toISOString(), id);
  }

  // invalidate 在源码发生变化后废弃旧验收结论。
  invalidate(id) { this.db.prepare("UPDATE checks SET status='pending' WHERE project_id=?").run(id); }

  // beginRun 在启动子进程之前保存完整输入。
  beginRun(projectId, role, input) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs(id,project_id,role,input,created_at) VALUES(?,?,?,?,?)')
      .run(id, projectId, role, redact(input), new Date().toISOString());
    this.event(projectId, 'agent.started', `${role} 开始执行`, id);
    return id;
  }

  // session 保存 CLI 返回的真实会话编号。
  session(id, value) { this.db.prepare('UPDATE runs SET session_id=? WHERE id=?').run(value, id); }

  // process 保存真实进程编号，服务异常退出后用于阻止重复启动仍存活的旧进程。
  process(id, pid) { if (Number.isInteger(pid)) this.db.prepare('UPDATE runs SET process_id=? WHERE id=?').run(pid, id); }

  // interruptedProcesses 返回可能残留的旧进程，不仅凭数据库状态断言进程已经退出。
  interruptedProcesses(id) { return this.db.prepare("SELECT process_id FROM runs WHERE project_id=? AND status IN ('interrupted','failed') AND process_id IS NOT NULL").all(id); }

  // finishRun 保存最终输出和真实状态。
  finishRun(id, status, output) {
    this.db.prepare('UPDATE runs SET status=?,output=?,finished_at=? WHERE id=?').run(status, redact(output), new Date().toISOString(), id);
  }

  // run 返回单轮完整输入输出。
  run(id) { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id); }

  // latestSession 仅复用同一开发工作目录中的最近会话，评估使用独立会话。
  latestSession(id, role) { return this.db.prepare("SELECT session_id FROM runs WHERE project_id=? AND role=? AND session_id<>'' ORDER BY created_at DESC LIMIT 1").get(id, role)?.session_id || ''; }

  // latestRoleRun 查询角色最近轮次，不受工作台最近 100 轮的分页窗口影响。
  latestRoleRun(id, roles) {
    return this.db.prepare(`SELECT id,role,status,created_at,finished_at,session_id FROM runs WHERE project_id=? AND role IN (${roles.map(() => '?').join(',')}) ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(id, ...roles) || null;
  }

  // runEvents 查询角色实时日志，完整内容仍保存在 SQLite 中。
  runEvents(id, limit = 30) { return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?').all(id, limit).reverse(); }

  // officeEvents 查询真实任务交接事件，供办公室绘制消息传递。
  officeEvents(id, kinds, limit) {
    return this.db.prepare(`SELECT id,kind,created_at FROM events WHERE project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(id, ...kinds, limit).reverse();
  }

  // instruction 保存用户的补充执行指令，在后续所有 Agent 上下文中使用。
  instruction(id, content) {
    this.db.prepare('INSERT INTO instructions(project_id,content,created_at) VALUES(?,?,?)').run(id, content, new Date().toISOString());
    this.event(id, 'control.steer', content);
  }

  // instructions 按时间返回补充指令，避免暂停恢复后遗漏用户要求。
  instructions(id) { return this.db.prepare('SELECT * FROM instructions WHERE project_id=? ORDER BY id').all(id); }

  // questions 返回所有用户问答。
  questions(id) { return this.db.prepare('SELECT * FROM questions WHERE project_id=? ORDER BY rowid').all(id); }

  // ask 将需要外部信息的问题持久化。
  ask(id, prompts) {
    for (const prompt of prompts) this.db.prepare('INSERT INTO questions(id,project_id,prompt,created_at) VALUES(?,?,?,?)')
      .run(randomUUID(), id, prompt, new Date().toISOString());
  }

  // answer 只允许回答当前项目尚未回答的问题。
  answer(projectId, id, answer) {
    return this.db.prepare('UPDATE questions SET answer=?,answered_at=? WHERE id=? AND project_id=? AND answer IS NULL')
      .run(answer, new Date().toISOString(), id, projectId).changes;
  }

  // commit 记录与开发轮次对应的源码版本。
  commit(id, hash, title) {
    this.db.prepare('INSERT INTO commits(project_id,hash,title,created_at) VALUES(?,?,?,?)').run(id, hash, title, new Date().toISOString());
  }

  // detail 聚合工作台需要的业务信息，轮次正文按需读取。
  detail(id) {
    const project = this.project(id);
    if (!project) return null;
    return { ...project, tasks: this.tasks(id), checks: this.checks(id), questions: this.questions(id),
      runs: this.db.prepare('SELECT id,role,status,session_id,created_at,finished_at FROM runs WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(id),
      commits: this.db.prepare('SELECT * FROM commits WHERE project_id=? ORDER BY id DESC LIMIT 30').all(id),
      evaluation: this.db.prepare("SELECT * FROM events WHERE project_id=? AND kind IN ('evaluation.result','evaluation.final','evaluation.error') ORDER BY id DESC LIMIT 1").get(id) || null,
      events: this.events(id) };
  }

  // recover 重启后显式暂停未知执行状态，保留工作目录供用户恢复。
  recover() {
    for (const project of this.list()) {
      if (['planning', 'running', 'verifying'].includes(project.status)) {
        this.update(project.id, { status: 'paused', next_evaluation: null, summary: '服务已重启，点击继续执行以恢复。' });
        this.event(project.id, 'system.recovered', '服务重启，未完成轮次标记为中断，源码与记录已保留；继续前将检查旧进程是否仍存在。');
      }
    }
    this.db.exec("UPDATE runs SET status='interrupted', finished_at=datetime('now') WHERE status='running'; UPDATE tasks SET status='pending' WHERE status='running'; UPDATE checks SET status='pending' WHERE status='running';");
  }

  // close 释放 SQLite 连接。
  close() { this.db.close(); }
}

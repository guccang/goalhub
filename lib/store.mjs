// 本文件使用 SQLite 保存项目状态、任务、验收、问答和每轮 Agent 的输入输出。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { team, assignEmployee } from './employees.mjs';

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
  for (const key of ['settings', 'check_ids', 'depends_on']) if (key in value) value[key] = JSON.parse(value[key]);
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
    if (!this.db.prepare('PRAGMA table_info(projects)').all().some((column) => column.name === 'plan_approved')) this.db.exec('ALTER TABLE projects ADD COLUMN plan_approved INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some((column) => column.name === 'process_id')) this.db.exec('ALTER TABLE runs ADD COLUMN process_id INTEGER');
    for (const column of ['employee_id', 'config_key', 'executor']) if (!this.db.prepare('PRAGMA table_info(runs)').all().some(item => item.name === column)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    this.migrateProjects();
    // 旧项目一次性固定团队；后续宿主默认值变化不会替换项目员工的配置。
    for (const project of this.list()) if (project.settings.teamVersion !== 2) {
      this.db.prepare('UPDATE projects SET settings=? WHERE id=?').run(JSON.stringify({ ...project.settings, employees: team(project), teamVersion: 2 }), project.id);
    }
  }

  // create 保存目标和调度参数，尚不启动模型调用。
  create({ name, goal = '', settings = {}, repoPath = '', mainBranch = 'main' }) {
    const id = randomUUID(), now = new Date().toISOString();
    settings = { ...settings, employees: team({ settings }), teamVersion: 2 };
    this.db.prepare('INSERT INTO projects(id,name,goal,status,settings,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, name, goal, 'paused', JSON.stringify(settings), now, now);
    this.db.prepare('UPDATE projects SET repo_path=?, main_branch=? WHERE id=?').run(repoPath, mainBranch, id);
    if (goal) this.createGoal(id, { goal, title: name, settings });
    else this.update(id, { status: 'ready' });
    return this.project(id);
  }

  // project 查询一个项目。
  project(id) { return decode(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id)); }

  // list 返回项目列表及实际任务进度。
  list() {
    return this.db.prepare(`SELECT p.*, (SELECT count(*) FROM tasks WHERE project_id=p.id AND goal_id=p.active_goal_id) task_count,
      (SELECT count(*) FROM tasks WHERE project_id=p.id AND goal_id=p.active_goal_id AND status='done') done_count
      FROM projects p ORDER BY p.created_at DESC`).all().map(decode);
  }

  // update 仅允许修改明确列出的项目字段。
  update(id, values) {
    const allowed = ['status', 'summary', 'resume_phase', 'failures', 'next_evaluation', 'plan_approved'];
    const entries = Object.entries(values).filter(([key]) => allowed.includes(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE projects SET ${entries.map(([key]) => `${key}=?`).join(',')}, updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), new Date().toISOString(), id);
    const current = this.project(id);
    if (current?.active_goal_id) this.db.prepare('UPDATE goals SET snapshot=?, updated_at=? WHERE id=?').run(JSON.stringify(current), new Date().toISOString(), current.active_goal_id);
  }

  // event 记录一个按时间排列的安全文本事件。
  event(projectId, kind, content, runId = null) {
    this.db.prepare('INSERT INTO events(project_id,run_id,kind,content,created_at) VALUES(?,?,?,?,?)')
      .run(projectId, runId, kind, redact(content), new Date().toISOString());
  }

  // events 支持关键字、事件类型和双向游标查询。
  events(projectId, { goalId = this.project(projectId)?.active_goal_id, after = 0, before = Number.MAX_SAFE_INTEGER, search = '', kind = '', limit = 100 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM events WHERE project_id=? AND goal_id=? AND id>? AND id<?
      AND instr(lower(content),lower(?))>0 AND (?='' OR kind=?) ORDER BY id DESC LIMIT ?`)
      .all(projectId, goalId || '', after, before, search, kind, kind, limit);
    return rows.reverse();
  }

  // tasks 读取项目的执行顺序。
  tasks(id, goalId = this.project(id)?.active_goal_id) { return this.db.prepare('SELECT * FROM tasks WHERE project_id=? AND goal_id=? ORDER BY position').all(id, goalId || '').map(decode); }

  // checks 读取项目的所有验收项。
  checks(id, goalId = this.project(id)?.active_goal_id) { return this.db.prepare('SELECT * FROM checks WHERE project_id=? AND goal_id=? ORDER BY rowid').all(id, goalId || '').map(decode); }

  // plan 原子保存规划，规划失败时不会留下半份任务列表。
  plan(id, plan) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM tasks WHERE project_id=? AND goal_id=?').run(id, this.project(id).active_goal_id);
      this.db.prepare('DELETE FROM checks WHERE project_id=? AND goal_id=?').run(id, this.project(id).active_goal_id);
      const keys = new Map();
      for (const check of plan.checks) {
        const key = randomUUID(); keys.set(check.id, key);
        this.db.prepare('INSERT INTO checks(id,project_id,title,command,expectation) VALUES(?,?,?,?,?)')
          .run(key, id, check.title, check.command, check.expectation);
      }
      const taskKeys = new Map(plan.tasks.map((task, index) => [task.id || `task-${index + 1}`, randomUUID()]));
      for (const [index, task] of plan.tasks.entries()) {
        this.db.prepare('INSERT INTO tasks(id,project_id,position,title,description,check_ids,assignee,depends_on,done_when) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(taskKeys.get(task.id || `task-${index + 1}`), id, index, task.title, task.description, JSON.stringify(task.checkIds.map(key => keys.get(key))), task.assignee || 'developer', JSON.stringify((task.dependsOn || []).map(key => taskKeys.get(key))), task.doneWhen || task.description);
      }
      this.db.prepare('UPDATE goals SET plan_summary=? WHERE id=?').run(plan.summary, this.project(id).active_goal_id);
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
    this.db.prepare('INSERT INTO tasks(id,project_id,position,title,description,check_ids,assignee) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), id, this.tasks(id).length, title, description, JSON.stringify(this.checks(id).map(check => check.id)), '');
  }

  // assignTask 保存负责人确定的员工和分配原因，事件用于办公室真实交接。
  assignTask(projectId, taskId, employeeId, reason) {
    const project = this.project(projectId);
    this.db.exec('BEGIN');
    try {
      const result = this.db.prepare('UPDATE tasks SET assignee=? WHERE id=? AND project_id=? AND goal_id=?').run(employeeId, taskId, projectId, project.active_goal_id);
      if (!result.changes) throw new Error('任务不属于当前项目目标');
      this.event(projectId, 'task.assigned', JSON.stringify({ taskId, from: team(project).find(employee => employee.isLead)?.id, to: employeeId, reason }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // clearAssignment 将失败任务交还负责人，原执行员工仍保留在轮次快照中。
  clearAssignment(taskId) { this.db.prepare("UPDATE tasks SET assignee='' WHERE id=?").run(taskId); }

  // check 保存一次实际执行的测试结果。
  check(id, status, output) {
    this.db.prepare('UPDATE checks SET status=?,output=?,checked_at=? WHERE id=?')
      .run(status, redact(output), new Date().toISOString(), id);
  }

  // invalidate 在源码发生变化后废弃旧验收结论。
  invalidate(id) { this.db.prepare("UPDATE checks SET status='pending' WHERE project_id=? AND goal_id=?").run(id, this.project(id).active_goal_id); }

  // beginRun 在启动子进程之前保存完整输入。
  beginRun(projectId, role, input, employee = null) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs(id,project_id,role,input,created_at) VALUES(?,?,?,?,?)')
      .run(id, projectId, role, redact(input), new Date().toISOString());
    const config = employee || this.project(projectId).settings;
    this.db.prepare('UPDATE runs SET host_type=?, model=?, session_epoch=? WHERE id=?').run(config.hostType || '', config.model || '', this.project(projectId).session_epoch, id);
    this.event(projectId, 'agent.started', `${role} 开始执行`, id);
    if (employee) this.db.prepare('UPDATE runs SET employee_id=?,config_key=?,executor=? WHERE id=?').run(employee.id, employee.configKey, JSON.stringify(employee), id);
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
  latestSession(id, role) {
    const project = this.project(id);
    return this.db.prepare("SELECT session_id FROM runs WHERE project_id=? AND role=? AND session_epoch=? AND host_type=? AND model=? AND session_id<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id, role, project.session_epoch, project.settings.hostType || '', project.settings.model || '')?.session_id || '';
  }
  // employeeSession 只复用同一员工、职责、模型与宿主配置的会话。
  employeeSession(id, role, key) { return this.db.prepare("SELECT session_id FROM runs WHERE project_id=? AND role=? AND config_key=? AND session_epoch=? AND session_id<>'' ORDER BY rowid DESC LIMIT 1").get(id, role, key, this.project(id).session_epoch)?.session_id || ''; }
  // employeeRun 读取员工最近轮次，默认员工可接续迁移前的同职责历史。
  employeeRun(id, employee) {
    const legacy = employee.id === (employee.role === 'final-review' ? 'quality' : employee.role);
    return this.db.prepare("SELECT * FROM runs WHERE project_id=? AND role<>'team-builder' AND (employee_id=? OR (? AND employee_id='' AND role=?)) ORDER BY rowid DESC LIMIT 1").get(id, employee.id, Number(legacy), employee.role || '') || null;
  }
  // saveEmployees 原子保存项目团队与审计记录，删除员工不删除其历史轮次。
  saveEmployees(id, employees, language, context) {
    const project = this.project(id);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE projects SET settings=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...project.settings, teamVersion: 2, employees, context: context ?? project.settings.context ?? '', language: language ?? project.settings.language ?? 'zh-CN' }), new Date().toISOString(), id);
      const available = new Set(employees.filter(employee => employee.enabled).map(employee => employee.id));
      for (const task of this.tasks(id)) if (task.status !== 'done' && !available.has(task.assignee)) this.clearAssignment(task.id);
      this.event(id, 'team.updated', JSON.stringify({ before: project.settings.employees || null, after: employees, contextBefore: project.settings.context || '', contextAfter: context ?? project.settings.context ?? '', languageBefore: project.settings.language || 'zh-CN', languageAfter: language ?? project.settings.language ?? 'zh-CN' }));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // latestRoleRun 查询角色最近轮次，不受工作台最近 100 轮的分页窗口影响。
  latestRoleRun(id, roles) {
    return this.db.prepare(`SELECT id,role,status,created_at,finished_at,session_id FROM runs WHERE project_id=? AND role IN (${roles.map(() => '?').join(',')}) ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(id, ...roles) || null;
  }

  // runEvents 查询角色实时日志，完整内容仍保存在 SQLite 中。
  runEvents(id, limit = 30) { return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?').all(id, limit).reverse(); }

  // officeEvents 查询真实任务交接事件，供办公室绘制消息传递。
  officeEvents(id, kinds, limit) {
    return this.db.prepare(`SELECT id,kind,content,run_id,created_at FROM events WHERE project_id=? AND goal_id=? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`).all(id, this.project(id).active_goal_id || '', ...kinds, limit).reverse();
  }

  // instruction 保存用户的补充执行指令，在后续所有 Agent 上下文中使用。
  instruction(id, content) {
    this.db.prepare('INSERT INTO instructions(project_id,content,created_at) VALUES(?,?,?)').run(id, content, new Date().toISOString());
    this.event(id, 'control.steer', content);
  }

  // instructions 按时间返回补充指令，避免暂停恢复后遗漏用户要求。
  instructions(id) { return this.db.prepare('SELECT * FROM instructions WHERE project_id=? AND goal_id=? ORDER BY id').all(id, this.project(id)?.active_goal_id || ''); }

  // questions 返回所有用户问答。
  questions(id, goalId = this.project(id)?.active_goal_id) { return this.db.prepare('SELECT * FROM questions WHERE project_id=? AND goal_id=? ORDER BY rowid').all(id, goalId || ''); }

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
  detail(id, goalId = this.project(id)?.active_goal_id) {
    let project = this.project(id);
    const goal = goalId && this.db.prepare('SELECT * FROM goals WHERE id=? AND project_id=?').get(goalId, id);
    if (goalId && !goal) return null;
    if (goal && goalId !== project.active_goal_id) project = { ...project, ...JSON.parse(goal.snapshot), historical: true };
    if (!project) return null;
    return { ...project, viewed_goal_id: goalId, goals: this.goals(id), usage: this.usage(id), goalUsage: this.usage(id, goalId), sessions: this.sessions(id), tasks: this.tasks(id, goalId), checks: this.checks(id, goalId), questions: this.questions(id, goalId),
      // 返回执行员工编号，个人记录按真实归属筛选，负责人仍可查看全部轮次。
      runs: this.db.prepare('SELECT id,role,status,session_id,employee_id,created_at,finished_at FROM runs WHERE project_id=? AND goal_id=? ORDER BY created_at DESC LIMIT 100').all(id, goalId || ''),
      commits: this.db.prepare('SELECT * FROM commits WHERE project_id=? AND goal_id=? ORDER BY id DESC LIMIT 30').all(id, goalId || ''),
      evaluation: this.db.prepare("SELECT * FROM events WHERE project_id=? AND goal_id=? AND kind IN ('evaluation.result','evaluation.final','evaluation.error') ORDER BY id DESC LIMIT 1").get(id, goalId || '') || null,
      events: this.events(id, { goalId }) };
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

  // migrateProjects 原子迁移旧目标到项目首轮迭代，保留原 ID 和全部历史证据。
  migrateProjects() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = { tasks: { assignee: "TEXT NOT NULL DEFAULT 'developer'", depends_on: "TEXT NOT NULL DEFAULT '[]'", done_when: "TEXT NOT NULL DEFAULT ''" }, projects: { active_goal_id: 'TEXT', repo_path: "TEXT NOT NULL DEFAULT ''", main_branch: "TEXT NOT NULL DEFAULT 'main'", session_epoch: 'INTEGER NOT NULL DEFAULT 0' },
        runs: { host_type: "TEXT NOT NULL DEFAULT ''", model: "TEXT NOT NULL DEFAULT ''", session_epoch: 'INTEGER NOT NULL DEFAULT 0', context_window: 'INTEGER', context_used: 'INTEGER', context_at: 'TEXT', actual_model: 'TEXT' } };
      for (const [table, fields] of Object.entries(columns)) for (const [column, type] of Object.entries(fields)) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, snapshot TEXT NOT NULL, base_commit TEXT, merge_commit TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_counters (run_id TEXT PRIMARY KEY REFERENCES runs(id), input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS usage_samples (run_id TEXT NOT NULL REFERENCES runs(id), event_key TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(run_id,event_key));
        CREATE TABLE IF NOT EXISTS compactions (run_id TEXT NOT NULL REFERENCES runs(id), event_key TEXT NOT NULL, before_tokens INTEGER, after_tokens INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(run_id,event_key));`);
      if (!this.db.prepare('PRAGMA table_info(goals)').all().some(item => item.name === 'plan_summary')) this.db.exec("ALTER TABLE goals ADD COLUMN plan_summary TEXT NOT NULL DEFAULT ''");
      const tables = ['tasks', 'checks', 'runs', 'events', 'questions', 'commits', 'instructions'];
      for (const table of tables) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === 'goal_id')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN goal_id TEXT`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_goal ON ${table}(project_id,goal_id);
          CREATE TRIGGER IF NOT EXISTS ${table}_goal_insert AFTER INSERT ON ${table} WHEN NEW.goal_id IS NULL BEGIN UPDATE ${table} SET goal_id=(SELECT active_goal_id FROM projects WHERE id=NEW.project_id) WHERE rowid=NEW.rowid; END;`);
      }
      for (const project of this.db.prepare("SELECT * FROM projects WHERE active_goal_id IS NULL AND goal<>''").all()) {
        const goalId = randomUUID(); project.active_goal_id = goalId;
        this.db.prepare('INSERT INTO goals(id,project_id,title,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(goalId, project.id, project.name, JSON.stringify({ ...project, settings: JSON.parse(project.settings) }), project.created_at, project.updated_at);
        this.db.prepare('UPDATE projects SET active_goal_id=? WHERE id=?').run(goalId, project.id);
        for (const table of tables) this.db.prepare(`UPDATE ${table} SET goal_id=? WHERE project_id=? AND goal_id IS NULL`).run(goalId, project.id);
        const settings = JSON.parse(project.settings);
        this.db.prepare("UPDATE runs SET host_type=?,model=? WHERE project_id=? AND host_type=''").run(settings.hostType || '', settings.model || '', project.id);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  // createGoal 同仓库串行迭代；未完成目标必须先处理完，避免丢弃暂停中的开发。
  createGoal(id, { title, goal, settings }) {
    const project = this.project(id);
    if (!project) throw new Error('项目不存在');
    if (project.active_goal_id && project.status !== 'completed') throw new Error('请先完成当前目标，再开始下一次迭代');
    const goalId = randomUUID(), now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE projects SET active_goal_id=?,goal=?,settings=?,status='paused',summary='',resume_phase='plan',failures=0,plan_approved=0,next_evaluation=NULL,updated_at=? WHERE id=?")
        .run(goalId, goal, JSON.stringify(settings || project.settings), now, id);
      this.db.prepare('INSERT INTO goals(id,project_id,title,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(goalId, id, title || goal.slice(0, 60), JSON.stringify(this.project(id)), now, now);
      this.event(id, 'goal.created', goal);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.project(id);
  }

  // goals 展示每次迭代的独立状态、计划和 Git 边界。
  goals(id) { return this.db.prepare('SELECT * FROM goals WHERE project_id=? ORDER BY created_at,rowid').all(id).map(row => ({ ...row, snapshot: undefined, ...JSON.parse(row.snapshot), id: row.id, title: row.title })); }

  // resetSessions 显式开启项目新会话，旧轮次与持久摘要仍保留。
  resetSessions(id) {
    this.db.prepare('UPDATE projects SET session_epoch=session_epoch+1 WHERE id=?').run(id);
    this.event(id, 'session.reset', '用户开启新的项目会话；后续调用携带已完成目标摘要与 Git 版本。');
  }

  // telemetry 保存去重后的宿主统计，累计用量与上下文占用分别记录。
  telemetry(runId, value) {
    if (!value) return;
    const now = new Date().toISOString();
    if (value.model) this.db.prepare('UPDATE runs SET actual_model=? WHERE id=?').run(value.model, runId);
    if (value.usage) {
      let u = value.usage;
      if (value.cumulative) {
        const run = this.run(runId);
        const prior = this.db.prepare('SELECT c.* FROM usage_counters c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=? AND r.host_type=? AND r.rowid<(SELECT rowid FROM runs WHERE id=?) ORDER BY r.rowid DESC LIMIT 1').get(run.project_id, run.session_id, run.host_type, runId);
        const base = value.baseline || (prior ? { ...prior, cacheWrite: prior.cache_write } : !value.resumed ? { input: 0, output: 0, cached: 0, cacheWrite: 0 } : null);
        this.db.prepare('INSERT INTO usage_counters VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input=excluded.input,output=excluded.output,cached=excluded.cached,cache_write=excluded.cache_write').run(runId, u.input, u.output, u.cached, u.cacheWrite || 0);
        if (!base) return;
        u = { input: u.input - base.input, output: u.output - base.output, cached: u.cached - base.cached, cacheWrite: (u.cacheWrite || 0) - (base.cacheWrite || 0) };
        if (Object.values(u).some(n => n < 0)) return;
      }
      this.db.prepare('INSERT INTO usage_samples(run_id,event_key,input,output,cached,cache_write,source,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,event_key) DO UPDATE SET input=excluded.input,output=excluded.output,cached=excluded.cached,cache_write=excluded.cache_write')
        .run(runId, value.key, u.input, u.output, u.cached, u.cacheWrite || 0, value.source, now);
    }
    if (value.context) {
      this.db.prepare('UPDATE runs SET context_window=?,context_used=?,context_at=?,actual_model=COALESCE(?,actual_model) WHERE id=?')
        .run(value.context.window, value.context.used, value.at || now, value.model || null, runId);
      this.db.prepare('UPDATE compactions SET after_tokens=? WHERE run_id=? AND after_tokens IS NULL').run(value.context.used, runId);
    }
    if (value.compaction) this.db.prepare('INSERT OR IGNORE INTO compactions(run_id,event_key,before_tokens,created_at) VALUES(?,?,?,?)')
      .run(runId, value.key, value.compaction.before ?? this.run(runId)?.context_used ?? null, now);
  }

  // usage 汇总目标、项目或全局的已知用量，并报告未上报的轮次，缓存读取已包含于输入。
  usage(id = null, goalId = null) {
    const where = `(? IS NULL OR r.project_id=?) AND (? IS NULL OR r.goal_id=?) AND r.role<>'test'`;
    const args = [id, id, goalId, goalId];
    const counts = this.db.prepare(`SELECT sum(CASE WHEN finished_at IS NOT NULL THEN max(0,unixepoch(finished_at)-unixepoch(created_at)) ELSE 0 END) elapsed_seconds, count(*) runs, count(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM usage_samples u WHERE u.run_id=r.id) THEN r.id END) known_runs FROM runs r WHERE ${where}`).get(...args);
    const totals = this.db.prepare(`SELECT sum(u.input) input,sum(u.output) output,sum(u.cached) cached,sum(u.cache_write) cache_write FROM usage_samples u JOIN runs r ON r.id=u.run_id WHERE ${where}`).get(...args);
    const breakdown = this.db.prepare(`SELECT r.project_id,p.name,r.goal_id,g.title goal_title,r.role,r.model,substr(u.created_at,1,10) day,sum(u.input) input,sum(u.output) output,sum(u.cached) cached FROM usage_samples u JOIN runs r ON r.id=u.run_id JOIN projects p ON p.id=r.project_id LEFT JOIN goals g ON g.id=r.goal_id WHERE ${where} GROUP BY r.project_id,r.goal_id,r.role,r.model,day ORDER BY day DESC`).all(...args);
    return { ...counts, ...totals, total: totals.input === null ? null : totals.input + totals.output, breakdown };
  }

  // sessions 按项目员工展示当前配置的持续会话，临时只读评估不覆盖工作会话。
  sessions(id) {
    const p = this.project(id);
    return team(p).map(employee => {
      const identity = { employeeId: employee.id, name: employee.name, position: employee.position, isLead: employee.isLead, role: employee.isLead ? 'planner' : 'developer' };
      const key = employee.enabled ? assignEmployee(this, p, 'developer', employee.id).configKey : '';
      const row = this.db.prepare("SELECT * FROM runs WHERE project_id=? AND employee_id=? AND config_key=? AND role IN ('planner','coordinator','developer') AND session_epoch=? AND session_id<>'' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id, employee.id, key, p.session_epoch);
      if (!row) return { ...identity, status: employee.enabled ? 'unstarted' : 'disabled', remainingPercent: null };
      if (row.context_window === null) {
        const previous = this.db.prepare('SELECT context_window,context_used,context_at,actual_model FROM runs WHERE project_id=? AND session_id=? AND model=? AND host_type=? AND session_epoch=? AND context_window IS NOT NULL ORDER BY context_at DESC LIMIT 1').get(id, row.session_id, row.model, row.host_type, row.session_epoch);
        if (previous) Object.assign(row, previous);
      }
      const compaction = this.db.prepare('SELECT c.* FROM compactions c JOIN runs r ON r.id=c.run_id WHERE r.project_id=? AND r.session_id=? ORDER BY c.created_at DESC LIMIT 1').get(id, row.session_id);
      return { ...identity, phase: row.role, sessionId: row.session_id, status: row.status, model: row.actual_model || row.model || '宿主默认', window: row.context_window, used: row.context_used, updatedAt: row.context_at, compaction,
        remainingPercent: row.context_window > 0 && row.context_used !== null ? Math.max(0, Math.min(100, (1 - row.context_used / row.context_window) * 100)) : null };
    });
  }

  // close 释放 SQLite 连接。
  close() { this.db.close(); }
}

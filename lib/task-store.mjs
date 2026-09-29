// 本文件保存任务版本、独立工作区、接口交接与集成证据，取消不删除历史成果。
import { randomUUID } from 'node:crypto';

// migrateExecution 为既有数据库增量增加并行执行记录。
export function migrateExecution(db) {
  for (const [table, fields] of Object.entries({
    tasks: { version: 'INTEGER NOT NULL DEFAULT 1', plan_key: "TEXT NOT NULL DEFAULT ''", spec: "TEXT NOT NULL DEFAULT '{}'", handoff: "TEXT NOT NULL DEFAULT ''" },
    checks: { plan_key: "TEXT NOT NULL DEFAULT ''" },
    runs: { task_id: "TEXT NOT NULL DEFAULT ''", task_version: 'INTEGER', plan_steps: 'TEXT' },
  })) for (const [name, type] of Object.entries(fields)) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS task_workspaces (
    task_id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL, goal_id TEXT NOT NULL,
    branch TEXT NOT NULL, directory TEXT NOT NULL, base_commit TEXT NOT NULL, candidate_commit TEXT NOT NULL DEFAULT '',
    accepted_commit TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'working', updated_at TEXT NOT NULL,
    PRIMARY KEY(task_id,version));
    CREATE TABLE IF NOT EXISTS task_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, goal_id TEXT NOT NULL, task_id TEXT NOT NULL,
    version INTEGER NOT NULL, run_id TEXT NOT NULL, check_id TEXT NOT NULL, commit_hash TEXT NOT NULL, stage TEXT NOT NULL,
    command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS goal_modules (goal_id TEXT PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS control_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT NOT NULL, content TEXT NOT NULL,
    status TEXT NOT NULL, decision TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);`);
}

export const executionMethods = {
  // taskWorkspace 获取指定任务版本的持久化工作区。
  taskWorkspace(task) { return this.db.prepare('SELECT * FROM task_workspaces WHERE task_id=? AND version=?').get(task.id, task.version); },
  // saveWorkspace 只允许更新已知执行字段。
  saveWorkspace(task, values) {
    const columns = Object.keys(values).filter(key => ['candidate_commit', 'accepted_commit', 'status'].includes(key));
    if (columns.length) this.db.prepare(`UPDATE task_workspaces SET ${columns.map(key => `${key}=?`).join(',')},updated_at=? WHERE task_id=? AND version=?`)
      .run(...columns.map(key => values[key]), new Date().toISOString(), task.id, task.version);
  },
  // taskCurrent 检查结果是否仍属于可接纳的任务版本。
  taskCurrent(projectId, task) { return this.tasks(projectId).some(item => item.id === task.id && item.version === task.version && !['cancelled', 'paused'].includes(item.status)); },
  // modules 返回主管登记的模块概要，未细化模块阻止提前完成目标。
  modules(id) { return JSON.parse(this.db.prepare('SELECT content FROM goal_modules WHERE goal_id=?').get(this.project(id).active_goal_id)?.content || '[]'); },
  // controlTask 改变任务控制状态，同时阻止取消任务的依赖被错误当作已完成。
  controlTask(id, taskId, action) {
    const task = this.tasks(id).find(item => item.id === taskId);
    if (!task) throw new Error('任务不属于当前目标');
    if (!['pause', 'cancel', 'resume'].includes(action)) throw new Error('任务控制动作无效');
    if (task.status === 'done') throw new Error('任务已集成，请通过修改需求安排修订任务');
    if (action === 'resume' && task.status !== 'paused' && task.status !== 'blocked') throw new Error('只能恢复暂停或阻断的任务');
    if (task.status === 'cancelled') throw new Error('任务已取消，请由主管重新规划');
    this.task(taskId, { pause: 'paused', cancel: 'cancelled', resume: 'pending' }[action], task.result);
    this.event(id, `task.${action}`, JSON.stringify({ taskId, title: task.title }));
  },
  // parallelPlan 增量保存模块计划，保留任务编号、取消记录及已接纳成果。
  parallelPlan(id, plan) {
    // 兼容旧调用直接传入未规范化计划，新字段采用原有串行语义的默认值。
    plan = { ...plan, tasks: plan.tasks.map((task, index) => ({ requiredCapability: 'development', dependsOn: [], doneWhen: task.description, ...task, id: task.id || `task-${index + 1}` })) };
    const goalId = this.project(id).active_goal_id;
    const oldModules = this.modules(id), previousRevision = this.requirementSnapshot(id)?.sourceRevision;
    // 无新需求的滚动细化不能静默丢弃未完成模块，也不能反复返回同一批已完成任务。
    if (oldModules.some(module => module.status === 'deferred') && previousRevision === this.requirementInput(id).revision) {
      if (oldModules.some(module => !(plan.modules || []).some(item => item.id === module.id))) throw new Error('滚动规划必须保留全部未完成模块概要');
      const oldTasks = this.tasks(id);
      if (plan.tasks.every(task => oldTasks.some(old => (old.id === task.id || old.plan_key === task.id) && old.status === 'done' && old.description === task.description))) throw new Error('请细化剩余模块并增加可执行任务，不能重复提交已完成批次');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (plan.requirements) {
        const input = this.requirementInput(id);
        if (plan.requirements.sourceRevision !== input.revision || input.sources.length !== plan.requirements.sourceIds.length || input.sources.some(item => !plan.requirements.sourceIds.includes(item.id))) throw new Error('需求来源已变化，请核对全部用户决策后重新规划');
        this.db.prepare('INSERT INTO requirement_snapshots VALUES(?,?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET source_revision=excluded.source_revision,content=excluded.content,updated_at=excluded.updated_at')
          .run(id, goalId, input.revision, JSON.stringify(plan.requirements), new Date().toISOString());
      }
      const previous = this.tasks(id), oldChecks = this.checks(id);
      if (previous.length) this.event(id, 'plan.superseded', JSON.stringify({ tasks: previous, checks: oldChecks }));
      const keys = new Map(), taskKeys = new Map();
      for (const check of plan.checks) {
        const old = oldChecks.find(item => item.id === check.id || item.plan_key === check.id), key = old?.id || randomUUID(); keys.set(check.id, key);
        this.db.prepare(`INSERT INTO checks(id,project_id,title,command,expectation,goal_id,plan_key) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,command=excluded.command,expectation=excluded.expectation,status='pending'`)
          .run(key, id, check.title, check.command, check.expectation, goalId, check.id);
      }
      for (const item of plan.tasks) taskKeys.set(item.id, previous.find(old => old.id === item.id || old.plan_key === item.id)?.id || randomUUID());
      for (const [position, item] of plan.tasks.entries()) {
        const key = taskKeys.get(item.id), old = previous.find(row => row.id === key);
        const spec = JSON.stringify({ module: item.module || '', phase: item.phase || 'implementation', scope: item.scope || '', inputs: item.inputs || '', outputs: item.outputs || '' });
        const checks = JSON.stringify(item.checkIds.map(key => keys.get(key))), deps = JSON.stringify(item.dependsOn.map(key => taskKeys.get(key)));
        const changedChecks = item.checkIds.some(key => { const a = oldChecks.find(c => c.id === keys.get(key)), b = plan.checks.find(c => c.id === key); return !a || a.command !== b.command || a.expectation !== b.expectation; });
        const changed = old && (old.description !== item.description || old.done_when !== item.doneWhen || old.spec !== spec || JSON.stringify(old.depends_on) !== deps || JSON.stringify(old.check_ids) !== checks || changedChecks || old.status === 'cancelled');
        this.db.prepare(`INSERT INTO tasks(id,project_id,goal_id,position,title,description,done_when,check_ids,depends_on,assignee,required_capability,plan_key,spec,version,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET position=excluded.position,title=excluded.title,description=excluded.description,done_when=excluded.done_when,check_ids=excluded.check_ids,depends_on=excluded.depends_on,assignee=excluded.assignee,required_capability=excluded.required_capability,spec=excluded.spec,version=excluded.version,status=excluded.status,attempts=CASE WHEN tasks.version<>excluded.version THEN 0 ELSE tasks.attempts END,handoff=CASE WHEN tasks.version<>excluded.version THEN '' ELSE tasks.handoff END,result=CASE WHEN tasks.version<>excluded.version THEN '' ELSE tasks.result END`)
          .run(key, id, goalId, position, item.title, item.description, item.doneWhen, checks, deps, item.assignee, item.requiredCapability, old?.plan_key || item.id, spec, (old?.version || 1) + Number(!!changed), old && !changed ? old.status : 'pending');
      }
      for (const old of previous) if (![...taskKeys.values()].includes(old.id) && old.status !== 'done') this.task(old.id, 'cancelled', '主管已从当前计划移除此任务；代码与历史保留');
      const used = [...keys.values()];
      for (const check of oldChecks) if (!used.includes(check.id)) this.db.prepare("UPDATE checks SET status='retired' WHERE id=?").run(check.id);
      this.db.prepare('INSERT INTO goal_modules VALUES(?,?) ON CONFLICT(goal_id) DO UPDATE SET content=excluded.content').run(goalId, JSON.stringify(plan.modules || []));
      this.db.prepare('UPDATE goals SET plan_summary=? WHERE id=?').run(plan.summary, goalId);
      this.db.prepare("UPDATE instructions SET task_id='' WHERE project_id=? AND goal_id=? AND kind='repair' AND resolved_at=''").run(id, goalId);
      this.update(id, { summary: plan.summary, resume_phase: 'execute', failures: 0 });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  },
};

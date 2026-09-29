// 本文件管理任务隔离工作区和候选集成目录，只有验证通过的候选才更新目标分支。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';

export const taskGitMethods = {
  // ensureTask 同一任务版本复用工作区，重启不丢失已保存代码。
  async ensureTask(id, task) {
    if (!/^[a-f0-9-]{36}$/.test(task.id) || !Number.isSafeInteger(task.version) || task.version < 1) throw new Error('无效任务工作区编号');
    const goal = this.paths(id), root = join(this.dataDir, 'tasks'); mkdirSync(root, { recursive: true });
    const directory = join(root, `${task.id}-v${task.version}`), branch = `goalhub/task-${task.id}-v${task.version}`;
    let row = this.store.taskWorkspace(task);
    if (!row) {
      const base = await this.command(id, goal.work, ['rev-parse', 'HEAD']);
      this.store.db.prepare('INSERT INTO task_workspaces(task_id,version,project_id,goal_id,branch,directory,base_commit,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(task.id, task.version, id, this.store.project(id).active_goal_id, branch, directory, base, new Date().toISOString());
      row = this.store.taskWorkspace(task);
    }
    if (row.directory !== directory || row.branch !== branch) throw new Error('任务工作区记录不匹配');
    if (!existsSync(join(directory, '.git'))) {
      const known = await this.command(id, goal.repo, ['branch', '--list', branch]);
      await this.command(id, goal.repo, ['worktree', 'add', ...(known ? [] : ['-b', branch]), directory, known ? branch : row.base_commit]);
    }
    return { ...goal, work: directory, branch };
  },
  // checkpointDirectory 保存开发或修复结果，合并冲突必须先消除标记。
  async checkpointDirectory(id, directory, title) {
    await this.command(id, directory, ['diff', '--check']);
    const dirty = await this.command(id, directory, ['status', '--porcelain']);
    const merging = existsSync((await this.command(id, directory, ['rev-parse', '--git-path', 'MERGE_HEAD'])).replace(/\r?\n/g, ''));
    if (dirty || merging) {
      await this.command(id, directory, ['add', '--all']);
      await this.command(id, directory, ['commit', '-m', title.slice(0, 200)]);
    }
    return this.command(id, directory, ['rev-parse', 'HEAD']);
  },
  // candidateTask 从最新集成提交构建临时候选，失败现场可供员工适配接口或解决冲突。
  async candidateTask(id, task, commit) {
    const goal = this.paths(id), directory = join(this.dataDir, 'integrations', `${task.id}-v${task.version}-${randomUUID()}`);
    mkdirSync(join(this.dataDir, 'integrations'), { recursive: true });
    // 上一轮候选已先归档到任务分支；恢复时只丢弃可重新生成的临时目录。
    if (existsSync(join(directory, '.git'))) await this.removeCandidate(id, directory);
    const base = await this.command(id, goal.work, ['rev-parse', 'HEAD']);
    await this.command(id, goal.repo, ['worktree', 'add', '--detach', directory, base]);
    let conflict = '';
    try { await this.command(id, directory, ['merge', '--no-edit', commit]); }
    catch (error) {
      if (!await this.command(id, directory, ['ls-files', '-u'])) throw error;
      conflict = error.message;
    }
    return { directory, base, conflict };
  },
  // acceptCandidate 快进接纳准确的已测试提交，重复恢复时可安全重放。
  async acceptCandidate(id, task, candidate, commit) {
    const goal = this.paths(id), head = await this.command(id, goal.work, ['rev-parse', 'HEAD']);
    if (head !== candidate.base) throw new Error('目标集成版本已变化，必须重新验证');
    if (!this.store.taskCurrent(id, task)) throw new Error('任务已变更，拒绝接纳旧成果');
    await this.command(id, goal.work, ['merge', '--ff-only', commit]);
    this.store.saveWorkspace(task, { accepted_commit: commit, status: 'accepted' });
    this.store.commit(id, commit, `集成：${task.title}`);
  },
  // removeCandidate 只删除可重新生成的受管候选，不触及员工工作区。
  async removeCandidate(id, directory) {
    const part = relative(join(this.dataDir, 'integrations'), resolve(directory));
    if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('拒绝清理非受管集成目录');
    await this.command(id, this.paths(id).repo, ['worktree', 'remove', '--force', directory]);
  },
  // cleanupTasks 目标完成后仅移除已接纳且干净的工作区，失败与取消成果保留。
  async cleanupTasks(id) {
    const rows = this.store.db.prepare("SELECT * FROM task_workspaces WHERE project_id=? AND goal_id=? AND status='accepted'").all(id, this.store.project(id).active_goal_id);
    for (const row of rows) {
      const root = relative(join(this.dataDir, 'tasks'), resolve(row.directory));
      if (!root || root.startsWith('..') || isAbsolute(root)) throw new Error('无效任务清理路径');
      if (existsSync(join(row.directory, '.git'))) await this.command(id, this.paths(id).repo, ['worktree', 'remove', row.directory]);
      if (await this.command(id, this.paths(id).repo, ['branch', '--list', row.branch])) await this.command(id, this.paths(id).repo, ['branch', '-d', row.branch]);
    }
  },
};

// 本文件为每个目标管理独立 Git 仓库、开发 worktree 和一次性评估 worktree。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);

export class ProjectGit {
  // constructor 固定所有受管项目目录的根路径。
  constructor(dataDir, store) { this.dataDir = resolve(dataDir); this.store = store; }

  // registration 校验已有仓库或空目录，规范化路径以阻止同仓库重复登记和并发开发。
  async registration(path, mode = 'existing') {
    if (!path) return { repoPath: '', mainBranch: 'main' };
    const target = resolve(path);
    if (!isAbsolute(path)) throw new Error('请输入绝对目录路径');
    if (!existsSync(target)) {
      if (mode !== 'new') throw new Error('项目目录不存在');
      mkdirSync(target, { recursive: true });
    }
    const repoPath = realpathSync(target);
    const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (this.store.list().some(p => canonical(this.paths(p.id).repo) === canonical(repoPath))) throw new Error('该目录已经登记为项目');
    if (mode === 'new') {
      if (readdirSync(repoPath).length) throw new Error('新项目必须使用空目录，已有仓库请选择接入已有项目');
      return { repoPath, mainBranch: 'main' };
    }
    const config = { cwd: repoPath, windowsHide: true, timeout: 10000 };
    const root = (await execute('git', ['rev-parse', '--show-toplevel'], config)).stdout.trim();
    if (canonical(realpathSync(root)) !== canonical(repoPath)) throw new Error('请选择 Git 仓库根目录');
    const mainBranch = (await execute('git', ['branch', '--show-current'], config)).stdout.trim();
    if (!mainBranch) throw new Error('项目处于 detached HEAD，请先切换到主分支');
    return { repoPath, mainBranch };
  }

  // paths 只接受系统生成的 UUID，避免项目编号变成任意文件路径。
  paths(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效项目编号');
    const project = this.store.project(id);
    return { mainBranch: project?.main_branch || 'main', repo: project?.repo_path || join(this.dataDir, 'projects', id), work: join(this.dataDir, 'worktrees', this.goalScope ? `${id}-${this.goalScope}` : id), branch: this.goalScope ? `goalhub/goal-${this.goalScope}` : 'goalhub/development' };
  }

  // forGoal 每个目标使用独立分支和工作目录，保留旧目录以支持升级恢复。
  forGoal(store, goalId) {
    const scoped = Object.create(this); scoped.store = store; scoped.goalScope = goalId;
    const project = store.project(store.goalProjectId);
    if (this.store.project(project?.id)?.active_goal_id === goalId && existsSync(join(this.paths(project.id).work, '.git'))) scoped.goalScope = null;
    return scoped;
  }

  // integrate 将最新主分支并入当前目标，冲突保留现场供当前员工修复。
  async integrate(id) {
    const paths = this.paths(id);
    if (await this.command(id, paths.work, ['ls-files', '-u'])) throw new Error('并发合并冲突尚未解决，请修复冲突文件后继续');
    const before = await this.command(id, paths.work, ['rev-parse', 'HEAD']);
    await this.command(id, paths.work, ['merge', '--no-edit', paths.mainBranch]);
    return before !== await this.command(id, paths.work, ['rev-parse', 'HEAD']);
  }

  // command 执行 Git 并记录其输入输出，提交身份只作用于当前命令。
  async command(id, cwd, args) {
    this.store.event(id, 'git.command', `git ${args.join(' ')}`);
    try {
      const result = await execute('git', ['-c', 'user.name=GoalHub', '-c', 'user.email=goalhub@localhost', ...args], { cwd, windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      const output = `${result.stdout}${result.stderr}`.trim();
      if (output) this.store.event(id, 'git.output', output);
      return result.stdout.trim();
    } catch (error) {
      this.store.event(id, 'git.error', error.stderr || error.message);
      throw new Error(`Git 操作失败：${error.stderr || error.message}`);
    }
  }

  // ensure 初始化源码仓库并恢复或建立唯一开发 worktree。
  async ensure(project) {
    const paths = this.paths(project.id);
    mkdirSync(paths.repo, { recursive: true });
    mkdirSync(join(this.dataDir, 'worktrees'), { recursive: true });
    if (!existsSync(join(paths.repo, '.git'))) {
      await this.command(project.id, paths.repo, ['init', '-b', paths.mainBranch]);
      writeFileSync(join(paths.repo, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n.DS_Store\n');
      writeFileSync(join(paths.repo, 'GOAL.md'), `# ${project.name}\n\n${project.goal}\n`);
      writeFileSync(join(paths.repo, 'AGENTS.md'), '# 项目约定\n\n创建的代码文件和函数必须添加中文注释。\nGit 分支、worktree 和提交由 GoalHub 调度器管理，请专注源码与测试，不自行切换分支或操作 worktree。\n');
      await this.command(project.id, paths.repo, ['add', '--all']);
      await this.command(project.id, paths.repo, ['commit', '-m', 'chore: initialize project goal']);
      this.store.commit(project.id, await this.command(project.id, paths.repo, ['rev-parse', 'HEAD']), '初始化项目目标');
    }
    if (!existsSync(join(paths.work, '.git'))) {
      if (await this.command(project.id, paths.repo, ['status', '--porcelain'])) throw new Error('项目主目录存在未提交修改，请先处理后再开始迭代');
      const current = await this.command(project.id, paths.repo, ['branch', '--show-current']);
      if (current !== paths.mainBranch) throw new Error(`项目主目录需切换到 ${paths.mainBranch} 后再继续`);
      const branches = await this.command(project.id, paths.repo, ['branch', '--list', paths.branch]);
      await this.command(project.id, paths.repo, ['worktree', 'add', ...(branches ? [] : ['-b', paths.branch]), paths.work, branches ? paths.branch : paths.mainBranch]);
    }
    const head = await this.command(project.id, paths.repo, ['rev-parse', paths.mainBranch]);
    this.store.db.prepare('UPDATE goals SET base_commit=COALESCE(base_commit,?) WHERE id=?').run(head, project.active_goal_id);
    return paths;
  }

  // checkpoint 保存包含失败修复在内的源码进展，再快进同步主分支。
  async checkpoint(id, title) {
    const paths = this.paths(id);
    const branch = await this.command(id, paths.work, ['branch', '--show-current']);
    if (branch !== paths.branch) throw new Error(`开发分支被修改，需恢复 ${paths.branch} 后继续`);
    if (await this.command(id, paths.work, ['ls-files', '-u'])) await this.command(id, paths.work, ['diff', '--check']);
    if (await this.command(id, paths.work, ['status', '--porcelain'])) {
      await this.command(id, paths.work, ['add', '--all']);
      await this.command(id, paths.work, ['commit', '-m', title.slice(0, 200)]);
      this.store.commit(id, await this.command(id, paths.work, ['rev-parse', 'HEAD']), title);
    }
    // 开发检查点只提交到工作分支，验收通过后才合并主分支。
  }

  // review 从已提交主分支创建隔离检查目录，防止与开发 Agent 同时写入。
  async review(id) {
    const { repo, branch } = this.paths(id);
    const directory = join(this.dataDir, 'reviews', `${id}-${randomUUID()}`);
    mkdirSync(join(this.dataDir, 'reviews'), { recursive: true });
    await this.command(id, repo, ['worktree', 'add', '--detach', directory, branch]);
    return directory;
  }

  // removeReview 确认路径位于受管检查目录后移除一次性 worktree。
  async removeReview(id, directory) {
    const subpath = relative(join(this.dataDir, 'reviews'), resolve(directory));
    if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw new Error('拒绝清理非受管评估目录');
    await this.command(id, this.paths(id).repo, ['worktree', 'remove', '--force', directory]);
  }

  // complete 只移除已经提交且合并的开发 worktree，脏目录会由 Git 拒绝删除。
  async complete(id) {
    const paths = this.paths(id);
    await this.checkpoint(id, 'chore: final project checkpoint');
    if (await this.command(id, paths.repo, ['status', '--porcelain'])) throw new Error('主目录有未提交修改，已保留 worktree 等待处理');
    if (await this.command(id, paths.repo, ['branch', '--show-current']) !== paths.mainBranch) throw new Error('主目录分支已切换，拒绝合并到错误分支');
    await this.command(id, paths.repo, ['merge', '--ff-only', paths.branch]);
    const head = await this.command(id, paths.repo, ['rev-parse', 'HEAD']);
    this.store.db.prepare('UPDATE goals SET merge_commit=? WHERE id=?').run(head, this.store.project(id).active_goal_id);
    await this.command(id, paths.repo, ['worktree', 'remove', paths.work]);
    await this.command(id, paths.repo, ['branch', '-d', paths.branch]);
  }
}

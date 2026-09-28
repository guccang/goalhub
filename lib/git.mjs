// 本文件为每个目标管理独立 Git 仓库、开发 worktree 和一次性评估 worktree。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);

export class ProjectGit {
  // constructor 固定所有受管项目目录的根路径。
  constructor(dataDir, store) { this.dataDir = resolve(dataDir); this.store = store; }

  // paths 只接受系统生成的 UUID，避免项目编号变成任意文件路径。
  paths(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效项目编号');
    return { repo: join(this.dataDir, 'projects', id), work: join(this.dataDir, 'worktrees', id), branch: 'goalhub/development' };
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
      await this.command(project.id, paths.repo, ['init', '-b', 'main']);
      writeFileSync(join(paths.repo, '.gitignore'), 'node_modules/\n.env\n.env.*\n!.env.example\n.DS_Store\n');
      writeFileSync(join(paths.repo, 'GOAL.md'), `# ${project.name}\n\n${project.goal}\n`);
      writeFileSync(join(paths.repo, 'AGENTS.md'), '# 项目约定\n\n创建的代码文件和函数必须添加中文注释。\nGit 分支、worktree 和提交由 GoalHub 调度器管理，请专注源码与测试，不自行切换分支或操作 worktree。\n');
      await this.command(project.id, paths.repo, ['add', '--all']);
      await this.command(project.id, paths.repo, ['commit', '-m', 'chore: initialize project goal']);
      this.store.commit(project.id, await this.command(project.id, paths.repo, ['rev-parse', 'HEAD']), '初始化项目目标');
    }
    if (!existsSync(join(paths.work, '.git'))) {
      const branches = await this.command(project.id, paths.repo, ['branch', '--list', paths.branch]);
      await this.command(project.id, paths.repo, ['worktree', 'add', ...(branches ? [] : ['-b', paths.branch]), paths.work, branches ? paths.branch : 'main']);
    }
    return paths;
  }

  // checkpoint 保存包含失败修复在内的源码进展，再快进同步主分支。
  async checkpoint(id, title) {
    const paths = this.paths(id);
    const branch = await this.command(id, paths.work, ['branch', '--show-current']);
    if (branch !== paths.branch) throw new Error('开发分支被修改，需恢复 goalhub/development 后继续');
    if (await this.command(id, paths.work, ['status', '--porcelain'])) {
      await this.command(id, paths.work, ['add', '--all']);
      await this.command(id, paths.work, ['commit', '-m', title.slice(0, 200)]);
      this.store.commit(id, await this.command(id, paths.work, ['rev-parse', 'HEAD']), title);
    }
    await this.command(id, paths.repo, ['merge', '--ff-only', paths.branch]);
  }

  // review 从已提交主分支创建隔离检查目录，防止与开发 Agent 同时写入。
  async review(id) {
    const { repo } = this.paths(id);
    const directory = join(this.dataDir, 'reviews', `${id}-${randomUUID()}`);
    mkdirSync(join(this.dataDir, 'reviews'), { recursive: true });
    await this.command(id, repo, ['worktree', 'add', '--detach', directory, 'main']);
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
    await this.command(id, paths.repo, ['worktree', 'remove', paths.work]);
  }
}

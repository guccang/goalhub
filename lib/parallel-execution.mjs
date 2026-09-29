// 本文件按依赖并行执行模块任务，并将通过自测的成果逐项送入串行集成队列。
import { phasePrompt } from './prompts.mjs';
import { validateWork } from './protocol.mjs';
import { eligibleEmployees, team } from './employees.mjs';
import { executionPolicy } from './execution-policy.mjs';

// childControl 每个任务持有独立反馈、进程和中断信号，目标暂停会传播到全部子任务。
function childControl(parent, task) {
  const abort = new AbortController();
  const child = { id: parent.id, task, abort, handles: new Set(), interrupted: new Set(), busyEmployees: parent.busyEmployees,
    assignments: parent.assignments ||= new Map(), feedback: '', halted: false, work: null, workRun: null,
    get cancelled() { return parent.cancelled || this.halted; }, get directive() { return parent.directive; } };
  parent.abort.signal.addEventListener('abort', () => abort.abort(), { once: true, signal: abort.signal });
  // stop 停止当前任务进程，保留其他员工继续执行。
  child.stop = () => { child.halted = true; abort.abort(); for (const handle of child.handles) handle.stop(); };
  return child;
}

// taskChecks 排除不再适用的验收项，每个执行结果独立记录。
function taskChecks(engine, task) { return engine.store.checks(engine.currentProjectId).filter(check => task.check_ids.includes(check.id) && check.status !== 'retired'); }

// executeTask 持有员工租约直至本任务自测和集成结束，防止测试阶段被另一目标复用员工。
async function executeTask(engine, parent, task, integrate) {
  const { store, git } = engine, id = parent.id, child = childControl(parent, task);
  parent.children.set(task.id, child);
  let releaseEmployee, releaseSlot, paths;
  try {
    const projectSettings = JSON.parse(store.db.prepare('SELECT settings FROM projects WHERE id=?').get(id).settings);
    releaseSlot = await engine.taskSlots?.acquire(id, executionPolicy(projectSettings).maxParallelTasks, child.abort.signal);
    releaseEmployee = await engine.leasePool?.acquire(`${id}:${task.assignee}`, child.abort.signal);
    child.leasedEmployee = task.assignee;
    if (child.cancelled || parent.directive) return;
    paths = await git.ensureTask(id, task);
    const workspace = store.taskWorkspace(task);
    // 已写入 Git 但服务尚未来得及更新数据库时，凭候选祖先关系恢复接纳结果。
    if (workspace.candidate_commit && ['accepting', 'accepted'].includes(workspace.status)) {
      let accepted = false;
      try { await git.command(id, git.paths(id).work, ['merge-base', '--is-ancestor', workspace.candidate_commit, 'HEAD']); accepted = true; } catch { /* 尚未集成的候选继续验证。 */ }
      if (accepted && store.taskCurrent(id, task)) { store.saveWorkspace(task, { status: 'accepted', accepted_commit: workspace.candidate_commit }); store.task(task.id, 'done', task.result); return; }
    }
    let feedback = [parent.feedback, task.result].filter(Boolean).join('\n');
    for (let attempt = 0; attempt < 3 && !child.cancelled && !parent.directive; attempt++) {
      let candidate;
      try {
        if (!store.taskCurrent(id, task)) return;
        store.task(task.id, 'running', feedback, true);
        const prompt = phasePrompt('developer', { context: engine.context(id), task, feedback });
        const result = validateWork(await engine.agent(child, 'developer', paths.work, prompt, true, task.assignee));
        engine.assertActive(child);
        if (parent.directive || !store.taskCurrent(id, task)) return;
        const commit = await git.checkpointDirectory(id, paths.work, `feat: ${task.title}`);
        if (result.status === 'needs_input') { store.task(task.id, 'blocked', result.summary); await engine.ask(child, result.questions, result.summary); parent.needsInput = true; return; }
        store.reviseChecks(id, result.checkUpdates, { taskId: task.id, source: task.assignee });
        if (result.status === 'retry') throw new Error(result.summary);
        const spec = JSON.parse(task.spec || '{}');
        if ((spec.inputs || spec.outputs) && !result.handoff) throw new Error('模块完成结果缺少 handoff，请提交与真实代码一致的接口位置、调用示例和验证方法');
        store.db.prepare('UPDATE tasks SET handoff=? WHERE id=? AND version=?').run(result.handoff || result.summary, task.id, task.version);
        store.task(task.id, 'self_testing', result.summary); child.stage = 'self-test'; child.commit = commit;
        for (const check of taskChecks(engine, task)) if (!await engine.test(child, check, paths.work, task.assignee)) throw new Error(`模块自测失败：${check.title}`);
        await git.command(id, paths.work, ['diff', '--exit-code', 'HEAD']);
        store.saveWorkspace(task, { candidate_commit: commit, status: 'queued' });
        store.task(task.id, 'queued_merge', result.summary);
        await integrate(async () => {
          engine.assertActive(child);
          if (parent.directive || !store.taskCurrent(id, task)) return;
          store.task(task.id, 'integrating', result.summary);
          candidate = await git.candidateTask(id, task, commit);
          if (candidate.conflict) {
            const repair = phasePrompt('developer', { context: engine.context(id), task,
              feedback: `正在集成模块成果。根据真实实现适配接口并解决冲突，保留双方功能。${candidate.conflict}。不要自行执行 Git；调度器会保存修复。` });
            const fixed = validateWork(await engine.agent(child, 'developer', candidate.directory, repair, true, task.assignee));
            if (fixed.status !== 'done') throw new Error(fixed.summary);
            store.reviseChecks(id, fixed.checkUpdates, { taskId: task.id, source: task.assignee });
          }
          engine.assertActive(child);
          const merged = await git.checkpointDirectory(id, candidate.directory, `merge: ${task.title}`);
          child.stage = 'integration'; child.commit = merged;
          // 回归已接纳模块及当前模块；尚未实现的后续集成任务不会提前运行。
          const accepted = store.tasks(id).filter(item => item.status === 'done' || item.id === task.id);
          const checkIds = new Set(accepted.flatMap(item => item.check_ids));
          for (const check of store.checks(id).filter(check => checkIds.has(check.id) && check.status !== 'retired')) {
            if (!await engine.test(child, check, candidate.directory, task.assignee)) throw new Error(`集成回归失败：${check.title}`);
          }
          await git.command(id, candidate.directory, ['diff', '--exit-code', 'HEAD']);
          engine.assertActive(child);
          if (parent.directive || !store.taskCurrent(id, task)) return;
          // 先登记准确候选，崩溃恢复可确认合并是否已发生，避免重复执行。
          store.saveWorkspace(task, { candidate_commit: merged, status: 'accepting' });
          await git.acceptCandidate(id, task, candidate, merged);
          store.task(task.id, 'done', result.summary);
          store.resolveRepairs(id, task.id, result.resolvedRepairIds);
          store.event(id, 'task.completed', JSON.stringify({ taskId: task.id, title: task.title, employeeId: task.assignee }));
        });
        return;
      } catch (error) {
        if (child.cancelled || parent.directive || !store.taskCurrent(id, task)) return;
        feedback = error.message;
        // 失败候选保存在任务分支，下一轮可基于真实集成结果修复接口。
        if (candidate) {
          try {
            const saved = await git.checkpointDirectory(id, candidate.directory, `chore: preserve integration attempt ${task.title}`);
            await git.command(id, paths.work, ['merge', '--no-edit', saved]);
          } catch (saveError) { store.event(id, 'integration.preserved', `失败现场保留：${candidate.directory}；${saveError.message}`); candidate = null; }
        }
        store.task(task.id, attempt === 2 ? 'blocked' : 'pending', feedback);
        store.event(id, 'task.retry', JSON.stringify({ taskId: task.id, attempt: attempt + 1, reason: feedback }));
      } finally {
        // 集成中被中断时先保存员工已经写入的内容；有未解决冲突则保留完整现场。
        if (candidate && (child.cancelled || parent.directive)) {
          try {
            const saved = await git.checkpointDirectory(id, candidate.directory, `chore: interrupted integration ${task.title}`);
            await git.command(id, paths.work, ['merge', '--no-edit', saved]);
          } catch (error) { store.event(id, 'integration.preserved', `中断现场保留：${candidate.directory}；${error.message}`); candidate = null; }
        }
        if (candidate) await git.removeCandidate(id, candidate.directory).catch(error => store.event(id, 'git.cleanup_failed', error.message));
      }
    }
  } catch (error) {
    if (!child.cancelled && store.taskCurrent(id, task)) store.task(task.id, 'blocked', error.message);
  } finally {
    // 中断仅保存当前任务目录，不能把其他员工的未完成代码一起提交。
    if (paths) await git.checkpointDirectory(id, paths.work, `chore: checkpoint ${task.title}`).catch(error => store.event(id, 'git.checkpoint_failed', error.message));
    if ((child.cancelled || parent.directive) && store.taskCurrent(id, task)) store.task(task.id, 'pending', '执行已中断，成果保留');
    child.abort.abort(); releaseEmployee?.(); releaseSlot?.(); parent.children.delete(task.id);
  }
}

// executeParallel 动态派发依赖已满足的任务，失败和取消不会阻止无关任务继续。
export async function executeParallel(engine, parent) {
  const { store } = engine, id = parent.id, jobs = new Map(), reserved = new Set();
  engine.currentProjectId = id; parent.children = new Map(); parent.reservedEmployees = reserved;
  let queue = Promise.resolve();
  // integrate 串行处理同一目标的合并，失败不使整个队列失效。
  const integrate = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  try {
    while (!parent.cancelled && !parent.directive && !parent.needsInput) {
      const tasks = store.tasks(id), pending = tasks.filter(task => ['pending', 'queued_merge'].includes(task.status));
      const limit = Math.min(executionPolicy(store.project(id).settings).maxParallelTasks, team(store.project(id)).filter(item => item.enabled).length);
      for (let task of pending) {
        if (jobs.size >= limit || parent.cancelled || parent.directive) break;
        if (jobs.has(task.id) || !task.depends_on.every(key => tasks.some(item => item.id === key && item.status === 'done'))) continue;
        if (!eligibleEmployees(store.project(id), task).some(employee => employee.id === task.assignee)) {
          const leader = team(store.project(id)).find(item => item.isLead)?.id;
          if (reserved.has(leader)) continue;
          task = await engine.dispatch(parent, task, engine.git.paths(id).work);
          if (!task) { parent.needsInput = true; break; }
        }
        if (reserved.has(task.assignee)) continue;
        reserved.add(task.assignee);
        const current = task;
        const promise = executeTask(engine, parent, current, integrate).finally(() => { jobs.delete(current.id); reserved.delete(current.assignee); });
        jobs.set(task.id, promise);
      }
      if (jobs.size) { await Promise.race(jobs.values()); continue; }
      const outstanding = store.tasks(id).filter(task => !['done', 'cancelled'].includes(task.status));
      if (outstanding.length) {
        store.update(id, { status: outstanding.every(task => task.status === 'paused') ? 'paused' : 'blocked', summary: '尚有暂停、失败或依赖未满足的任务，请查看任务状态后处理。' });
        return false;
      }
      if (!store.tasks(id).some(task => task.status === 'done')) { store.update(id, { status: 'paused', summary: '任务已全部取消，目标未完成。' }); return false; }
      parent.feedback = '';
      return true;
    }
    return false;
  } finally {
    if (parent.cancelled || parent.directive || parent.needsInput) for (const child of parent.children.values()) child.stop();
    await Promise.allSettled(jobs.values()); await queue;
  }
}

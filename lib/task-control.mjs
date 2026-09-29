// 本文件先保存用户指令再安全暂停目标，主管只返回决策，进程与任务状态由调度器修改。
import { randomUUID } from 'node:crypto';
import { phasePrompt } from './prompts.mjs';
import { validateControl } from './protocol.mjs';

// steerParallel 同一目标的输入按到达顺序处理，不丢弃忙碌期间的新要求。
export function steerParallel(scheduler, id, content, goalId, kind) {
  const engine = scheduler.engine(id, goalId), store = engine.store, goal = store.project(id);
  if (goal.status === 'completed') throw new Error('目标已完成，请新建目标');
  const requestId = randomUUID(), key = `${id}:${goal.active_goal_id}`;
  store.db.prepare('INSERT INTO control_requests(id,project_id,goal_id,content,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(requestId, id, goal.active_goal_id, content, 'queued', new Date().toISOString());
  scheduler.inputQueues ||= new Map();
  const previous = scheduler.inputQueues.get(key) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    // 关闭期间保留排队指令，禁止队尾重新启动主管进程。
    if (scheduler.closing) {
      store.db.prepare("UPDATE control_requests SET status='interrupted',decision=? WHERE id=?").run('服务关闭，指令尚未应用', requestId);
      return;
    }
    scheduler.steering.add(id);
    let control;
    try {
      await scheduler.pause(id, goal.active_goal_id);
      if (scheduler.closing) throw new Error('服务关闭，指令尚未应用');
      store.db.prepare("UPDATE control_requests SET status='processing' WHERE id=?").run(requestId);
      let decision;
      // 明确停止不等待模型响应；其余自然语言交给主管识别范围和动作。
      if (/^(?:暂停|停止)(?:当前)?(?:目标|执行|全部任务)?[。！!\s]*$/.test(content.trim())) decision = { action: 'pause', taskIds: [], summary: '按用户要求保持暂停', resume: false };
      else if (kind === 'resume') decision = { action: 'resume', taskIds: [], summary: '按用户要求继续当前目标', resume: true };
      else {
        const paths = await engine.git.ensure(store.project(id));
        control = { id, abort: new AbortController(), cancelled: false, handles: new Set(), busyEmployees: new Set(), interrupted: new Set(), assignments: new Map() };
        const input = phasePrompt('controller', { context: engine.context(id), instruction: content });
        control.promise = engine.agent(control, 'controller', paths.work, input);
        engine.controls.set(id, control); scheduler.refresh(id);
        decision = validateControl(await control.promise);
        if (control.cancelled) throw new Error('主管处理已暂停，输入已保留');
      }
      const tasks = store.tasks(id);
      if (decision.taskIds.some(key => !tasks.some(task => task.id === key))) throw new Error('主管引用了不属于当前目标的任务');
      if (['cancel_tasks', 'pause_tasks'].includes(decision.action)) {
        if (decision.taskIds.some(key => ['done', 'cancelled'].includes(tasks.find(task => task.id === key).status))) throw new Error('已集成任务需要重新规划清理，不能直接取消');
        store.db.exec('BEGIN IMMEDIATE');
        try {
          for (const key of decision.taskIds) store.controlTask(id, key, decision.action === 'cancel_tasks' ? 'cancel' : 'pause');
          store.db.exec('COMMIT');
        } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      }
      if (decision.action === 'replan') { store.instruction(id, content, 'requirement'); store.requestReplan(id, decision.summary); }
      else if (kind === 'repair' && decision.action === 'resume') store.instruction(id, content, 'repair');
      store.update(id, { status: 'paused', summary: decision.summary });
      store.event(id, 'control.decision', JSON.stringify({ requestId, ...decision }));
      store.db.prepare("UPDATE control_requests SET status='applied',decision=? WHERE id=?").run(JSON.stringify(decision), requestId);
      if (control) { engine.controls.delete(id); control = null; scheduler.refresh(id); }
      // 后续指令尚未处理时不启动旧任务，队尾决定最终是否恢复。
      const queued = store.db.prepare("SELECT count(*) AS total FROM control_requests WHERE goal_id=? AND status='queued'").get(goal.active_goal_id).total;
      if (!queued && decision.resume && !scheduler.closing) {
        try { scheduler.start(id, { goalId: goal.active_goal_id, fromControl: true }); }
        catch (error) {
          store.update(id, { status: store.questions(id).some(question => question.answer === null) ? 'waiting_input' : 'paused', summary: `指令已应用，暂未继续：${error.message}` });
          store.event(id, 'control.resume_blocked', error.message);
        }
      }
    } catch (error) {
      store.db.prepare('UPDATE control_requests SET status=?,decision=? WHERE id=?').run(scheduler.closing ? 'interrupted' : 'failed', error.message, requestId);
      store.update(id, { status: 'paused', summary: `用户指令未应用，目标保持暂停：${error.message}` });
      throw error;
    } finally {
      if (control) { engine.controls.delete(id); scheduler.refresh(id); }
      scheduler.steering.delete(id);
    }
  });
  scheduler.inputQueues.set(key, work);
  work.finally(() => { if (scheduler.inputQueues.get(key) === work) scheduler.inputQueues.delete(key); }).catch(() => {});
  return work;
}

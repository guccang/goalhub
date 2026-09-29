// 本文件规范项目级并行设置，旧目标保持串行，新建目标可显式采用模块并行。
// executionPolicy 合并目标覆盖值与项目默认值，并校验允许的模式、粒度及容量。
export function executionPolicy(value = {}, fallback = {}) {
  const mode = value.executionMode ?? fallback.executionMode ?? 'serial';
  const granularity = value.taskGranularity ?? fallback.taskGranularity ?? 'auto';
  const limit = Number(value.maxParallelTasks ?? fallback.maxParallelTasks ?? 3);
  if (!['serial', 'parallel'].includes(mode)) throw new Error('执行模式无效');
  if (!['auto', 'coarse', 'standard', 'fine'].includes(granularity)) throw new Error('任务拆分粒度无效');
  if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('并行任务上限必须为 1–16');
  return { executionMode: mode, taskGranularity: granularity, maxParallelTasks: limit };
}

// TaskSlots 按项目限制实际任务数，等待可取消，不以目标数量冒充执行容量。
export class TaskSlots {
  // constructor 初始化项目容量和等待队列。
  constructor() { this.projects = new Map(); }
  // acquire 公平分配任务名额，持有者退出后才释放。
  acquire(key, limit, signal) {
    const state = this.projects.get(key) || { active: 0, queue: [] };
    this.projects.set(key, state);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('执行已暂停'));
      const item = { limit, grant: null };
      // cancel 撤回尚未启动的等待项。
      const cancel = () => { const i = state.queue.indexOf(item); if (i >= 0) state.queue.splice(i, 1); reject(new Error('执行已暂停')); this.pump(state); };
      item.grant = () => {
        signal.removeEventListener('abort', cancel); state.active++;
        let released = false;
        resolve(() => { if (!released) { released = true; state.active--; this.pump(state); } });
      };
      signal.addEventListener('abort', cancel, { once: true }); state.queue.push(item); this.pump(state);
    });
  }
  // pump 按队首容量推进，项目策略降低后不强杀已有任务。
  pump(state) { while (state.queue.length && state.active < state.queue[0].limit) state.queue.shift().grant(); }
}

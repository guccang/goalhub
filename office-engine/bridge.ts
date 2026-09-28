// 本文件替换 Electron IPC：看板查询和信封消息均来自已读取的 GoalHub 项目记录。
type Message = { from: string; targets: string[]; act: string; needsHuman: boolean };
const subscribers = new Set<(message: Message) => void>();
export const goalhubBridge = {
  project: null as any, motion: true, scene: null as any,
  // attach 注册当前场景，用于相机和隐藏页面时的生命周期管理。
  attach(scene: any) { this.scene = scene; },
  // detach 只清理当前场景，避免旧组件卸载覆盖新组件。
  detach(app: any) { if (this.scene?.app === app) this.scene = null; },
  // hiveTasks 将真实任务和用户问题转换为原版纸条看板格式。
  async hiveTasks() {
    const project = this.project;
    const tasks = (project?.tasks || []).map((task: any) => ({ id: task.id, status: task.status === 'done' ? 'done' : task.status === 'running' ? 'doing' : task.status === 'blocked' || project.status === 'blocked' ? 'blocked' : 'todo', assignee: task.assignee || undefined }));
    for (const question of project?.questions || []) if (question.answer === null) tasks.push({ id: question.id, status: 'blocked', assignee: project?.office?.questionOwner || project?.office?.actors?.find((actor: any) => actor.isLead && actor.enabled)?.id, humanQA: [{ q: question.prompt, a: '' }] });
    return { tasks };
  },
  // onHiveMessage 为原信封动画订阅真实的任务交接事件。
  onHiveMessage(listener: (message: Message) => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
  // emit 发布一条经过快照游标去重的交接。
  emit(message: Message) { subscribers.forEach(listener => listener(message)); },
};

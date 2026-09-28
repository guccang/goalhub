// 本文件限制跨目标历史的提示词体积，完整需求与日志仍由历史记录保存。
// previousIteration 只保留上一轮的简短事实和定位，不携带旧目标或原始任务。
export function previousIteration(project) {
  if (!project) return [];
  return [{ id: project.active_goal_id || project.id, status: project.status,
    summary: (project.summary || '').slice(0, 240), mergeCommit: project.merge_commit || null }];
}

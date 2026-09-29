// 本文件提供任务文档入口，英文文件名保持一致，文档正文仍按员工语言显示。
import { escapeFeedback as escape } from './feedback.js';

// taskDocumentLinks 通过受限服务端入口打开文档，不向页面暴露任意文件读取能力。
export function taskDocumentLinks(project, task = null) {
  if (!(task?.documents || project.taskDocuments)) return '';
  const goalId = project.viewed_goal_id || project.active_goal_id;
  const files = task ? ['assignment.md', 'plan.md', 'handoff.md'] : ['requirements.md', 'sources.md', 'handoff.md'];
  return files.map(file => {
    const query = new URLSearchParams({ goalId, file, ...(task ? { assignmentId: task.assignmentId || task.id } : {}) });
    return `<a href="/api/projects/${escape(project.id)}/task-documents?${escape(query.toString())}" target="_blank" rel="noopener">${file}</a>`;
  }).join(' · ');
}

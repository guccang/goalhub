import { taskDocumentLinks } from './task-documents.js';
// 本文件把实际执行记录整理成工作进展；工具完成不等于任务验收通过。
import { escapeFeedback as escape } from './feedback.js';

export const workLabels = { self_testing: '模块自测中', queued_merge: '等待集成', integrating: '集成验证中', cancelled: '已取消', paused: '已暂停', pending: '待执行', running: '进行中', done: '已完成', completed: '本轮结束', failed: '失败', blocked: '受阻', interrupted: '已中断', passed: '已通过' };

// inputContext 只提取平台生成的数据段，旧格式保留未知，不猜测模型实际收到的内容。
export function inputContext(input = '') {
  const sections = {};
  const data = input.split('<project-data>')[1]?.split('</project-data>')[0] || '';
  for (const [label, key] of [['项目资料', 'project'], ['当前需求', 'requirements'], ['本轮任务', 'work']]) {
    const line = data.split(`${label}：\n`)[1]?.split('\n')[0];
    try { sections[key] = JSON.parse(line); } catch { /* 老记录没有结构化段时显示未记录。 */ }
  }
  return sections;
}

// progressEvents 兼容宿主结构化事件及旧版文本事件，仅提取可解释的工作活动。
export function progressEvents(events = []) {
  const rows = [];
  for (const event of events) {
    if (event.category && typeof event.text === 'string') { rows.push(event); continue; }
    let data;
    try { data = JSON.parse(event.content); } catch { /* 旧事件为普通文本。 */ }
    const item = data?.item;
    let title = '', text = '', category = '', steps;
    if (item?.type === 'file_change') {
      title = event.kind.endsWith('started') ? '正在修改文件' : '文件修改已记录'; category = 'tool';
      text = (item.changes || []).map(change => change.path).join('\n');
    } else if (item?.type === 'command_execution') {
      title = item.status === 'in_progress' ? '正在执行命令' : `命令结束${item.exit_code != null ? `，退出码 ${item.exit_code}` : ''}`;
      text = item.command || ''; category = 'tool';
    } else if (item?.type === 'todo_list') {
      title = '员工本轮工作计划'; category = 'plan';
      steps = (item.items || []).map(step => ({ text: String(step.text || ''), completed: step.completed === true }));
      text = steps.map(step => `${step.completed ? '已做' : '待做'}：${step.text}`).join('\n');
    } else if (item?.type === 'agent_message') {
      title = '员工进展说明'; text = item.text || ''; category = 'report';
    } else if (!data && /agent\.(item\.(?:completed|started)|output|message|text)$/.test(event.kind)) {
      text = String(event.content || '').trim();
      const command = /^(?:["']?(?:[A-Z]:[\\/]|\/)|(?:powershell|pwsh|cmd|node|python|git|npm|npx|bash)\b)/i.test(text);
      if (!command && event.kind.endsWith('started')) continue;
      title = command ? (event.kind.endsWith('started') ? '正在执行工具（历史文本）' : '工具活动（历史文本）') : '员工进展说明'; category = command ? 'tool' : 'report';
      if (command) text = text.split('\n')[0];
    } else if (event.kind === 'agent.failed' || event.kind === 'test.failed') {
      title = '执行错误'; text = event.content; category = 'error';
    }
    if (text || category === 'plan') rows.push({ id: event.id, at: event.created_at, title, text, category, ...(steps ? { steps } : {}) });
  }
  return rows;
}

// renderProgress 显示有时间的进展；未上报明确说明不等于没有工作。
export function renderProgress(events, status = 'running') {
  const rows = progressEvents(events), reports = rows.filter(row => row.category !== 'tool').slice(-6).reverse();
  const tools = rows.filter(row => row.category === 'tool').slice(-12).reverse();
  // timeline 把员工说明与工具证据分别展示，命令细节只在主动展开后显示。
  function timeline(items) {
    return `<ol class="work-timeline">${items.map(row => `<li><div><strong>${escape(row.title)}</strong><time>${escape(new Date(row.at).toLocaleString())}</time></div><p>${escape(row.category === 'tool' ? activityDescription(row) : row.text)}</p>${row.category === 'tool' ? `<details data-progress-detail="${escape(row.id)}"><summary>查看原始活动</summary><pre>${escape(row.text)}</pre></details>` : ''}</li>`).join('')}</ol>`;
  }
  return `${reports.length ? timeline(reports) : `<p class="office-help">${status === 'running' ? '本轮已启动，尚未收到员工进展说明。收到记录后会自动更新。' : '此轮未记录员工进展说明。'}</p>`}${tools.length ? `<details data-work-detail="tools"><summary>最近工具活动（${tools.length}）</summary><p class="office-help">展示最近记录中的工具活动，只证明执行过程，不代表功能验收通过。</p>${timeline(tools)}</details>` : ''}`;
}

// activityDescription 保留文件和入口名称，绝对路径与整条命令放在诊断详情。
export function activityDescription(row) {
  if (row.title.includes('文件')) return row.text.split('\n').map(path => path.replaceAll('\\', '/').split('/').slice(-2).join('/')).join('、');
  const script = row.text.match(/(?:--script\s+|-File\s+|(?:python|node)\s+)["']?([^\s"']+)/i);
  return script ? `执行 ${script[1].replaceAll('\\', '/').split('/').slice(-2).join('/')}` : '调用命令工具，具体命令见工作动态';
}

// currentEmployeeTask 优先定位本轮真实分工；负责人可查看当前正在推进的分工。
export function currentEmployeeTask(project, actor) {
  const tasks = project.tasks || [];
  const run = (project.runs || []).find(item => item.id === actor.run?.id);
  const running = task => ['running', 'self_testing', 'queued_merge', 'integrating'].includes(task.status);
  return tasks.find(task => run?.status === 'running' && run.task_id === task.id && task.assignee === actor.id && running(task))
    || tasks.find(task => task.assignee === actor.id && running(task))
    || (actor.isLead ? tasks.find(running) : null)
    || tasks.find(task => task.assignee === actor.id && ['paused', 'blocked'].includes(task.status))
    || null;
}

// renderPlanMarkdown 安全展示计划中的标题、清单与代码块，其他内容保留为普通文本。
export function renderPlanMarkdown(source) {
  const rows = String(source || '').split(/\r?\n/), html = [];
  let list = false, fence = false, code = [];
  const closeList = () => { if (list) { html.push('</ul>'); list = false; } };
  for (const row of rows) {
    if (/^\s*```/.test(row)) {
      closeList();
      if (fence) { html.push(`<pre>${escape(code.join('\n'))}</pre>`); code = []; }
      fence = !fence; continue;
    }
    if (fence) { code.push(row); continue; }
    const heading = row.match(/^(#{1,6})\s+(.+)$/);
    const item = row.match(/^\s*-\s+(?:\[([ xX])\]\s*)?(.+)$/);
    if (heading) { closeList(); html.push(`<h4>${escape(heading[2])}</h4>`); }
    else if (item) {
      if (!list) { html.push('<ul class="work-plan-list">'); list = true; }
      html.push(`<li>${item[1] == null ? '' : `<span class="work-status">${item[1].toLowerCase() === 'x' ? '已完成' : '待执行'}</span> `}${escape(item[2])}</li>`);
    } else if (row.trim()) { closeList(); html.push(`<p>${escape(row)}</p>`); }
    else closeList();
  }
  closeList();
  if (fence) html.push(`<pre>${escape(code.join('\n'))}</pre>`);
  return html.join('') || '<p class="office-help">plan.md 暂无内容。</p>';
}

// renderEmployeeWork 以当前分工的 plan.md 原文为主体，并提供同一目标的上下文文档。
export function renderEmployeeWork(project, actor, plan = {}) {
  const task = currentEmployeeTask(project, actor);
  if (!task) return `<div class="employee-workspace"><section><h3>当前执行目标</h3><p class="office-help">当前没有正在执行的分工。分工开始后，这里显示对应的 plan.md。</p></section></div>`;
  const title = escape(task.title || '未命名分工');
  const body = !task.documents ? '<p class="office-help">当前分工尚未生成 plan.md。</p>'
    : plan.taskId === task.id && plan.text != null ? `<div class="work-plan-document">${renderPlanMarkdown(plan.text)}</div>`
    : plan.taskId === task.id && plan.error ? `<p class="office-help">plan.md 读取失败：${escape(plan.error)}</p>`
    : '<p class="office-help">正在读取当前分工的 plan.md…</p>';
  return `<div class="employee-workspace"><section><h3>当前执行目标</h3><p class="work-goal">${title}</p><p>${escape(task.description || '')}</p></section>
    <section><h3>执行计划 · plan.md</h3>${body}</section>
    <section><h3>上下文引用文档</h3><p>当前分工：${taskDocumentLinks(project, task)}</p><p>当前目标：${taskDocumentLinks(project)}</p></section></div>`;
}

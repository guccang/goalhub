// 本文件把实际执行记录整理成工作进展；工具完成不等于任务验收通过。
import { escapeFeedback as escape } from './feedback.js';

export const workLabels = { pending: '待执行', running: '进行中', done: '已完成', completed: '本轮结束', failed: '失败', blocked: '受阻', interrupted: '已中断', passed: '已通过' };

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
    let title = '', text = '', category = '';
    if (item?.type === 'file_change') {
      title = event.kind.endsWith('started') ? '正在修改文件' : '文件修改已记录'; category = 'tool';
      text = (item.changes || []).map(change => change.path).join('\n');
    } else if (item?.type === 'command_execution') {
      title = item.status === 'in_progress' ? '正在执行命令' : `命令结束${item.exit_code != null ? `，退出码 ${item.exit_code}` : ''}`;
      text = item.command || ''; category = 'tool';
    } else if (item?.type === 'todo_list') {
      title = '员工本轮工作计划'; category = 'plan';
      text = (item.items || []).map(step => `${step.completed ? '已做' : '待做'}：${step.text}`).join('\n');
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
    if (text) rows.push({ id: event.id, at: event.created_at, title, text, category });
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

// renderEmployeeWork 以目标、工作、计划、成果与输入组织信息，原始日志另行折叠。
export function renderEmployeeWork(project, actor) {
  const tasks = project.tasks || [], own = tasks.filter(task => task.assignee === actor.id);
  const run = project.runs?.find(run => run.id === actor.run?.id);
  const context = run ? actor.context || {} : {};
  const events = run ? actor.progress || actor.events || [] : [];
  const current = own.find(task => task.status === 'running');
  const activities = progressEvents(events);
  const reports = activities.filter(row => row.category === 'report');
  const latest = activities.at(-1);
  const requirement = project.requirements;
  const effective = requirement?.status === 'consolidated' ? requirement.effective : null;
  const checks = project.checks || [], names = new Map(project.office?.actors.map(item => [item.id, item.name]) || []);
  const dependencies = tasks.filter(task => own.some(item => item.depends_on?.includes(task.id)));
  const done = own.filter(task => task.status === 'done');
  // taskRow 展示真实任务状态、依赖、完成条件与验收证据，不从日志推算完成率。
  function taskRow(task) {
    const relevant = checks.filter(check => task.check_ids?.includes(check.id));
    const waiting = tasks.filter(item => task.depends_on?.includes(item.id) && item.status !== 'done');
    return `<li><details data-work-detail="task-${escape(task.id)}"><summary><span class="work-status">${escape(workLabels[task.status] || task.status)}</span> ${escape(task.title)} <small>${escape(names.get(task.assignee) || task.assignee || '待分配')}</small></summary><p>${escape(task.description)}</p>${waiting.length ? `<p>等待：${escape(waiting.map(item => item.title).join('、'))}</p>` : ''}<h4>完成条件</h4><p>${escape(task.done_when || '计划未记录具体完成条件')}</p><h4>如何验证</h4>${relevant.map(check => `<details data-work-detail="check-${escape(check.id)}"><summary>${escape(check.title)} · ${escape(workLabels[check.status] || check.status)}</summary><p>${escape(check.expectation || '未记录验收说明')}</p><p>${check.checked_at ? `最近检查：${escape(new Date(check.checked_at).toLocaleString())}` : '尚未执行本项验收'}</p><pre>${escape(check.command || '')}</pre>${check.output ? `<pre>${escape(check.output)}</pre>` : ''}</details>`).join('') || '<p>未关联验收项</p>'}</details></li>`;
  }
  return `<div class="employee-workspace"><section><h3>目标是什么</h3><p class="work-goal">${escape(effective?.summary || project.goal || '尚未设置目标')}</p>${!effective ? '<p class="office-help">显示原始目标；当前有效需求尚未整理或已发生变更。</p>' : ''}</section>
    <section class="work-current"><h3>正在做什么</h3><strong>${escape(current?.title || (run?.status === 'running' ? actor.activity : own.some(task => task.status !== 'done') ? '等待下一项任务执行' : '当前没有进行中的任务'))}</strong>${reports.length ? `<p>${escape(reports.at(-1).text)}</p><small>员工最近说明 · ${escape(new Date(reports.at(-1).at).toLocaleString())} · 尚不代表验收通过</small>` : '<p class="office-help">尚无员工进展说明。</p>'}${latest && latest.category !== 'report' ? `<p class="work-last-activity">最近活动：${escape(latest.title)} · ${escape(new Date(latest.at).toLocaleString())}<br>${escape(latest.category === 'tool' ? activityDescription(latest) : latest.text)}</p>` : ''}<details data-work-detail="progress"><summary>查看本轮工作动态</summary>${renderProgress(events, run?.status)}</details></section>
    <section><h3>计划与剩余任务</h3><p>该员工已完成 ${done.length} / ${own.length} 项，剩余 ${own.length - done.length} 项。项目共 ${tasks.length} 项，已完成 ${tasks.filter(task => task.status === 'done').length} 项。</p>${own.length === 1 && own[0].status !== 'done' ? '<p class="office-help">当前计划仅给该员工分配了一个任务，尚未记录更细的阶段进度。</p>' : ''}<ol class="work-plan">${own.map(taskRow).join('') || '<li>当前目标尚未分配任务。</li>'}</ol><details data-work-detail="project-plan"><summary>项目完整计划与分工</summary><ol class="work-plan">${tasks.map(taskRow).join('')}</ol></details></section>
    <section><h3>已经做了什么</h3>${done.map(task => `<article><h4>${escape(task.title)}</h4><p>${escape(task.result || '任务已完成，但没有记录成果摘要。')}</p></article>`).join('') || '<p>暂无已通过验收的任务。过程中的修改和员工说明见上方工作动态。</p>'}</section>
    <section><h3>上下文有哪些</h3><p>当前任务依据以下资料推进；本轮实际收到的资料以执行记录为准。</p><details data-work-detail="requirements"><summary>当前需求范围与例外</summary>${['included', 'deferred', 'excluded'].map((key, index) => `<h4>${['必须完成', '允许延期', '明确排除'][index]}</h4><ul>${(effective?.[key] || []).map(item => `<li>${escape(item)}</li>`).join('') || '<li>未记录</li>'}</ul>`).join('')}</details><details data-work-detail="dependencies"><summary>前置任务与交接成果（${dependencies.length}）</summary>${dependencies.map(task => `<h4>${escape(task.title)} · ${escape(workLabels[task.status] || task.status)}</h4><p>${escape(task.result || '尚无交接成果')}</p>`).join('') || '<p>计划未登记前置任务。</p>'}</details><details data-work-detail="input"><summary>本轮实际输入概览</summary><p>${escape(context.requirements?.effective?.summary || '此轮未记录可解析的需求概览，请在诊断中查看实际提示词。')}</p><p>任务：${escape(context.work?.task?.title || '未记录')}</p><p>工作仓库：${escape(context.project?.repository || '未记录')}</p><p>本轮关联任务：${escape(context.work?.tasks?.map(task => task.title).join('、') || '未记录')}</p>${(context.work?.tasks || []).filter(task => task.status === 'done').map(task => `<p>前置交接「${escape(task.title)}」：${escape(task.result || '该旧轮次未随输入传递完成结果')}</p>`).join('')}<p>本轮修复要求：${escape(context.work?.repair?.content || '')} ${escape(context.work?.repairInstructions?.map(item => item.content).join('；') || '无')}</p></details></section>
    <section><h3>执行记录</h3>${(project.runs || []).filter(item => item.employee_id === actor.id).map(item => `<button class="run-row" data-run="${escape(item.id)}">${escape(new Date(item.created_at).toLocaleString())} · ${escape(workLabels[item.status] || item.status)} · 查看进展与结果</button>`).join('') || '<p>尚未开始执行。</p>'}</section></div>`;
}

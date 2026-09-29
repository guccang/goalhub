
// 点击遮罩时沿用取消事件，保留各弹窗的清理逻辑；内部拖拽到外部不误关闭。
let backdropDialog = null;
// outsideDialog 只判断弹窗边界外的遮罩，内容区留白不触发关闭。
function outsideDialog(event) {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return null;
  const rect = dialog.getBoundingClientRect();
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom ? dialog : null;
}
document.addEventListener('pointerdown', event => { backdropDialog = outsideDialog(event); });
document.addEventListener('click', event => {
  const dialog = outsideDialog(event), startedOutside = backdropDialog === dialog;
  backdropDialog = null;
  if (dialog && startedOutside && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
});
// 启动引导使用外部模块，兼容仅允许同源脚本的内容安全策略。
document.querySelector('#startup-retry').addEventListener('click', () => location.reload());
try {
// 本文件驱动目标工作台，定期读取 SQLite 状态并提供创建、问答、暂停和日志查询交互。
// 调用确认是执行前的必要步骤，模块加载失败时不继续开放模型调用。
const { installPromptPreviews, promptLink } = await import('./prompt-preview.js');
const { ProjectsPanel } = await import('./projects.js');
const { SetupFlow } = await import('./setup.js');
const { OfficeView } = await import('./office-view.js');
const { DeliveryPanel } = await import('./delivery.js');
const { GodPanel } = await import('./god.js');
const { EmployeeManager } = await import('./employees.js');
// $ 获取工作台内的一个 DOM 元素。
const $ = (selector) => document.querySelector(selector);
const labels = { queued: '排队中', ready: '等待需求', awaiting_approval: '等待确认', paused: '已暂停', planning: '规划中', running: '执行中', verifying: '验收中', waiting_input: '等待输入', blocked: '执行受阻，待处理', completed: '已完成', pending: '待执行', done: '已完成', passed: '已通过', failed: '未通过', interrupted: '已中断' };
const roles = { 'team-builder': 'God 搭建团队', planner: '负责人规划', coordinator: '任务分配', developer: '员工执行', evaluator: '定时评估', 'final-review': '最终评估', test: '测试验收' };
const hostLabels = { codex: 'Codex', claudecode: 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode' };
let selectedGoal = '', homeVisible = true;
const homeCards = new Map();
let selected = localStorage.getItem('goalhub.project') || '', project = null, projects = [], tab = 'tasks', busy = false, refreshInFlight = false;
let events = [], search = '', kind = '', questionsKey = '', toastTimer, eventProject = '', historyMode = false;
const markupCache = new WeakMap();
let recordsOwner = null, hasLoadedProjects = false;
const office = new OfficeView({ onAction: action, onError: toast,
  onManage: () => employees.open(selected),
  onSelect: showEmployeeRecords,
  // sendSteer 使用提交时的项目编号，避免切换项目后把指令发给另一个目标。
  onSteer: async (id, content) => { await api(`/projects/${id}/steer`, { content }); await refresh(); toast('补充指令已记录，正在继续执行'); },
});

const setup = new SetupFlow({ api, selectProject, selectGoal, refresh, toast, buildTeam: async id => { await employees.open(id, { generate: true }); } });
const panels = new ProjectsPanel({ api, selectProject, selectGoal, refresh, toast });

// selectGoal 只切换查看目标，不改变项目当前执行目标。
async function selectGoal(id) { selectedGoal = id; historyMode = false; eventProject = ''; questionsKey = ''; await refresh(); }
const deliveryPanel = new DeliveryPanel({ api, refresh, toast });
const god = new GodPanel({ api, toast });
const employees = new EmployeeManager({ api, refresh, toast });
const confirmModelRequest = installPromptPreviews({ api, setup });

// showEmployeeRecords 仅通过负责人打开项目档案，普通员工保留个人信息。
function showEmployeeRecords(actor) {
  recordsOwner = actor;
  $('#employee-panel-title').textContent = `${actor.name} · ${actor.isLead ? '项目负责人' : '员工详情'}`;
  openPanel('employee-panel');
  $('#leader-records').hidden = !actor.isLead;
  $('#leader-records-title').textContent = `${actor.name} · 项目全部记录`;
  if (actor.isLead && tab === 'activity') loadEvents().catch(error => toast(error.message));
}

// openPanel 使用独立滚动的原生对话框，不改变主页面长度。
function openPanel(id) {
  const panel = document.getElementById(id);
  $('#project-tools').open = false;
  if (!panel.open) panel.showModal();
  if (id === 'sidebar') $('#sidebar-toggle').setAttribute('aria-expanded', 'true');
}

// closePanel 恢复触发控件焦点；侧栏默认关闭，不持久化展开状态。
function closePanel(id) { document.getElementById(id).close(); }
$('#sidebar').addEventListener('close', () => $('#sidebar-toggle').setAttribute('aria-expanded', 'false'));

// html 仅在内容变化时替换节点，保留轮询期间的键盘焦点与详情展开状态。
function html(selector, value) {
  const element = $(selector);
  if (markupCache.get(element) === value) return;
  element.innerHTML = value; markupCache.set(element, value);
}

// escape 将所有模型和用户文本安全插入 HTML，不执行其内容。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

// date 将持久化 UTC 时间显示为本机时间。
function date(value, short = false) { if (!value) return '—'; return new Date(value).toLocaleString('zh-CN', short ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : {}); }

// badge 生成一致的业务状态标签。
function badge(status) { return `<span class="badge ${escape(status)}">${escape(labels[status] || status)}</span>`; }

// api 发起同源 JSON 请求并显式暴露失败原因。
async function api(path, value) {
  // 固定点击时的请求内容，等待确认期间表单或项目切换不会修改本次提交。
  if (value !== undefined) {
    value = structuredClone(value);
    // 固定操作目标，避免并发目标之间的问答、暂停和预览串线。
    if (path.match(/^\/projects\/[^/]+\/(start|approve|pause|answer|evaluate|steer|plan|prompt-preview)$/) && path.split('/')[2] === selected && project?.active_goal_id) value.goalId ??= selectedGoal || project.active_goal_id;
    await confirmModelRequest(path, value);
  }
  const response = await fetch(`/api${path}`, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}

// toast 用短提示反馈用户操作，错误不会替换已有工作区内容。
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}

// syncHomeFrame 仅给可见卡片创建独立场景，隔离引擎状态并限制显卡资源占用。
function syncHomeFrame(card) {
  if (!homeVisible || !card.visible) { card.frame?.remove(); card.frame = null; return; }
  if (!card.frame) {
    card.frame = document.createElement('iframe'); card.frame.title = `${card.project.name}办公室`;
    card.frame.src = '/office-card.html'; card.element.querySelector('.home-scene').append(card.frame);
  }
  card.frame.contentWindow?.postMessage({ type: 'office-snapshot', office: card.project.office }, location.origin);
}
const homeObserver = new IntersectionObserver(entries => {
  for (const entry of entries) { const card = homeCards.get(entry.target.dataset.id); if (card) { card.visible = entry.isIntersecting; syncHomeFrame(card); } }
});
// renderHome 保留卡片节点和焦点，多个项目独立展示名称、进度与员工场景。
function renderHome() {
  const visible = projects.filter(item => item.settings.showOfficeOnHome !== false), ids = new Set(visible.map(item => item.id));
  for (const [id, card] of homeCards) if (!ids.has(id)) { homeObserver.unobserve(card.element); card.element.remove(); homeCards.delete(id); }
  for (const item of visible) {
    let card = homeCards.get(item.id);
    if (!card) {
      const element = document.createElement('article'); element.className = 'home-office office-scene-card'; element.dataset.id = item.id;
      element.innerHTML = `<header class="office-scene-heading"><button class="text-button" data-project="${escape(item.id)}"></button><span></span></header><div class="home-scene"></div><p class="home-office-progress"></p>`;
      card = { element, project: item, visible: false, frame: null }; homeCards.set(item.id, card); $('#home-offices').append(element); homeObserver.observe(element);
    }
    card.project = item; card.element.querySelector('button').textContent = item.name;
    card.element.querySelector('header span').textContent = labels[item.status] || item.status;
    card.element.querySelector('p').textContent = `任务 ${item.done_count}/${item.task_count} · 工作中 ${item.office?.actors.filter(actor => actor.state === 'working').length || 0}`;
    syncHomeFrame(card);
  }
  $('#home-offices-empty').hidden = visible.length > 0;
}
// 接收隔离场景的员工选择，校验消息来源后固定对应项目再打开员工详情。
window.addEventListener('message', async event => {
  if (event.origin !== location.origin) return;
  const card = [...homeCards.values()].find(item => item.frame?.contentWindow === event.source);
  if (!card) return;
  if (event.data?.type === 'office-ready') { syncHomeFrame(card); return; }
  if (event.data?.type === 'office-select' && card.project.office?.actors.some(actor => actor.id === event.data.id)) {
    try { await selectProject(card.project.id); if (selected === card.project.id) office.select(event.data.id); } catch (error) { toast(error.message); }
  }
});
// 保存时绑定项目编号；失败恢复原值，历史迭代也共享当前项目的展示偏好。
$('#show-office-on-home').addEventListener('change', async event => {
  const input = event.currentTarget, id = selected, value = input.checked; input.disabled = true;
  try { await api(`/projects/${id}/display`, { showOfficeOnHome: value }); const item = projects.find(item => item.id === id); if (item) item.settings.showOfficeOnHome = value; renderHome(); }
  catch (error) { if (selected === id) input.checked = !value; toast(error.message); }
  finally { input.disabled = false; }
});

// navigation 展示真实项目及任务完成进度。
function navigation() {
  $('#project-count').textContent = projects.length;
  html('#project-list', projects.length ? projects.map((item) => `<button class="project-link ${item.id === selected ? 'selected' : ''}" data-project="${item.id}" ${item.id === selected ? 'aria-current="page"' : ''}><strong>${escape(item.name)}</strong><small><i class="status-dot ${item.status}"></i>${labels[item.status]}${item.task_count ? `　${item.done_count}/${item.task_count}` : ''}</small></button>`).join('') : '<p class="sidebar-empty">添加项目，在项目中提出需求。</p>');
}

// renderQuestions 仅在问题变化时重绘表单，轮询不会丢失正在输入的回答。
function renderQuestions() {
  const pending = project.historical ? [] : project.questions.filter((item) => item.answer === null), key = `${project.id}:${pending.map((item) => item.id).join(',')}`;
  if (questionsKey === key) return;
  questionsKey = key;
  $('#question-panel').hidden = !pending.length;
  $('#question-panel').innerHTML = pending.length ? `<h2>需要你补充信息</h2><p>${escape(project.summary)}</p><p>回答后会自动继续，已有进度和原目标会保留。</p><form id="answer-form">${pending.map((question, index) => `<label>${index + 1}. ${escape(question.prompt)}<textarea name="${question.id}" required maxlength="10000" rows="2" placeholder="填写回答"></textarea></label>`).join('')}<button class="primary" type="submit">提交回答并继续</button>${promptLink('answers')}</form>` : '';
}

// renderBlocker 展示阻断证据和恢复选择，不将重新启动误称为问题已解决。
function renderBlocker() {
  const panel = $('#blocker-panel');
  panel.hidden = project.status !== 'blocked';
  if (panel.hidden) return;
  $('#blocker-reason').textContent = project.summary || '执行未能继续，请检查最近运行记录。';
  const checks = project.checks.filter(check => check.status !== 'passed' && check.output);
  html('#blocker-evidence', checks.map(check => `<details><summary>${escape(check.title)}</summary><p><code>${escape(check.command)}</code></p><pre>${escape(check.output)}</pre></details>`).join('') || '<p>暂无失败验收输出，请查看输入与输出中的最近失败轮次。</p>');
  $('#blocker-timeout').textContent = `当前每条验收命令的总时限为 ${project.settings.testTimeoutSeconds} 秒；命令内包含多项测试时，共用这个时限。`;
  // 定期刷新仅更新证据，保留用户正在输入的修复要求；切换目标时清空。
  const owner = `${project.id}:${project.active_goal_id}`;
  if (panel.dataset.owner !== owner) { $('#blocker-instruction').value = ''; panel.dataset.owner = owner; }
  panel.querySelectorAll('button, textarea').forEach(control => { control.disabled = busy || !!project.historical || project.active; });
}

// renderProject 更新任务与证据区域，保留用户打开的测试详情。
function renderProject() {
  $('#office-home').hidden = !homeVisible || !projects.length;
  $('#project-tools').hidden = homeVisible || !project;
  $('#empty').hidden = !!project; $('#project').hidden = homeVisible || !project;
  if (!project) { office.setVisible(false); return; }
  panels.render(project); setup.syncProject(project); deliveryPanel.render(project);
  office.update(project, busy || !!project.historical || !project.active_goal_id); office.setVisible(!homeVisible);
  $('#office-view').hidden = false;
  if (recordsOwner) recordsOwner = project.office?.actors.find(actor => actor.id === recordsOwner.id) || null;
  $('#leader-records').hidden = !recordsOwner?.isLead;
  $('#project-title').textContent = project.name; document.title = homeVisible ? '办公室总览 · GoalHub' : `${project.name} · GoalHub`;
  html('#project-status', badge(project.status)); $('#project-created').textContent = `创建于 ${date(project.created_at, true)}`;
  html('#project-actions', project.historical || !project.active_goal_id ? '' : project.active ? '<button class="secondary" data-action="pause">暂停执行</button>' : project.status === 'queued' ? '<button class="secondary" data-action="pause">暂停排队</button>' : project.status === 'completed' ? '<span class="badge completed">✓ 已通过验收</span>' : ['blocked', 'waiting_input', 'awaiting_approval'].includes(project.status) ? `<button class="primary" data-action="attention">${project.status === 'blocked' ? '查看原因并处理' : project.status === 'waiting_input' ? '回答问题' : '确认计划'}</button>` : '<button class="primary" data-action="start">继续执行</button>');
  $('#project-actions').querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  $('#goal-text').textContent = project.goal;
  const stage = project.status === 'completed' ? 4 : project.status === 'awaiting_approval' ? 2 : project.resume_phase === 'execute' ? 3 : 1;
  $('#pipeline').innerHTML = ['理解需求', '计划与任务', '确认计划', '实施与验收'].map((name, index) => `<div class="pipeline-step ${index < stage ? 'finished' : index === stage ? 'active' : ''}">${name}</div>`).join('');
  $('#summary').textContent = project.summary || (project.status === 'planning' ? '规划 Agent 正在分析目标、拆解任务与制定测试项目。' : '目标已保存，等待开始执行。');
  $('#summary').classList.toggle('warning', ['blocked', 'waiting_input'].includes(project.status));
  $('#office-project-name').textContent = project.name;
  $('#show-office-on-home').checked = projects.find(item => item.id === project.id)?.settings.showOfficeOnHome !== false;
  renderQuestions();
  renderPlanPreview();
  renderBlocker();
  if ($('#blocker-panel').hidden && $('#plan-preview').hidden && $('#question-panel').hidden && $('#attention-dialog').open) closePanel('attention-dialog');
  $('#task-count').textContent = project.tasks.length ? `${project.tasks.filter((task) => task.status === 'done').length}/${project.tasks.length}` : '';
  const openedTasks = new Set([...document.querySelectorAll('#task-list details[open]')].map((item) => item.dataset.task));
  const taskCards = project.tasks.map((task, index) => `<article class="task-item"><span class="task-marker ${task.status}">${task.status === 'done' ? '✓' : task.status === 'running' ? '›' : index + 1}</span><div class="task-content"><div class="task-heading"><h3>${escape(task.title)}</h3>${project.queue?.assignments?.find(item => item.goalId === project.active_goal_id && item.employeeId === task.assignee && item.waiting) ? `<span class="badge">等待员工空闲</span>` : badge(task.status)}</div><p>${escape(task.description)}</p><div class="task-meta"><span>执行员工：${escape(project.settings.employees?.find(employee => employee.id === task.assignee)?.name || task.assignee || '等待负责人分配')}</span><span>${escape((task.depends_on || []).map(id => project.tasks.find(item => item.id === id)).filter(item => item && item.status !== 'done').map(item => '等待：' + item.title).join('；') || '前置任务已满足')}</span><span>${task.check_ids.length} 项验收</span>${promptLink(task.assignee ? 'developer' : 'coordinator', `data-task-id="${escape(task.id)}"`)}${task.attempts ? `<span>已执行 ${task.attempts} 轮</span>` : ''}</div>${task.result ? `<details data-task="${task.id}" ${openedTasks.has(task.id) ? 'open' : ''}><summary>最近执行结果</summary><p>${escape(task.result)}</p></details>` : ''}</div></article>`);
  $('#task-list').innerHTML = project.tasks.length ? `<div class="task-board">${[['pending','待办'],['running','进行中'],['blocked','阻塞'],['done','完成']].map(([status,title]) => `<section class="task-column"><h3>${title}</h3>${project.tasks.map((task,i) => (['pending','running','done'].includes(task.status) ? task.status : 'blocked') === status ? taskCards[i] : '').join('') || '<p class="muted">暂无任务</p>'}</section>`).join('')}</div>` : '<div class="empty-section">规划完成后，这里会展示按顺序执行的小任务。<br>每个任务都会关联可执行的测试项目。</div>';
  renderInspector(); renderRuns();
}

// renderPlanPreview 展示真实任务与测试命令，待确认计划始终可见。
function renderPlanPreview() {
  const waiting = project.status === 'awaiting_approval' && !project.historical;
  const visible = waiting || project.status === 'planning';
  $('#plan-preview').hidden = !visible;
  if (!visible) return;
  const tasks = project.tasks.map((task, index) => `<li><strong>${index + 1}. ${escape(task.title)}</strong><p>${escape(task.description)}</p><small>验收：${task.check_ids.map(id => escape(project.checks.find(check => check.id === id)?.title || id)).join('、')}</small></li>`).join('');
  const checks = project.checks.map(check => `<li><strong>${escape(check.title)}</strong><p>${escape(check.expectation)}</p><code>${escape(check.command)}</code></li>`).join('');
  html('#plan-preview', `<div class="plan-heading"><div><small>总体计划与任务拆解</small><h2>${waiting ? '计划已就绪，等待你确认' : project.status === 'planning' ? '正在拆解目标' : '已确认的实施计划'}</h2></div>${waiting ? `<button class="secondary" data-action="edit-plan">调整计划</button><button class="primary" data-action="approve" ${project.active || busy ? 'disabled' : ''}>确认计划并开始实现</button>${promptLink()}` : ''}</div><p>${escape(project.summary)}</p>${tasks ? `<details ${waiting ? 'open' : ''}><summary>${project.tasks.length} 个任务 · ${project.checks.length} 项测试 · ${project.settings.confirmationMode === 'auto' ? '自动确认' : '人工确认'}</summary><div class="plan-columns"><div><h3>执行任务</h3><ol>${tasks}</ol></div><div><h3>验收项目</h3><ol>${checks}</ol></div></div></details>` : '<p>规划 Agent 会分析目标并制定可执行的测试；需要信息时将在下方提问。</p>'}`);
}

// renderInspector 展示评估、实际测试结果和 Git 版本证据。
function renderInspector() {
  const evaluating = project.runs.some((run) => ['evaluator', 'final-review'].includes(run.role) && run.status === 'running');
  $('#evaluation-state').innerHTML = evaluating ? badge('running') : '<span class="subtle">独立检查</span>';
  $('#evaluation-copy').textContent = `每 ${project.settings.evaluationMinutes} 分钟检查进度，发现阻断后协调修复。`;
  $('#next-evaluation').textContent = evaluating ? '正在评估' : project.next_evaluation ? new Date(project.next_evaluation).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : project.status === 'completed' ? '已完成' : '—';
  $('#evaluate-button').disabled = busy || evaluating || !project.active || project.status !== 'running';
  const latest = project.evaluation;
  if (latest) { let content = latest.content; try { content = JSON.parse(content).summary; } catch {} $('#last-evaluation').textContent = `最近评估：${content}`; }
  else $('#last-evaluation').textContent = '';
  $('#check-count').textContent = `${project.checks.filter((check) => check.status === 'passed').length}/${project.checks.length} 通过`;
  const opened = new Set([...document.querySelectorAll('#check-list details[open]')].map((item) => item.dataset.check));
  $('#check-list').innerHTML = project.checks.length ? project.checks.map((check) => `<details class="check-item" data-check="${check.id}" ${opened.has(check.id) ? 'open' : ''}><summary><span class="check-symbol ${check.status}">${check.status === 'passed' ? '✓' : check.status === 'failed' ? '!' : '○'}</span><span>${escape(check.title)}</span>${badge(check.status)}</summary><p>${escape(check.expectation)}</p><code>${escape(check.command)}</code>${check.output ? `<pre>${escape(check.output)}</pre>` : ''}</details>`).join('') : '<p class="subtle">规划后自动生成验收项目。</p>';
  $('#commit-list').innerHTML = project.commits.slice(0, 5).map((commit) => `<div class="commit"><div><strong>${escape(commit.title)}</strong><small><code>${escape(commit.hash.slice(0, 7))}</code>${date(commit.created_at, true)}</small></div></div>`).join('') || '<p class="subtle">执行开始后创建独立仓库。</p>';
  $('#repo-path').textContent = project.paths?.repo || '';
  $('#settings-list').innerHTML = `<dt>执行宿主</dt><dd>${hostLabels[project.settings.hostType]}</dd><dt>模型</dt><dd>${escape(project.settings.model || '宿主默认')}</dd><dt>Agent 时限</dt><dd>${project.settings.agentTimeoutMinutes} 分钟</dd><dt>测试时限</dt><dd>${project.settings.testTimeoutSeconds} 秒</dd><dt>连续未推进</dt><dd>${project.failures} / 3 轮</dd>`;
}

// renderRuns 列出每轮输入输出的入口。
function renderRuns() {
  html('#run-list', project.runs.map((run) => `<button class="run-row" data-run="${run.id}"><span class="run-role">${roles[run.role] || escape(run.role)}</span>${badge(run.status)}<time>${date(run.created_at, true)}</time><span aria-hidden="true">›</span></button>`).join('') || '<p class="empty-section">执行开始后，每轮输入与输出都会保存在这里。</p>');
}

// renderEvents 展示可查询的日志，长内容按需展开。
function renderEvents() {
  const opened = new Set([...document.querySelectorAll('#event-list details[open]')].map((item) => item.dataset.event));
  html('#event-list', events.length ? events.map((event) => `<article class="event"><div class="event-head"><time>${date(event.created_at, true)}</time><span>${escape(event.kind)}</span>${event.run_id ? `<button class="text-button" data-run="${event.run_id}">查看轮次</button>` : ''}</div>${event.content.length > 500 ? `<details data-event="${event.id}" ${opened.has(String(event.id)) ? 'open' : ''}><summary>${escape(event.content.slice(0, 110))}…</summary><pre>${escape(event.content)}</pre></details>` : `<pre>${escape(event.content)}</pre>`}</article>`).join('') : '<p class="event-list-empty">暂无匹配记录。</p>');
  $('#older-events').disabled = !events.length;
}

// loadEvents 按项目、搜索条件和游标读取 SQLite 步骤记录。
async function loadEvents(older = false) {
  if (!selected) return;
  const id = selected, goal = selectedGoal, query = new URLSearchParams({ search, kind, limit: '100' });
  if (selectedGoal) query.set('goal', selectedGoal);
  if (older && events.length) query.set('before', events[0].id);
  const rows = await api(`/projects/${id}/events?${query}`);
  if (id !== selected || goal !== selectedGoal) return;
  events = older ? [...rows, ...events] : rows; eventProject = id;
  if (older) { historyMode = true; if (!rows.length) toast('已经是最早的记录'); }
  renderEvents();
}

// refresh 轮询持久化状态，避免并发响应覆盖刚切换的项目。
async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const [list, status, usage] = await Promise.all([api('/projects?offices=1'), api('/status'), api('/usage')]);
    panels.global(usage);
    projects = list; renderHome();
    $('#connection').textContent = status.runtime.available ? '本机服务已连接' : '请配置运行模块';
    $('#connection-dot').className = `connection-dot ${status.runtime.available ? 'connected' : 'error'}`;
    $('#connection').title = status.runtime.message;
    if (!projects.some((item) => item.id === selected)) selected = projects[0]?.id || '';
    navigation();
    if (selected) {
      const id = selected, goal = selectedGoal, detail = await api(selectedGoal ? `/projects/${id}/goals/${selectedGoal}` : `/projects/${id}`);
      if (id !== selected || goal !== selectedGoal) return;
      // 历史档案仍从当前办公室员工进入，历史执行操作保持禁用。
      if (detail.historical) detail.office = (await api(`/projects/${id}/office`));
      if (id !== selected || goal !== selectedGoal) return;
      project = detail; renderProject();
      if (tab === 'activity' && (!historyMode || eventProject !== selected)) await loadEvents();
    } else { project = null; renderProject(); }
    hasLoadedProjects = true; $('#startup-state').hidden = true;
  } catch (error) {
    if (!hasLoadedProjects) { $('#empty').hidden = true; $('#startup-state').hidden = false; $('#startup-message').textContent = '项目读取失败，正在重试。请检查本地服务是否已启动。'; $('#startup-retry').hidden = false; }
    $('#connection').textContent = '连接中断，正在重试'; $('#connection-dot').className = 'connection-dot error'; office.disconnected(); for (const card of homeCards.values()) card.frame?.contentWindow?.postMessage({ type: 'office-offline' }, location.origin); }
  finally { refreshInFlight = false; }
}

// selectProject 清理上一个项目的筛选和表单状态。
async function selectProject(id) {
  homeVisible = false; renderHome();
  recordsOwner = null;
  for (const id of ['sidebar', 'employee-panel', 'goal-dialog', 'usage-dialog', 'attention-dialog', 'delivery-summary-dialog', 'delivery-dialog']) closePanel(id);
  selectedGoal = ''; selected = id; localStorage.setItem('goalhub.project', id); questionsKey = ''; historyMode = false; events = []; search = ''; kind = '';
  $('#log-search').reset();
  const detail = await api(`/projects/${id}`);
  if (id !== selected) return;
  project = detail; navigation(); renderProject();
  if (tab === 'activity') await loadEvents();
}

// action 执行用户主动触发的项目操作。
async function action(name) {
  if (name === 'home') { homeVisible = true; closePanel('sidebar'); renderHome(); renderProject(); document.title = '办公室总览 · GoalHub'; return; }
  // 顶部直接定位需要用户处理的内容，避免长页面遗漏待办。
  if (name === 'attention') { openPanel('attention-dialog'); const panel = $(project.status === 'blocked' ? '#blocker-panel' : project.status === 'waiting_input' ? '#question-panel' : '#plan-preview'); panel.scrollIntoView({ block: 'center' }); panel.querySelector('textarea, button')?.focus({ preventScroll: true }); return; }
  if (name === 'employee-details') { office.select(office.selected); return; }
  if (name === 'manage-team') { $('#project-tools').open = false; await employees.open(selected); return; }
  if (name === 'new') { panels.open(); return; }
  if (name === 'edit-plan') { panels.edit(); return; }
  if (name === 'global-usage') { $('#global-dialog').showModal(); return; }
  if (name === 'close-register') { $('#register-dialog').close(); return; }
  if (name === 'close-global') { $('#global-dialog').close(); return; }
  if (name === 'close-edit-plan') { $('#edit-plan-dialog').close(); return; }
  if (name === 'reset-session') { await api(`/projects/${selected}/sessions-reset`, {}); await refresh(); toast('下次调用将使用新会话，历史记录已保留'); return; }
  if (name === 'god-setup') { await god.open(); return; }
  if (name === 'host-setup') { await setup.openHost(); return; }
  if (name === 'close-host') { setup.closeHost(); return; }
  if (name === 'close-run') { $('#run-dialog').close(); return; }
  if (name === 'toggle-goal') { const clamped = $('#goal-text').classList.toggle('clamped'); $('[data-action="toggle-goal"]').textContent = clamped ? '展开详情' : '收起详情'; return; }
  if (name === 'older') { await loadEvents(true); return; }
  if (!selected || busy || project?.historical) return;
  busy = true;
  try {
    const id = selected, retrying = name === 'start' && project.status === 'blocked';
    $('#project-actions').querySelectorAll('button').forEach((button) => { button.disabled = true; });
    await api(`/projects/${id}/${name}`, {});
    toast({ pause: '已暂停，进度已保留', start: retrying ? '已按原配置重新尝试，结果以验收记录为准' : '已继续执行', evaluate: '已安排进度评估' }[name] || '操作完成');
  } finally { busy = false; await refresh(); }
}

// handleClick 统一处理动态任务区按钮，避免重复绑定事件。
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.closest('#sidebar') && !button.dataset.closePanel) closePanel('sidebar');
    if (button.dataset.closePanel) closePanel(button.dataset.closePanel);
    if (button.dataset.panel) openPanel(button.dataset.panel);
    if (button.dataset.action) await action(button.dataset.action);
    if (button.dataset.project) await selectProject(button.dataset.project);
    if (button.dataset.tab) {
      tab = button.dataset.tab;
      for (const name of ['tasks', 'activity']) { $(`#${name}-view`).hidden = tab !== name; $(`#tab-${name}`).setAttribute('aria-selected', String(tab === name)); }
      if (tab === 'activity') { historyMode = false; await loadEvents(); }
    }
    if (button.dataset.run) {
      const run = await api(`/runs/${button.dataset.run}`);
      // 历史轮次展示当时的执行配置，避免员工改名或换模型后混淆记录。
      const executor = run.executor ? JSON.parse(run.executor) : null;
      $('#run-title').textContent = roles[run.role] || run.role;
      $('#run-meta').textContent = `${labels[run.status] || run.status} · ${date(run.created_at)}${executor ? ` · 员工 ${executor.name} · ${hostLabels[executor.hostType] || executor.hostType} · 模型 ${executor.model || '默认'} · 思考 ${executor.reasoningEffort || '默认'} · 语言 ${executor.effectiveLanguage || '历史未记录'}` : ''}${run.session_id ? ` · 会话 ${run.session_id}` : ''}`;
      $('#run-prompt-link').dataset.runId = run.id; $('#run-output').textContent = run.output || '运行中，流事件可在步骤记录中查询。';
      $('#run-dialog').showModal();
    }
  } catch (error) { toast(error.message); }
});

// submitAnswer 保存全部待答问题，调度器将在保存成功后恢复原项目。
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'answer-form') return;
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true;
  try {
    const answers = [...new FormData(event.target)].map(([id, answer]) => ({ id, answer }));
    await api(`/projects/${selected}/answer`, { answers }); await refresh(); toast('回答已记录，继续执行');
  } catch (error) { toast(error.message); button.disabled = false; }
});

// submitBlocker 把修复要求交给原目标，保留已有源码与失败证据再重试。
$('#blocker-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || project?.historical || project?.status !== 'blocked') return;
  const content = $('#blocker-instruction').value.trim();
  if (!content) { $('#blocker-instruction').focus(); return; }
  const id = selected;
  busy = true; renderBlocker();
  try { await api(`/projects/${id}/steer`, { content }); toast('修复要求已记录，正在重新尝试'); }
  catch (error) { toast(error.message); }
  finally { busy = false; await refresh(); }
});

// searchEvents 应用关键字和类型筛选，并恢复最新记录查询。
$('#log-search').addEventListener('submit', async (event) => {
  event.preventDefault(); const values = new FormData(event.currentTarget); search = values.get('search'); kind = values.get('kind'); historyMode = false;
  try { await loadEvents(); } catch (error) { toast(error.message); }
});

await refresh();
setInterval(refresh, 2000);

} catch (error) {
  // 模块下载或初始化失败时明确反馈，不把未加载状态当成空项目。
  console.error('GoalHub 启动失败', error);
  document.querySelector('#empty').hidden = true;
  document.querySelector('#startup-state').hidden = false;
  document.querySelector('#startup-message').textContent = '页面未能启动。请重启本地 GoalHub 服务后重新加载；加载失败不代表项目数据被删除。';
  document.querySelector('#startup-retry').hidden = false;
}

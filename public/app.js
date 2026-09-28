// 本文件驱动目标工作台，定期读取 SQLite 状态并提供创建、问答、暂停和日志查询交互。
// $ 获取工作台内的一个 DOM 元素。
const $ = (selector) => document.querySelector(selector);
const labels = { paused: '已暂停', planning: '规划中', running: '执行中', verifying: '验收中', waiting_input: '等待输入', blocked: '遇到阻断', completed: '已完成', pending: '待执行', done: '已完成', passed: '已通过', failed: '未通过', interrupted: '已中断' };
const roles = { planner: '目标规划', developer: '开发执行', evaluator: '定时评估', 'final-review': '最终评估', test: '测试验收' };
const hostLabels = { codex: 'Codex', claudecode: 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode' };
let selected = localStorage.getItem('goalhub.project') || '', project = null, projects = [], tab = 'tasks', busy = false, refreshInFlight = false;
let events = [], search = '', kind = '', questionsKey = '', toastTimer, eventProject = '', historyMode = false;
const markupCache = new WeakMap();

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

// navigation 展示真实项目及任务完成进度。
function navigation() {
  $('#project-count').textContent = projects.length;
  html('#project-list', projects.length ? projects.map((item) => `<button class="project-link ${item.id === selected ? 'selected' : ''}" data-project="${item.id}" ${item.id === selected ? 'aria-current="page"' : ''}><strong>${escape(item.name)}</strong><small><i class="status-dot ${item.status}"></i>${labels[item.status]}${item.task_count ? `　${item.done_count}/${item.task_count}` : ''}</small></button>`).join('') : '<p class="sidebar-empty">创建一个目标，开始执行。</p>');
}

// renderQuestions 仅在问题变化时重绘表单，轮询不会丢失正在输入的回答。
function renderQuestions() {
  const pending = project.questions.filter((item) => item.answer === null), key = `${project.id}:${pending.map((item) => item.id).join(',')}`;
  if (questionsKey === key) return;
  questionsKey = key;
  $('#question-panel').hidden = !pending.length;
  $('#question-panel').innerHTML = pending.length ? `<h2>需要你补充信息</h2><p>回答后会自动继续，已有进度和原目标会保留。</p><form id="answer-form">${pending.map((question, index) => `<label>${index + 1}. ${escape(question.prompt)}<textarea name="${question.id}" required maxlength="10000" rows="2" placeholder="填写回答"></textarea></label>`).join('')}<button class="primary" type="submit">提交回答并继续</button></form>` : '';
}

// renderProject 更新任务与证据区域，保留用户打开的测试详情。
function renderProject() {
  $('#empty').hidden = !!project; $('#project').hidden = !project;
  if (!project) return;
  $('#project-title').textContent = project.name; document.title = `${project.name} · GoalHub`;
  html('#project-status', badge(project.status)); $('#project-created').textContent = `创建于 ${date(project.created_at, true)}`;
  html('#project-actions', project.active ? '<button class="secondary" data-action="pause">暂停执行</button>' : project.status === 'completed' ? '<span class="badge completed">✓ 已通过验收</span>' : project.status === 'waiting_input' ? '' : '<button class="primary" data-action="start">继续执行</button>');
  $('#project-actions').querySelectorAll('button').forEach((button) => { button.disabled = busy; });
  $('#goal-text').textContent = project.goal;
  const stage = project.status === 'completed' ? 4 : project.status === 'verifying' ? 2 : project.resume_phase === 'execute' ? 1 : 0;
  $('#pipeline').innerHTML = ['目标规划', '持续开发', '测试验收', '完成交付'].map((name, index) => `<div class="pipeline-step ${index < stage ? 'finished' : index === stage ? 'active' : ''}">${name}</div>`).join('');
  $('#summary').textContent = project.summary || (project.status === 'planning' ? '规划 Agent 正在分析目标、拆解任务与制定测试项目。' : '目标已保存，等待开始执行。');
  $('#summary').classList.toggle('warning', ['blocked', 'waiting_input'].includes(project.status));
  renderQuestions();
  $('#task-count').textContent = project.tasks.length ? `${project.tasks.filter((task) => task.status === 'done').length}/${project.tasks.length}` : '';
  const openedTasks = new Set([...document.querySelectorAll('#task-list details[open]')].map((item) => item.dataset.task));
  $('#task-list').innerHTML = project.tasks.length ? project.tasks.map((task, index) => `<article class="task-item"><span class="task-marker ${task.status}">${task.status === 'done' ? '✓' : task.status === 'running' ? '›' : index + 1}</span><div class="task-content"><div class="task-heading"><h3>${escape(task.title)}</h3>${badge(task.status)}</div><p>${escape(task.description)}</p><div class="task-meta"><span>${task.check_ids.length} 项验收</span>${task.attempts ? `<span>已执行 ${task.attempts} 轮</span>` : ''}</div>${task.result ? `<details data-task="${task.id}" ${openedTasks.has(task.id) ? 'open' : ''}><summary>最近执行结果</summary><p>${escape(task.result)}</p></details>` : ''}</div></article>`).join('') : '<div class="empty-section">规划完成后，这里会展示按顺序执行的小任务。<br>每个任务都会关联可执行的测试项目。</div>';
  renderInspector(); renderRuns();
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
  const id = selected, query = new URLSearchParams({ search, kind, limit: '100' });
  if (older && events.length) query.set('before', events[0].id);
  const rows = await api(`/projects/${id}/events?${query}`);
  if (id !== selected) return;
  events = older ? [...rows, ...events] : rows; eventProject = id;
  if (older) { historyMode = true; if (!rows.length) toast('已经是最早的记录'); }
  renderEvents();
}

// refresh 轮询持久化状态，避免并发响应覆盖刚切换的项目。
async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const [list, status] = await Promise.all([api('/projects'), api('/status')]);
    projects = list;
    $('#connection').textContent = status.runtime.available ? '本机服务已连接' : '请配置运行模块';
    $('#connection-dot').className = `connection-dot ${status.runtime.available ? 'connected' : 'error'}`;
    $('#connection').title = status.runtime.message;
    if (!projects.some((item) => item.id === selected)) selected = projects[0]?.id || '';
    navigation();
    if (selected) {
      const id = selected, detail = await api(`/projects/${id}`);
      if (id !== selected) return;
      project = detail; renderProject();
      if (tab === 'activity' && (!historyMode || eventProject !== selected)) await loadEvents();
    } else { project = null; renderProject(); }
  } catch (error) { $('#connection').textContent = '连接中断，正在重试'; $('#connection-dot').className = 'connection-dot error'; }
  finally { refreshInFlight = false; }
}

// selectProject 清理上一个项目的筛选和表单状态。
async function selectProject(id) {
  selected = id; localStorage.setItem('goalhub.project', id); questionsKey = ''; historyMode = false; events = []; search = ''; kind = '';
  $('#log-search').reset();
  project = await api(`/projects/${id}`); navigation(); renderProject();
  if (tab === 'activity') await loadEvents();
}

// action 执行用户主动触发的项目操作。
async function action(name) {
  if (name === 'new') { $('#create-error').textContent = ''; $('#create-dialog').showModal(); return; }
  if (name === 'close-create') { $('#create-dialog').close(); return; }
  if (name === 'close-run') { $('#run-dialog').close(); return; }
  if (name === 'toggle-goal') { const clamped = $('#goal-text').classList.toggle('clamped'); $('[data-action="toggle-goal"]').textContent = clamped ? '展开详情' : '收起详情'; return; }
  if (name === 'older') { await loadEvents(true); return; }
  if (!selected || busy) return;
  busy = true;
  try {
    const id = selected;
    $('#project-actions').querySelectorAll('button').forEach((button) => { button.disabled = true; });
    await api(`/projects/${id}/${name}`, {});
    toast({ pause: '已暂停，进度已保留', start: '已继续执行', evaluate: '已安排进度评估' }[name] || '操作完成');
  } finally { busy = false; await refresh(); }
}

// handleClick 统一处理动态任务区按钮，避免重复绑定事件。
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  try {
    if (button.dataset.action) await action(button.dataset.action);
    if (button.dataset.project) await selectProject(button.dataset.project);
    if (button.dataset.tab) {
      tab = button.dataset.tab;
      for (const name of ['tasks', 'activity']) { $(`#${name}-view`).hidden = tab !== name; $(`#tab-${name}`).setAttribute('aria-selected', String(tab === name)); }
      if (tab === 'activity') { historyMode = false; await loadEvents(); }
    }
    if (button.dataset.run) {
      const run = await api(`/runs/${button.dataset.run}`);
      $('#run-title').textContent = roles[run.role] || run.role;
      $('#run-meta').textContent = `${labels[run.status] || run.status} · ${date(run.created_at)}${run.session_id ? ` · 会话 ${run.session_id}` : ''}`;
      $('#run-input').textContent = run.input; $('#run-output').textContent = run.output || '运行中，流事件可在步骤记录中查询。';
      $('#run-dialog').showModal();
    }
  } catch (error) { toast(error.message); }
});

// createProject 提交目标与运行设置，成功后进入对应工作台。
$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
  $('#create-error').textContent = '';
  try {
    const values = Object.fromEntries(new FormData(form));
    const created = await api('/projects', { name: values.name, goal: values.goal, settings: { hostType: values.hostType, model: values.model, evaluationMinutes: Number(values.evaluationMinutes), agentTimeoutMinutes: Number(values.agentTimeoutMinutes), testTimeoutSeconds: Number(values.testTimeoutSeconds) } });
    $('#create-dialog').close(); form.reset(); await selectProject(created.id); await refresh();
    toast('目标已创建，开始规划');
  } catch (error) { $('#create-error').textContent = error.message; }
  finally { button.disabled = false; }
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

// searchEvents 应用关键字和类型筛选，并恢复最新记录查询。
$('#log-search').addEventListener('submit', async (event) => {
  event.preventDefault(); const values = new FormData(event.currentTarget); search = values.get('search'); kind = values.get('kind'); historyMode = false;
  try { await loadEvents(); } catch (error) { toast(error.message); }
});

await refresh();
setInterval(refresh, 2000);

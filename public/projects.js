// 本文件管理项目登记、迭代历史、计划编辑和真实会话统计，复用工作台的请求与选择逻辑。
const $ = selector => document.querySelector(selector);
// escape 将项目与模型文本作为普通内容显示，避免 HTML 注入。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
// number 对未知指标保持未知，不把未采集的调用伪装成零消耗。
function number(value) { return value === null || value === undefined ? '未知' : value.toLocaleString('zh-CN'); }
const roles = { planner: '负责人规划', coordinator: '任务分配', developer: '员工执行', evaluator: '进度评估', 'final-review': '最终验收' };

export class ProjectsPanel {
  // constructor 绑定项目表单，提交时固定项目编号，防止切换项目导致误操作。
  constructor({ api, selectProject, selectGoal, toast, refresh }) {
    Object.assign(this, { api, selectProject, selectGoal, toast, refresh });
    $('#register-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type=submit]'); button.disabled = true;
      try { const result = await api('/projects/register', Object.fromEntries(new FormData(form))); $('#register-dialog').close(); form.reset(); await selectProject(result.id); await refresh(); toast('项目已添加，可以提出第一个需求'); }
      catch (error) { $('#register-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('#iteration-select').addEventListener('change', event => selectGoal(event.target.value).catch(error => toast(error.message)));
    $('#edit-plan-form').addEventListener('submit', async event => {
      event.preventDefault(); const values = new FormData(event.currentTarget), button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
      try {
        const plan = this.editPlan;
        plan.summary = values.get('summary');
        plan.tasks.forEach((task, i) => { task.title = values.get(`title-${i}`); task.description = values.get(`description-${i}`); task.doneWhen = values.get(`done-${i}`); task.assignee = values.get(`assignee-${i}`); });
        plan.checks.forEach((check, i) => { check.command = values.get(`command-${i}`); check.expectation = values.get(`expectation-${i}`); });
        await api(`/projects/${this.editProject}/plan`, plan); $('#edit-plan-dialog').close(); await refresh();
      } catch (error) { $('#edit-plan-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
  }

  // open 提供独立项目登记入口，无需先配置或调用模型。
  open() { $('#register-error').textContent = ''; $('#register-dialog').showModal(); }

  // render 保留目标选择焦点；容量与累计消耗采用不同的展示区。
  render(project) {
    this.project = project;
    const select = $('#iteration-select'), selected = project.viewed_goal_id || '';
    const options = project.goals.map((goal, index) => `<option value="${goal.id}">${index + 1}. ${escape(goal.title)}${goal.status === 'completed' ? '（已完成）' : '（当前）'}</option>`).join('') || '<option value="">尚未提出需求</option>';
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = selected;
    $('#iteration-note').textContent = project.historical ? '正在查看历史迭代，执行控制已禁用。' : project.active_goal_id ? '目标共享项目仓库；下一次迭代继续协调者会话。' : '先提出需求，协调者将阅读项目并制定计划。';
    $('#new-goal').disabled = !!project.active || !!project.historical || !!project.active_goal_id && project.status !== 'completed';
    $('#new-goal').title = $('#new-goal').disabled ? '当前目标完成后可开始下一次迭代' : '';
    $('#reset-session').disabled = !!project.active || !!project.historical;
    $('#project-repository').textContent = `${project.paths?.repo || project.repo_path || '受管项目目录'} · 主分支 ${project.main_branch}`;
    const sessions = project.sessions || [];
    const coordinator = sessions.find(item => item.isLead);
    $('#usage-summary').textContent = `项目上下文与用量 · 协调者剩余 ${coordinator?.remainingPercent == null ? '未知' : coordinator.remainingPercent.toFixed(1) + '%'} · 项目累计 ${number(project.usage?.total)} tokens`; 
    $('#session-metrics').innerHTML = sessions.map(session => `<article class="session-row"><div><strong>${escape(session.name || roles[session.role])}</strong><small>${escape(session.position || '')}</small><small>${escape(session.model || '等待首次调用')}</small></div><div>${session.remainingPercent === null ? '<strong>容量未知</strong><small>宿主尚未上报上下文</small>' : `<strong>剩余 ${session.remainingPercent.toFixed(1)}%</strong><meter min="0" max="100" value="${session.remainingPercent}" aria-label="${escape(session.name || roles[session.role])}剩余上下文"></meter><small>窗口 ${number(session.window)} · 占用 ${number(session.used)} · 剩余 ${number(Math.max(0, session.window - session.used))} tokens</small>`}</div><div><small>${session.sessionId ? `会话 ${escape(session.sessionId.slice(0, 12))}…` : '尚未创建会话'}</small><small>${session.updatedAt ? `最近上报 ${new Date(session.updatedAt).toLocaleTimeString('zh-CN')}` : '恢复时沿用原会话'}</small>${session.compaction ? `<small>最近压缩 ${new Date(session.compaction.created_at).toLocaleString('zh-CN')}：${number(session.compaction.before_tokens)} → ${number(session.compaction.after_tokens)}</small>` : ''}</div></article>`).join('');
    $('#project-usage').innerHTML = this.usageRows([['本次目标', project.goalUsage], ['项目累计', project.usage]]);
    $('#project-usage-details').innerHTML = this.breakdown(project.usage);
  }

  // usageRows 展示输入与输出总计，缓存读取是输入的子集，不重复相加。
  usageRows(items) {
    return `<table class="usage-table"><thead><tr><th>范围</th><th>输入</th><th>输出</th><th>缓存读取</th><th>合计 tokens</th><th>上报覆盖 / 耗时</th></tr></thead><tbody>${items.map(([label, u]) => `<tr><th>${label}</th><td>${number(u?.input)}</td><td>${number(u?.output)}</td><td>${number(u?.cached)}</td><td>${number(u?.total)}</td><td>${u?.known_runs || 0} / ${u?.runs || 0} 轮<small>${number(u?.elapsed_seconds)} 秒</small></td></tr>`).join('')}</tbody></table>`;
  }

  // breakdown 按项目、目标、日期、角色与模型展示真实明细，历史未知值不补造。
  breakdown(usage) {
    return `<table class="usage-table"><thead><tr><th>日期 / 项目</th><th>目标</th><th>角色 / 模型</th><th>输入</th><th>输出</th></tr></thead><tbody>${usage?.breakdown?.map(row => `<tr><td>${escape(row.day)}<small>${escape(row.name)}</small></td><td>${escape(row.goal_title)}</td><td>${roles[row.role] || escape(row.role)}<small>${escape(row.model || '宿主默认')}</small></td><td>${number(row.input)}</td><td>${number(row.output)}</td></tr>`).join('') || '<tr><td colspan="5">尚无可统计的宿主上报。旧记录不反推用量。</td></tr>'}</tbody></table>`;
  }

  // global 更新全局累计与项目明细，统计窗口可独立于所选项目打开。
  global(usage) { $('#global-total').textContent = `整体用量：${number(usage.total)} tokens`; $('#global-usage').innerHTML = this.usageRows([['全部项目', usage]]) + this.breakdown(usage); }

  // edit 将结构化计划映射成业务表单，避免要求用户编辑协议 JSON。
  edit() {
    const p = this.project; this.editProject = p.id;
    this.editPlan = { summary: p.summary, tasks: p.tasks.map(task => ({ id: task.id, title: task.title, description: task.description, doneWhen: task.done_when, assignee: task.assignee, dependsOn: task.depends_on, checkIds: task.check_ids })), checks: p.checks.map(check => ({ id: check.id, title: check.title, command: check.command, expectation: check.expectation })) };
    $('#edit-plan-fields').innerHTML = `<label>总体计划<textarea name="summary" required rows="4">${escape(p.summary)}</textarea></label>${this.editPlan.tasks.map((task, i) => `<fieldset><legend>任务 ${i + 1}</legend><label>名称<input name="title-${i}" required value="${escape(task.title)}"></label><label>执行员工<select name="assignee-${i}" required>${p.settings.employees.filter(employee => employee.enabled).map(employee => `<option value="${escape(employee.id)}" ${employee.id === task.assignee ? 'selected' : ''}>${escape(employee.name)} · ${escape(employee.position || '未定义职位')}</option>`).join('')}</select></label><label>具体工作<textarea name="description-${i}" required>${escape(task.description)}</textarea></label><label>完成条件<textarea name="done-${i}" required>${escape(task.doneWhen)}</textarea></label></fieldset>`).join('')}${this.editPlan.checks.map((check, i) => `<fieldset><legend>${escape(check.title)}</legend><label>验收命令<input name="command-${i}" required value="${escape(check.command)}"></label><label>通过条件<textarea name="expectation-${i}" required>${escape(check.expectation)}</textarea></label></fieldset>`).join('')}`;
    $('#edit-plan-error').textContent = ''; $('#edit-plan-dialog').showModal();
  }
}

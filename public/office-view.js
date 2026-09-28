// 本文件连接像素办公室、真实角色日志与项目控制；所有写入都使用 GoalHub 的同源 API。
import { OfficeScene } from './office-scene.js';
import { paintPortrait } from './vendor/munder-difflin/portrait-art.js';

const states = { idle: '待命', working: '工作中', success: '本轮结束', paused: '已暂停', blocked: '需要处理', error: '执行失败' };
// escape 在角色卡片与消息记录中安全显示模型和用户文本。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
// time 使用本地时间展示实际记录时间。
function time(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

export class OfficeView {
  // constructor 初始化一次性的办公室组件与控制事件。
  constructor({ onAction, onSteer, onError, onManage }) {
    this.root = document.querySelector('#office-view'); this.selected = 'developer'; this.online = true; this.sending = false; this.drafts = new Map();
    try { this.scene = new OfficeScene(this.find('#office-canvas'), (role) => this.select(role)); }
    catch (error) { this.find('#office-canvas-error').hidden = false; this.find('#office-canvas-error').textContent = `画布暂不可用，可使用下方角色列表与控制面板：${error.message}`; }
    this.root.addEventListener('office:navigate', event => {
      if (['human', 'controls'].includes(event.detail)) { this.root.classList.remove('expanded'); const expand = this.find('[data-office-camera=expand]'); expand.textContent = '展开'; expand.setAttribute('aria-label', '展开办公室'); }
      if (event.detail === 'tasks') { document.querySelector('#mode-dashboard').click(); document.querySelector('#tab-tasks').click(); document.querySelector('#task-list').scrollIntoView({ block: 'center' }); }
      else if (event.detail === 'human') { const questions = document.querySelector('#question-panel'); (questions.hidden ? this.find('#office-steer-form') : questions).scrollIntoView({ block: 'center' }); }
      else if (event.detail === 'triggers') { document.querySelector('#mode-dashboard').click(); document.querySelector('#evaluation-copy').scrollIntoView({ block: 'center' }); }
      else { this.root.classList.remove('expanded'); this.find('#office-run-control').scrollIntoView({ block: 'center' }); }
    });
    this.find('#office-motion').setAttribute('aria-pressed', String(!this.scene?.motion));
    this.find('#manage-employees').addEventListener('click', () => onManage());
    this.root.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.officeRole) this.select(button.dataset.officeRole);
      // 设施入口连接真实任务、人工确认与记录，不创建额外的虚构员工。
      if (button.dataset.officePlace) {
        const place = button.dataset.officePlace;
        this.root.classList.remove('expanded');
        if (place === 'meeting') {
          const plan = document.querySelector('#plan-preview'), questions = document.querySelector('#question-panel');
          (!questions.hidden ? questions : !plan.hidden ? plan : this.find('#office-steer-form')).scrollIntoView({ block: 'center' });
        } else {
          document.querySelector('#mode-dashboard').click();
          document.querySelector(place === 'archive' ? '#tab-activity' : '#tab-tasks').click();
        }
      }
      if (button.dataset.officeCamera) {
        const camera = button.dataset.officeCamera;
        if (camera === 'in') this.scene?.zoomBy(.25);
        if (camera === 'out') this.scene?.zoomBy(-.25);
        if (camera === 'expand') { const expanded = this.root.classList.toggle('expanded'); button.textContent = expanded ? '收起' : '展开'; button.setAttribute('aria-label', expanded ? '收起办公室' : '展开办公室'); }
        if (camera === 'fit') this.scene?.fit();
        if (camera === 'motion') { this.scene?.setMotion(!this.scene.motion); button.setAttribute('aria-pressed', String(!this.scene?.motion)); }
      }
      if (button.dataset.officeControl && this.online && !this.controlBusy) {
        this.controlBusy = true; this.renderControls();
        try { await onAction(button.dataset.officeControl); }
        catch (error) { onError(error.message); }
        finally { this.controlBusy = false; this.renderControls(); }
      }
    });
    this.find('#office-steer-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (this.sending || !this.online || !this.project) return;
      const id = this.project.id, content = this.find('#office-instruction').value.trim();
      if (!content) return;
      this.sending = true; this.renderControls();
      try {
        await onSteer(id, content); this.drafts.delete(id);
        if (this.project.id === id) this.find('#office-instruction').value = '';
      } catch (error) { onError(error.message); }
      finally { this.sending = false; this.renderControls(); }
    });
  }

  // find 获取当前办公室中的一个元素。
  find(selector) { return this.root.querySelector(selector); }

  // setVisible 切换工作台时同步暂停或恢复场景动画。
  setVisible(value) { this.scene?.setVisible(value); }

  // disconnected 冻结动态并禁用写入，避免把旧快照显示成实时状态。
  disconnected() {
    this.online = false; if (this.scene) { this.scene.online = false; this.scene.messages = []; }
    this.find('#office-connection').textContent = '连接中断 · 显示上次状态';
    this.find('#office-connection').classList.add('offline'); this.renderControls();
  }

  // update 渲染服务器真实快照，并在项目切换时隔离草稿与选中角色。
  update(project, busy = false) {
    if (!project.office) return;
    this.scene?.setProject(project);
    const reconnect = !this.online;
    if (this.project?.id !== project.id) {
      if (this.project) this.drafts.set(this.project.id, this.find('#office-instruction').value);
      this.find('#office-instruction').value = this.drafts.get(project.id) || '';
      this.selected = project.office.actors.find((actor) => actor.state === 'working')?.id || 'developer';
      this.outputKey = null; this.rosterKey = null;
    }
    if (!project.office.actors.some(actor => actor.id === this.selected)) this.selected = project.office.actors.find(actor => actor.isLead)?.id || project.office.actors[0]?.id;
    this.project = project; this.snapshot = project.office; this.busy = busy; this.online = true;
    if (!this.snapshot.actors.some(actor => actor.id === this.selected)) { this.selected = this.snapshot.actors[0]?.id || 'test'; this.outputKey = null; }
    this.scene?.update(project.office, reconnect); this.scene?.select(this.selected);
    this.find('#office-connection').textContent = `已同步 ${time(project.office.synchronizedAt)}`;
    this.find('#office-connection').classList.remove('offline');
    const progress = project.office.progress;
    this.find('#office-progress').textContent = `任务 ${progress.done}/${progress.total} · 测试 ${progress.passed}/${progress.checks} 通过`;
    this.renderRoster(); this.renderActor(); this.renderControls(); this.renderHistory();
  }

  // select 选择角色，画布与键盘角色列表使用同一选择状态。
  select(role) {
    if (!this.snapshot?.actors.some((actor) => actor.id === role)) return;
    // 点击角色时展开输出，保持场景查看记录的入口可达。
    this.find('.office-secondary').open = true;
    this.selected = role; this.outputKey = null;
    this.scene?.select(role); this.renderRoster(); this.renderActor();
  }

  // renderRoster 在状态变化时更新可键盘操作的角色按钮。
  renderRoster() {
    const signature = JSON.stringify(this.snapshot.actors.map((actor) => [actor.id, actor.name, actor.state, actor.character, actor.position, actor.isLead, this.selected === actor.id]));
    if (signature === this.rosterKey) return;
    this.rosterKey = signature;
    const focused = document.activeElement?.dataset.officeRole;
    const employees = this.snapshot.actors.filter(actor => actor.kind !== 'facility');
    this.find('#office-roster').innerHTML = employees.map((actor) => `<button class="office-roster-item ${this.selected === actor.id ? 'selected' : ''}" data-office-role="${actor.id}" aria-pressed="${this.selected === actor.id}" aria-label="${escape(actor.name)}，${states[actor.state]}"><canvas width="36" height="56" data-portrait="${actor.id}" aria-hidden="true"></canvas><span><strong>${escape(actor.name)}${actor.isLead ? ' · 负责人' : ''}</strong><small>${escape(actor.position || '未定义职位')}</small><small class="office-state ${actor.state}">${states[actor.state]}</small></span></button>`).join('');
    for (const actor of employees) paintPortrait(this.find(`[data-portrait="${actor.id}"]`).getContext('2d'), actor.character, 2);
    const station = this.snapshot.actors.find(actor => actor.id === 'test');
    this.find('#office-test-station').textContent = `测试工作站 · ${states[station?.state] || '待命'}`;
    this.find('#office-test-station').setAttribute('aria-pressed', String(this.selected === 'test'));
    if (focused) this.find(`[data-office-role="${focused}"]`)?.focus({ preventScroll: true });
  }

  // renderActor 显示选中角色的实际轮次、会话和输出，保留用户阅读位置。
  renderActor() {
    const actor = this.snapshot.actors.find((item) => item.id === this.selected);
    if (!actor) return;
    const portrait = this.find('#office-portrait'); portrait.hidden = actor.kind === 'facility';
    if (!portrait.hidden) paintPortrait(portrait.getContext('2d'), actor.character, 2);
    const hosts = { codex: 'Codex', claudecode: 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode' };
    this.find('#office-agent-host').textContent = actor.kind === 'facility' ? '设施 · 本机测试进程' : `职位：${actor.title || actor.name} · 宿主：${hosts[actor.hostType] || actor.hostType} · 模型：${actor.model || '默认'} · 思考：${actor.reasoningEffort || '默认'} · 语言：${({ 'zh-CN': '中文', en: 'English', ja: '日本語', ko: '한국어' })[actor.effectiveLanguage] || '中文'}${actor.nativeLanguage ? '（员工母语）' : '（继承项目）'}${actor.enabled === false ? ' · 未参与执行' : ''}`;
    this.find('#office-agent-name').textContent = actor.name;
    const state = this.find('#office-agent-status'); state.textContent = states[actor.state]; state.className = `office-state ${actor.state}`;
    this.find('#office-agent-description').textContent = actor.description;
    this.find('#office-agent-activity').textContent = actor.activity;
    this.find('#office-agent-session').textContent = actor.run ? `轮次 ${actor.run.id.slice(0, 8)}${actor.run.session_id ? ` · 会话 ${actor.run.session_id.slice(0, 12)}` : ''}` : '此角色尚未开始执行';
    const button = this.find('#office-full-run'); button.disabled = !actor.run;
    if (actor.run) button.dataset.run = actor.run.id; else delete button.dataset.run;
    this.find('#office-output-title').textContent = `${actor.name} · ${actor.state === 'working' ? '实时输出' : '最近一轮输出'}`;
    const key = `${actor.run?.id}:${actor.events.map((event) => event.id).join(',')}`;
    if (this.outputKey !== key) {
      const output = this.find('#office-output'), atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 35;
      const changedRole = this.outputKey === null;
      output.textContent = actor.events.length ? actor.events.map((event) => `${time(event.created_at)}  ${event.kind}\n${event.content}`).join('\n\n') : '该角色尚无输出。开始执行后，实际 Agent 与测试进程的输出会显示在这里。';
      if (atBottom || changedRole) output.scrollTop = output.scrollHeight;
      this.outputKey = key;
    }
  }

  // renderControls 按项目状态和网络状态启用可执行操作。
  renderControls() {
    if (!this.project) return;
    const project = this.project, pending = this.busy || this.controlBusy || this.sending || !this.online;
    const run = this.find('#office-run-control'), review = this.find('#office-review-control');
    run.dataset.officeControl = project.active ? 'pause' : 'start';
    run.textContent = project.status === 'awaiting_approval' ? '等待计划确认' : project.status === 'completed' ? '项目已完成' : project.active ? '暂停项目' : '继续执行';
    run.disabled = pending || project.status === 'completed' || (!project.active && ['waiting_input', 'awaiting_approval'].includes(project.status));
    review.disabled = pending || !project.active || project.status !== 'running' || this.snapshot.actors.some((actor) => actor.isLead && actor.state === 'working');
    this.find('#office-steer-form').hidden = !project.active_goal_id || project.status === 'completed';
    const locked = ['completed', 'waiting_input', 'awaiting_approval'].includes(project.status);
    this.find('#office-instruction').disabled = pending || locked;
    this.find('#office-send').disabled = pending || locked;
    this.find('#office-send').textContent = this.sending ? '正在保存并重新调度…' : '发送指令并继续';
    this.find('#office-control-hint').textContent = ['waiting_input', 'awaiting_approval'].includes(project.status) ? '请先在办公室下方完成问题回答或计划确认。' : project.status === 'completed' ? '目标已通过验收。可以选择角色查看交付过程，或新建目标。' : '控制作用于当前项目。减少动态只影响画面，不会暂停 Agent。';
  }

  // renderHistory 展示真实交接与已持久化的补充指令。
  renderHistory() {
    const messages = this.snapshot.messages.slice(-5).reverse();
    this.find('#office-handoffs').innerHTML = messages.length ? messages.map((message) => `<li><span>${escape(message.label)}</span><time>${time(message.created_at)}</time></li>`).join('') : '<li class="office-help">尚无交接记录</li>';
    this.find('#office-instruction-count').textContent = this.snapshot.instructions.length;
    this.find('#office-instruction-history').innerHTML = this.snapshot.instructions.map((item) => `<p><time>${time(item.created_at)}</time>${escape(item.content)}</p>`).join('') || '<p>尚未发送补充指令。</p>';
  }
}

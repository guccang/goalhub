// 本文件驱动宿主验证、目标输入和确认方式选择，测试通过前禁止进入规划。
import { attachModelPicker } from './model-picker.js';
export class SetupFlow {
  // constructor 绑定向导控件，轮询只更新测试结果，不覆盖正在编辑的设置。
  constructor({ api, selectProject, selectGoal, refresh, toast, buildTeam }) {
    Object.assign(this, { api, selectProject, selectGoal, refresh, toast, buildTeam });
    this.form = document.querySelector('#host-form');
    this.modelPicker = attachModelPicker(this.form.elements.model, api, () => this.form.elements.hostType.value); this.dirty = true; this.pending = false;
    this.form.addEventListener('input', () => { this.dirty = true; this.paint(); });
    this.find('#host-cards').addEventListener('click', event => {
      const card = event.target.closest('[data-host]');
      if (!card || card.disabled || card.dataset.host === this.form.elements.hostType.value) return;
      this.form.elements.hostType.value = card.dataset.host;
      this.form.elements.model.value = this.state?.hosts?.find(host => host.hostType === card.dataset.host)?.model || '';
      this.form.elements.reasoningEffort.value = this.state?.hosts?.find(host => host.hostType === card.dataset.host)?.reasoningEffort || '';
      this.dirty = true; this.find('#host-error').textContent = '';
      this.credentials().catch(error => this.error(error));
    });
    this.form.elements.authMode.addEventListener('change', () => this.paint());
    this.find('#login-host').addEventListener('click', () => this.login().catch(error => this.error(error)));
    this.find('#cancel-login').addEventListener('click', () => this.api('/host/login/cancel', {}).then(() => this.poll()).catch(error => this.error(error)));
    this.form.addEventListener('submit', event => { event.preventDefault(); this.save().catch(error => this.error(error)); });
    this.find('#test-host').addEventListener('click', () => this.test().catch(error => this.error(error)));
    this.find('#next-goal').addEventListener('click', () => this.closeHost());
    this.find('#back-host').addEventListener('click', () => this.openHost(true).catch(error => this.error(error)));
    this.find('#host-dialog').addEventListener('cancel', event => { event.preventDefault(); this.closeHost(); });
    this.find('#create-form').addEventListener('submit', event => { event.preventDefault(); this.create(event.currentTarget); });
    this.find('#create-form').addEventListener('change', () => { const form = this.find('#create-form'); form.querySelector('[type=submit]').textContent = form.elements.generateTeam.checked ? '保存需求并搭建团队' : form.elements.configureTeam.checked ? '保存需求并配置员工' : '生成拆解预览'; });
    setInterval(() => { if ((this.projectId || this.find('#host-dialog').open) && !this.polling && !this.pending) this.poll().catch(error => this.error(error)); }, 1500);
  }
  // find 读取向导内固定元素。
  find(selector) { return document.querySelector(selector); }
  // error 将错误显示在当前对话框中。
  error(error) { this.find('#host-error').textContent = error.message; }
  // syncProject 按项目保存草稿；轮询只更新可提交状态，不覆盖输入。
  syncProject(project) {
    const form = this.find('#create-form');
    this.drafts ||= new Map();
    if (this.projectId !== project.id) {
      if (this.projectId) this.drafts.set(this.projectId, Object.fromEntries([...form.elements].filter(field => field.name && (field.type !== 'checkbox' || field.checked)).map(field => [field.name, field.value])));
      form.reset();
      form.elements.language.value = project.settings.language || 'zh-CN';
      const draft = this.drafts.get(project.id);
      if (draft) for (const [name, value] of Object.entries(draft)) {
        const field = form.elements[name];
        if (field) { if (field.type === 'checkbox') field.checked = value === 'on'; else field.value = value; }
      }
      form.querySelector('[type=submit]').textContent = form.elements.generateTeam.checked ? '保存需求并搭建团队' : form.elements.configureTeam.checked ? '保存需求并配置员工' : '生成拆解预览';
      this.projectId = project.id;
      this.find('#create-error').textContent = '';
      this.api('/host').then(state => { this.state = state; this.dirty = !state.revision; this.paint(); }).catch(error => { this.find('#create-error').textContent = error.message; });
    }
    this.goalBlocked = false;
    this.find('#goal-fields').disabled = this.goalBlocked || !!this.creating;
    this.find('#goal-project-label').textContent = '可随时添加需求。按启用员工人数并发执行，超出容量的需求自动排队。';
    this.paint();
  }
  // openHost 打开独立全局配置，暂存目标表单的草稿与返回位置。
  async openHost(returnToGoal = false) {
    this.returnToGoal = returnToGoal;
    this.find('#host-dialog').showModal(); this.find('#host-error').textContent = '';
    this.state = await this.api('/host');
    this.form.elements.hostType.value = this.state.hostType; this.form.elements.model.value = this.state.model; this.form.elements.reasoningEffort.value = this.state.reasoningEffort || '';
    await this.credentials(); this.dirty = !this.state.revision; this.paint();
  }
  // closeHost 返回原目标草稿，侧栏入口则仅关闭全局设置。
  closeHost() {
    this.find('#host-dialog').close();
    // 未保存的编辑不影响服务器已验证配置；下次打开重新读取。
    this.dirty = !this.state?.revision; this.paint();
    if (this.returnToGoal) this.find('#create-form [name=goal]').focus();
    this.returnToGoal = false;
  }
  // credentials 读取所选宿主的脱敏设置，禁止回显密钥。
  async credentials() {
    const type = this.form.elements.hostType.value;
    this.loading = true; this.paint();
    let value;
    try { value = await this.api(`/host/credentials?type=${encodeURIComponent(type)}`); } finally { this.loading = false; this.paint(); }
    if (type !== this.form.elements.hostType.value) return;
    this.form.elements.baseUrl.value = value.baseUrl || ''; this.form.elements.provider.value = value.provider || 'deepseek';
    this.form.elements.apiKey.value = ''; this.form.elements.clearApiKey.checked = false;
    this.form.elements.authMode.value = value.authMode || 'local';
    this.find('#host-key-state').textContent = value.hasApiKey ? '已保存密钥，留空可保留。' : '未保存密钥，可填写或沿用本机宿主认证。';
    this.paint(); this.modelPicker.load();
  }
  // passed 当前配置存在成功探测且没有未保存编辑时，才放行下一步。
  passed() { return !this.dirty && !this.pending && this.state?.tests?.find(test => test.revision === this.state.revision)?.status === 'passed'; }
  // paint 展示持久化测试输入输出与状态。
  paint() {
    const latest = this.state?.tests?.find(test => test.revision === this.state.revision);
    const running = latest?.status === 'running' || this.state?.auth?.status === 'logging_in';
    const type = this.form.elements.hostType.value, mode = this.form.elements.authMode.value;
    // 卡片始终展示全部宿主，区分正在编辑、当前全局选择与真实连接结果。
    const labels = { passed: '可用 · 测试通过', failed: '不可用 · 测试失败', running: '正在测试', interrupted: '测试中断', stale: '配置已变更 · 待重测', untested: '未测试 · 状态未知' };
    this.find('#host-cards').querySelectorAll('[data-host]').forEach(card => {
      const host = this.state?.hosts?.find(item => item.hostType === card.dataset.host);
      const status = host?.status || 'untested';
      card.setAttribute('aria-pressed', String(card.dataset.host === type));
      card.disabled = this.pending || running || this.loading;
      card.dataset.status = status;
      card.querySelector('.host-health').textContent = labels[status] || '状态未知';
      card.querySelector('.host-active').textContent = host?.active ? '全局当前' : '';
      card.title = host?.testedAt ? `最近测试：${new Date(host.testedAt).toLocaleString()}` : '尚未进行真实连通性测试';
      if (card.dataset.host === type) this.find('#host-config-title').textContent = card.querySelector('strong').textContent + ' 配置';
    });
    this.find('#codex-effort').hidden = type !== 'codex';
    this.find('#codex-auth-mode').hidden = type !== 'codex';
    this.find('#codex-device').hidden = type !== 'codex' || mode !== 'device';
    this.find('#host-credentials').hidden = type === 'codex' && mode !== 'api';
    this.form.elements.baseUrl.closest('label').hidden = type === 'codex';
    this.form.elements.provider.closest('label').hidden = type !== 'opencode';
    this.find('#host-auth-note').textContent = type === 'codex' ? mode === 'api' ? '填写 API Key 后点击保存即可完成 API 登录，再测试实际模型连接。密钥不会回显。' : mode === 'device' ? '使用独立的 ChatGPT 设备码登录；请先在 ChatGPT 安全设置中启用设备码登录。' : '沿用服务器本机 Codex 已有登录。也可以选择无头登录或 API Key 登录。' : type === 'claudecode' ? '支持第三方 Anthropic 兼容服务：填写服务地址、API Key 和供应商要求的模型名称。留空沿用本机默认配置。' : '连接设置按宿主保存；OpenCode 模型需填写 provider/model。';
    this.find('#login-host').disabled = this.pending || running || this.loading;
    this.find('#cancel-login').hidden = this.state?.auth?.status !== 'logging_in';
    this.find('#login-status').textContent = this.state?.auth?.message || '';
    const auth = this.state?.auth;
    const showCode = auth?.status === 'logging_in' && auth.url === 'https://auth.openai.com/codex/device' && auth.code;
    this.find('#device-authorization').hidden = !showCode;
    this.find('#device-url').href = showCode ? auth.url : '#';
    this.find('#device-code').textContent = showCode ? auth.code : '';
    this.find('#host-auth-history').textContent = auth?.history?.map(item => `${item.created_at} · ${item.message}`).join('\n') || '暂无认证记录';
    this.form.querySelectorAll('input, select').forEach(element => { element.disabled = this.pending || running || this.loading || element.dataset.unavailable === 'true'; });
    this.find('#next-goal').textContent = this.returnToGoal ? '返回目标草稿' : '完成';
    this.find('#selected-host').textContent = this.passed() ? `共用已验证宿主：${this.state.hostType} · ${this.state.model || '默认模型'}` : '全局宿主尚未通过测试，请先点击「管理全局宿主」。目标内容可先填写并保留。';
    this.find('#goal-fields').disabled = this.goalBlocked || !!this.creating;
    this.find('#create-form [type=submit]').disabled = this.creating || this.goalBlocked || !this.passed();
    this.find('#save-host').disabled = this.pending || running || this.loading;
    this.find('#test-host').disabled = this.pending || running || this.loading;
    this.find('#host-test-status').textContent = this.state?.auth?.status === 'logging_in' ? '等待完成设备码授权，登录完成后可测试连通性。' : this.dirty ? '可直接点击「测试连通性」，自动保存当前配置并测试。' : running ? '正在真实调用模型，可关闭页面，稍后查看记录…' : latest?.status === 'passed' ? '连通性测试通过，可以输入目标。' : latest ? '测试未通过，请查看输出并修正配置后重试。' : '配置已保存，请测试连通性。';
    // 测试记录不变时保留链接节点，避免轮询打断键盘焦点。
    const historyKey = JSON.stringify(this.state?.tests || []);
    if (this.historyKey !== historyKey) {
      this.historyKey = historyKey;
      const history = this.find('#host-test-output'); history.replaceChildren();
      for (const test of this.state?.tests || []) {
        const row = document.createElement('section'), output = document.createElement('pre'), link = document.createElement('a');
        output.textContent = `${test.created_at} · ${test.host_type} / ${test.model || '默认模型'} · ${test.status}\n输出：${test.output}`;
        link.href = '#prompt-preview'; link.className = 'prompt-link'; link.dataset.prompt = 'host-history'; link.dataset.testId = test.id; link.textContent = '查看实际提示词'; link.setAttribute('aria-haspopup', 'dialog');
        row.append(link, output); history.append(row);
      }
      if (!this.state?.tests?.length) history.textContent = '暂无测试记录';
    }
  }
  // save 保存设置并使旧配置的验证结果失效。
  async save() {
    const value = Object.fromEntries(new FormData(this.form)); value.clearApiKey = this.form.elements.clearApiKey.checked;
    if (value.hostType !== 'codex') value.reasoningEffort = '';
    this.pending = true; this.paint(); this.find('#host-error').textContent = '';
    try { this.state = await this.api('/host', value); this.form.elements.apiKey.value = ''; this.form.elements.clearApiKey.checked = false; this.find('#host-key-state').textContent = this.state.credentials.hasApiKey ? '已保存密钥，留空可保留。' : '未保存 API 密钥。'; this.dirty = false; this.modelPicker.load(); }
    finally { this.pending = false; this.paint(); }
  }
  // login 保存当前认证方式再发起设备码登录，刷新后继续显示同一个登录任务。
  async login() {
    if (!this.form.reportValidity()) return;
    if (this.dirty) await this.save();
    this.pending = true; this.paint(); this.find('#host-error').textContent = '';
    try { await this.api('/host/login', {}); this.state = await this.api('/host'); this.dirty = false; }
    finally { this.pending = false; this.paint(); }
  }
  // test 提交真实调用，状态和日志由后续轮询恢复。
  async test() {
    if (!this.form.reportValidity()) return;
    if (this.dirty) await this.save();
    this.pending = true; this.paint(); this.find('#host-error').textContent = '';
    try { await this.api('/host/test', {}); await this.poll(); }
    finally { this.pending = false; this.paint(); }
  }
  // poll 查询数据库中的探测状态，防止并发轮询。
  async poll() { this.polling = true; try { const next = await this.api('/host'); if (this.state && this.state.revision !== next.revision) this.dirty = true; this.state = next; this.paint(); } finally { this.polling = false; } }
  // create 携带成功测试编号创建目标，仅调度规划阶段。
  async create(form) {
    // 创建请求期间保持禁用，避免状态轮询导致重复提交。
    if (this.creating || this.goalBlocked) return;
    const projectId = this.projectId;
    this.creating = true;
    const button = form.querySelector('[type=submit]'); button.disabled = true; this.find('#create-error').textContent = '';
    try {
      if (!this.passed()) throw new Error('请先在全局宿主设置中通过连通性测试');
      const values = Object.fromEntries(new FormData(form));
      const hostTestId = this.state.tests.find(test => test.revision === this.state.revision).id;
      const configureTeam = values.configureTeam === 'on', generateTeam = values.generateTeam === 'on';
      const created = await this.api(`/projects/${projectId}/goals`, { title: values.name, goal: values.goal, hostTestId, autoStart: !configureTeam && !generateTeam, settings: { language: values.language, confirmationMode: values.confirmationMode, evaluationMinutes: Number(values.evaluationMinutes), agentTimeoutMinutes: Number(values.agentTimeoutMinutes), testTimeoutSeconds: Number(values.testTimeoutSeconds) } });
      this.find('#goal-dialog').close();
      this.drafts?.delete(projectId); if (this.projectId === projectId) form.reset(); button.textContent = '生成拆解预览'; await this.selectProject(created.id); if (this.selectGoal && created.viewed_goal_id) await this.selectGoal(created.viewed_goal_id); await this.refresh();
      if (generateTeam) { await this.buildTeam(created.id); }
      else if (configureTeam) { document.querySelector('#manage-employees').click(); this.toast('请配置员工，保存后点击继续执行开始规划'); }
      else this.toast(created.status === 'queued' ? '目标已加入等待队列' : '正在生成拆解预览');
    } catch (error) { this.find('#create-error').textContent = error.message; }
    finally { this.creating = false; this.paint(); }
  }
}

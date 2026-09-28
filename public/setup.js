// 本文件驱动宿主验证、目标输入和确认方式选择，测试通过前禁止进入规划。
export class SetupFlow {
  // constructor 绑定向导控件，轮询只更新测试结果，不覆盖正在编辑的设置。
  constructor({ api, selectProject, refresh, toast }) {
    Object.assign(this, { api, selectProject, refresh, toast });
    this.form = document.querySelector('#host-form'); this.dirty = true; this.pending = false;
    this.form.addEventListener('input', () => { this.dirty = true; this.paint(); });
    this.form.elements.hostType.addEventListener('change', () => this.credentials().catch(error => this.error(error)));
    this.form.addEventListener('submit', event => { event.preventDefault(); this.save().catch(error => this.error(error)); });
    this.find('#test-host').addEventListener('click', () => this.test().catch(error => this.error(error)));
    this.find('#next-goal').addEventListener('click', () => this.closeHost());
    this.find('#back-host').addEventListener('click', () => this.openHost(true).catch(error => this.error(error)));
    this.find('#host-dialog').addEventListener('cancel', event => { event.preventDefault(); this.closeHost(); });
    this.find('#create-form').addEventListener('submit', event => { event.preventDefault(); this.create(event.currentTarget); });
    setInterval(() => { if ((this.find('#create-dialog').open || this.find('#host-dialog').open) && !this.polling && !this.pending) this.poll().catch(error => this.error(error)); }, 1500);
  }
  // find 读取向导内固定元素。
  find(selector) { return document.querySelector(selector); }
  // error 将错误显示在当前对话框中。
  error(error) { this.find('#host-error').textContent = error.message; }
  // open 新目标直接填写目标，复用全局验证结果，不重复保存或要求重复测试。
  async open() {
    this.find('#create-dialog').showModal(); this.find('#create-error').textContent = '';
    try { this.state = await this.api('/host'); this.dirty = !this.state.revision; this.paint(); }
    catch (error) { this.find('#create-error').textContent = error.message; }
  }
  // openHost 打开独立全局配置，暂存目标表单的草稿与返回位置。
  async openHost(returnToGoal = false) {
    this.returnToGoal = returnToGoal;
    this.find('#create-dialog').close(); this.find('#host-dialog').showModal(); this.find('#host-error').textContent = '';
    this.state = await this.api('/host');
    this.form.elements.hostType.value = this.state.hostType; this.form.elements.model.value = this.state.model;
    await this.credentials(); this.dirty = !this.state.revision; this.paint();
  }
  // closeHost 返回原目标草稿，侧栏入口则仅关闭全局设置。
  closeHost() {
    this.find('#host-dialog').close();
    // 未保存的编辑不影响服务器已验证配置；下次打开重新读取。
    this.dirty = !this.state?.revision; this.paint();
    if (this.returnToGoal) this.find('#create-dialog').showModal();
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
    this.find('#host-credentials').hidden = type === 'codex';
    this.find('#host-key-state').textContent = value.hasApiKey ? '已保存密钥，留空可保留。' : '未保存密钥，可填写或沿用本机宿主认证。';
    this.find('#host-auth-note').textContent = type === 'codex' ? 'Codex 使用本机登录；未登录时在终端执行 codex login 后再测试。' : '连接设置交由公共 agent-runtime 保存，仅用于该宿主。留空可使用本机默认认证；OpenCode 模型需填写 provider/model。';
  }
  // passed 当前配置存在成功探测且没有未保存编辑时，才放行下一步。
  passed() { return !this.dirty && !this.pending && this.state?.tests?.find(test => test.revision === this.state.revision)?.status === 'passed'; }
  // paint 展示持久化测试输入输出与状态。
  paint() {
    const latest = this.state?.tests?.find(test => test.revision === this.state.revision);
    const running = latest?.status === 'running';
    this.form.querySelectorAll('input, select').forEach(element => { element.disabled = this.pending || running || this.loading; });
    this.find('#next-goal').textContent = this.returnToGoal ? '返回目标草稿' : '完成';
    this.find('#selected-host').textContent = this.passed() ? `共用已验证宿主：${this.state.hostType} · ${this.state.model || '默认模型'}` : '全局宿主尚未通过测试，请先点击「管理全局宿主」。目标内容可先填写并保留。';
    this.find('#create-form [type=submit]').disabled = this.creating || !this.passed();
    this.find('#save-host').disabled = this.pending || running || this.loading;
    this.find('#test-host').disabled = this.pending || running || this.loading;
    this.find('#host-test-status').textContent = this.dirty ? '可直接点击「测试连通性」，自动保存当前配置并测试。' : running ? '正在真实调用模型，可关闭页面，稍后查看记录…' : latest?.status === 'passed' ? '连通性测试通过，可以输入目标。' : latest ? '测试未通过，请查看输出并修正配置后重试。' : '配置已保存，请测试连通性。';
    this.find('#host-test-output').textContent = this.state?.tests?.map(test => `${test.created_at} · ${test.host_type} / ${test.model || '默认模型'} · ${test.status}\n输入：${test.input}\n输出：${test.output}`).join('\n\n') || '暂无测试记录';
  }
  // save 保存设置并使旧配置的验证结果失效。
  async save() {
    const value = Object.fromEntries(new FormData(this.form)); value.clearApiKey = this.form.elements.clearApiKey.checked;
    this.pending = true; this.paint(); this.find('#host-error').textContent = '';
    try { this.state = await this.api('/host', value); this.form.elements.apiKey.value = ''; this.dirty = false; }
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
    if (this.creating) return;
    this.creating = true;
    const button = form.querySelector('[type=submit]'); button.disabled = true; this.find('#create-error').textContent = '';
    try {
      if (!this.passed()) throw new Error('请先在全局宿主设置中通过连通性测试');
      const values = Object.fromEntries(new FormData(form));
      const hostTestId = this.state.tests.find(test => test.revision === this.state.revision).id;
      const created = await this.api('/projects', { name: values.name, goal: values.goal, hostTestId, settings: { confirmationMode: values.confirmationMode, evaluationMinutes: Number(values.evaluationMinutes), agentTimeoutMinutes: Number(values.agentTimeoutMinutes), testTimeoutSeconds: Number(values.testTimeoutSeconds) } });
      this.find('#create-dialog').close(); form.reset(); await this.selectProject(created.id); await this.refresh(); this.toast('正在生成拆解预览');
    } catch (error) { this.find('#create-error').textContent = error.message; }
    finally { this.creating = false; this.paint(); }
  }
}

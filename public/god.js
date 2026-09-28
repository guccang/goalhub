// 本文件管理 GoalHub 的独立 God 配置和跨项目组队记录。
import { attachModelPicker } from './model-picker.js';
export class GodPanel {
  // constructor 绑定全局管理者窗口，模型目录共用宿主认证与实时查询。
  constructor({ api, toast }) {
    this.api = api; this.toast = toast;
    this.dialog = document.querySelector('#god-dialog');
    this.form = this.dialog.querySelector('form');
    this.fields = this.form.elements;
    this.picker = attachModelPicker(this.fields.model, api, () => this.fields.hostType.value);
    this.dialog.querySelector('[data-close-god]').onclick = () => this.dialog.close();
    this.fields.hostType.onchange = () => { this.fields.model.value = ''; this.fields.reasoningEffort.value = ''; this.paint(); this.picker.load(); };
    this.form.onsubmit = event => { event.preventDefault(); this.save(); };
    this.dialog.addEventListener('close', () => { clearTimeout(this.timer); this.version++; });
  }
  // paint 只更新禁用状态，不覆盖正在编辑的表单字段。
  paint() {
    this.dialog.querySelector('fieldset').disabled = this.pending || this.state?.busy;
    this.fields.reasoningEffort.disabled = this.fields.hostType.value !== 'codex';
    this.dialog.querySelector('#god-state').textContent = this.state?.busy ? 'God 正在搭建团队，完成后可修改配置。' : 'God 独立于项目。保存配置后，下一次团队生成使用新配置。';
  }
  // open 读取持久化配置，并显示最近为各项目执行的管理记录。
  async open() {
    const version = this.version = (this.version || 0) + 1;
    try {
      const value = await this.api('/god');
      if (version !== this.version) return;
      this.state = value;
      for (const name of ['hostType', 'model', 'reasoningEffort', 'timeoutMinutes', 'instructions']) this.fields[name].value = value[name];
      this.dialog.querySelector('#god-error').textContent = '';
      this.paint(); this.renderHistory(); this.dialog.showModal(); this.picker.load(); this.poll(version);
    } catch (error) { this.toast(error.message); }
  }
  // renderHistory 通过文本节点渲染项目名称，点击记录使用工作台现有详情窗口。
  renderHistory() {
    const key = JSON.stringify(this.state.runs);
    if (this.historyKey === key) return;
    this.historyKey = key;
    const list = this.dialog.querySelector('#god-history'); list.replaceChildren();
    const labels = { running: '生成中', completed: '已生成', failed: '失败', interrupted: '已中断' };
    for (const run of this.state.runs) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.type = 'button'; button.className = 'text-button'; button.dataset.run = run.id;
      button.textContent = `${run.projectName} · ${labels[run.status] || run.status} · ${new Date(run.created_at).toLocaleString()}`;
      item.append(button); list.append(item);
    }
    if (!this.state.runs.length) list.textContent = '暂无管理记录。在项目团队页面可请 God 搭建团队。';
  }
  // poll 刷新活动状态与记录，避免完成后仍锁定表单；关闭后忽略迟到响应。
  async poll(version) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const value = await this.api('/god');
        if (version !== this.version || !this.dialog.open) return;
        this.state = value; this.paint(); this.renderHistory();
      } catch { /* 临时断连保留当前编辑，下次轮询继续。 */ }
      if (version === this.version && this.dialog.open) this.poll(version);
    }, 2000);
  }
  // save 只提交 God 的执行参数和工作说明，服务端在生成中拒绝修改。
  async save() {
    if (this.pending) return;
    const value = Object.fromEntries(new FormData(this.form));
    value.timeoutMinutes = Number(value.timeoutMinutes);
    if (value.hostType !== 'codex') value.reasoningEffort = '';
    this.pending = true; this.paint();
    try { this.state = await this.api('/god', value); this.dialog.close(); this.toast('God 管理者配置已保存'); }
    catch (error) { this.dialog.querySelector('#god-error').textContent = error.message; }
    finally { this.pending = false; this.paint(); }
  }
}

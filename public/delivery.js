// 本文件展示项目可使用的交付，管理端口预览、安装包下载和构建配置。
const kinds = { web: 'Web 预览', desktop: '桌面安装包', android: 'Android APK', ios: 'iOS IPA', source: '源码 / 文档' };
// escape 将命令、文件名和模型说明作为普通文本展示。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export class DeliveryPanel {
  // constructor 绑定一次交付操作，端口与配置编辑不受状态轮询覆盖。
  constructor({ api, refresh, toast }) {
    Object.assign(this, { api, refresh, toast });
    this.panel = document.querySelector('#delivery-panel'); this.dialog = document.querySelector('#delivery-dialog'); this.form = this.dialog.querySelector('form');
    this.panel.addEventListener('click', event => { const action = event.target.closest('[data-delivery]')?.dataset.delivery; if (action) this.action(action); });
    this.dialog.querySelector('[data-close-delivery]').onclick = () => this.dialog.close();
    this.form.onsubmit = event => { event.preventDefault(); this.save(); };
    this.form.elements.kind.onchange = () => this.paintFields();
    this.dialog.querySelector('#delivery-use-file').onclick = () => this.save(true);
  }
  // render 按目标记录展示交付状态，不使用当前目标的产物替代历史交付。
  render(project) {
    this.project = project;
    const state = project.delivery || { release: null }, release = state.release;
    const key = JSON.stringify([project.id, project.historical, project.active, project.status, state.building, release, this.pending]);
    if (key === this.key) return;
    this.key = key;
    const input = this.panel.querySelector('[data-delivery-port]'), sameRelease = this.releaseId === release?.id && this.projectId === project.id;
    const previousPort = sameRelease ? input?.value : null, editingPort = sameRelease && document.activeElement === input;
    const logOpen = sameRelease && this.panel.querySelector('.delivery-log')?.open;
    this.projectId = project.id; this.releaseId = release?.id;
    const disabled = this.pending ? 'disabled' : '', statuses = { building: '构建中', verified: '交付验证通过，等待源码合并', ready: '可使用', failed: '交付失败' };
    const previews = { stopped: '未启动', interrupted: '服务重启后已中断', starting: '正在启动', running: '运行中', failed: '启动失败或已退出' };
    this.panel.innerHTML = `<div class="delivery-heading"><h2>项目交付</h2><span>${release ? `${escape(kinds[release.kind] || '交付')} · ${escape(statuses[release.status])}` : '尚未生成交付'}</span></div>
      <p>${release ? escape(release.instructions) : '完成前会验证预览或安装包。已有项目可补充交付设置后构建。'}</p>
      <div class="delivery-actions">${!project.historical ? `<button class="secondary" data-delivery="config" ${project.active || state.building ? 'disabled' : disabled}>交付设置</button><button class="secondary" data-delivery="build" ${project.status !== 'completed' || project.active || state.building ? 'disabled' : disabled}>${release ? '重新构建交付' : '构建交付'}</button>` : ''}
      ${state.building && !project.active ? `<button class="secondary" data-delivery="cancel" ${disabled}>取消构建</button>` : ''}
      ${release?.status === 'ready' && release.kind === 'web' ? `<label>预览端口<input data-delivery-port type="number" min="1024" max="65535" value="${escape(previousPort || release.port || 4173)}" ${release.preview === 'running' || release.preview === 'starting' ? 'disabled' : ''}></label><button class="primary" data-delivery="start" ${release.preview === 'running' || release.preview === 'starting' ? 'disabled' : disabled}>启动预览</button><button class="secondary" data-delivery="stop" ${['running', 'starting'].includes(release.preview) ? disabled : 'disabled'}>停止预览</button><span>${escape(previews[release.preview])}</span>${release.url ? `<a class="primary" href="${escape(release.url)}" target="_blank" rel="noopener noreferrer">打开预览 ↗</a>` : ''}` : ''}</div>
      ${release?.status === 'ready' && release.files?.length ? `<ul class="delivery-files">${release.files.map(file => `<li><a href="${escape(file.url)}" download>${escape(file.name)}</a><small>${file.size.toLocaleString()} 字节 · SHA-256 ${escape(file.sha256)}</small></li>`).join('')}</ul>` : ''}
      ${release ? `<details class="delivery-log" ${logOpen ? 'open' : ''}><summary>构建与预览日志 · ${escape(release.commit?.slice(0, 10) || '未构建')}</summary><pre>${escape(release.log || '等待输出')}</pre></details>` : ''}`;
    if (editingPort) this.panel.querySelector('[data-delivery-port]')?.focus();
  }
  // action 将操作固定到点击时的项目及交付编号，服务就绪后显示可打开链接。
  async action(action) {
    if (this.pending) return;
    const project = this.project, release = project.delivery?.release;
    if (action === 'config') { this.open(project); return; }
    const port = Number(this.panel.querySelector('[data-delivery-port]')?.value);
    this.pending = true; this.render(project);
    try {
      if (['start', 'stop'].includes(action)) await this.api(`/deliveries/${release.id}/preview/${action}`, { port });
      else await this.api(`/projects/${project.id}/delivery/${action}`, {});
      await this.refresh();
    } catch (error) { this.toast(error.message); }
    finally { this.pending = false; this.render(this.project); }
  }
  // open 复制项目设置或最近使用的仓库配置，未保存编辑只存在于当前表单。
  open(project) {
    this.editProject = project.id;
    const config = project.settings.delivery || project.delivery?.config || { kind: 'web', port: 4173 };
    for (const name of ['kind', 'build', 'verify', 'preview', 'port', 'instructions']) this.form.elements[name].value = config[name] ?? '';
    this.form.elements.artifacts.value = (config.artifacts || []).join('\n');
    this.dialog.querySelector('#delivery-error').textContent = ''; this.paintFields(); this.dialog.showModal();
  }
  // paintFields 只展示当前交付类型所需字段。
  paintFields() {
    const kind = this.form.elements.kind.value;
    this.dialog.querySelectorAll('[data-delivery-kind]').forEach(element => { element.hidden = !element.dataset.deliveryKind.split(' ').includes(kind); });
  }
  // save 将人工设置作为项目覆盖项，或恢复使用由开发员工维护的仓库文件。
  async save(useFile = false) {
    if (this.saving) return;
    const value = useFile ? { useFile: true } : Object.fromEntries(new FormData(this.form));
    if (!useFile) { value.port = Number(value.port || 4173); value.artifacts = value.artifacts.split('\n').map(line => line.trim()).filter(Boolean); }
    this.saving = true; this.form.querySelector('fieldset').disabled = true;
    try { await this.api(`/projects/${this.editProject}/delivery/config`, value); this.dialog.close(); await this.refresh(); this.toast('交付设置已保存'); }
    catch (error) { this.dialog.querySelector('#delivery-error').textContent = error.message; }
    finally { this.saving = false; this.form.querySelector('fieldset').disabled = false; }
  }
}

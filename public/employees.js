// 本文件编辑当前项目的员工草稿，保存后才影响调度，取消不修改服务器数据。
const hosts = { codex: 'Codex', claudecode: 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode' };
// escape 防止员工名称和补充要求进入 HTML 时形成可执行标记。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// options 生成带选中状态的安全选项。
function options(values, selected) { return Object.entries(values).map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`).join(''); }
export class EmployeeManager {
  // constructor 绑定草稿编辑和单次保存，使用打开时的项目 ID 隔离切换项目。
  constructor({ api, refresh, toast }) {
    Object.assign(this, { api, refresh, toast });
    this.dialog = document.querySelector('#employees-dialog');
    this.list = this.dialog.querySelector('#employee-list');
    this.dialog.querySelector('[data-close-employees]').onclick = () => this.dialog.close();
    this.dialog.querySelector('#add-employee').onclick = () => {
      if (this.employees.length >= 15) return;
      this.employees.push({ id: crypto.randomUUID(), name: '新员工', role: 'developer', character: this.characters[this.employees.length % this.characters.length], enabled: true, hostType: 'codex', model: '', reasoningEffort: '', timeoutMinutes: 30, instructions: '', nativeLanguage: '' }); this.render();
    };
    this.list.addEventListener('input', event => {
      const row = event.target.closest('[data-employee]'); if (!row) return;
      const employee = this.employees.find(item => item.id === row.dataset.employee), input = event.target;
      if (!input.name) return;
      employee[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    });
    this.list.addEventListener('change', event => {
      if (event.target.name === 'hostType') {
        const employee = this.employees.find(item => item.id === event.target.closest('[data-employee]').dataset.employee);
        if (employee.hostType !== 'codex') employee.reasoningEffort = '';
        this.render();
      }
    });
    this.list.addEventListener('click', event => {
      const button = event.target.closest('[data-remove-employee]');
      if (button) { this.employees = this.employees.filter(item => item.id !== button.dataset.removeEmployee); this.render(); }
    });
    this.dialog.querySelector('form').onsubmit = event => { event.preventDefault(); this.save(); };
  }
  // open 从服务器获取该项目的最新团队，不借用上个项目的编辑草稿。
  async open(id) {
    this.projectId = id; this.dialog.querySelector('#employee-error').textContent = '';
    try { Object.assign(this, await this.api(`/projects/${id}/employees`)); this.dialog.querySelector('#project-language').innerHTML = options(this.languages, this.language); this.render(); this.dialog.showModal(); }
    catch (error) { this.toast(error.message); }
  }
  // render 展示可增删员工、职责、宿主、模型和运行参数。
  render() {
    const duties = Object.fromEntries(Object.entries(this.duties).map(([id, value]) => [id, value.name]));
    this.list.innerHTML = this.employees.map(employee => `<fieldset class="employee-editor" data-employee="${escape(employee.id)}"><legend>${escape(employee.name)} · ${escape(duties[employee.role])}</legend>
      <div class="employee-grid"><label>员工名称<input name="name" value="${escape(employee.name)}" required maxlength="60"></label><label>职责<select name="role">${options(duties, employee.role)}</select></label>
      <label>执行宿主<select name="hostType">${options(hosts, employee.hostType)}</select></label><label>模型<input name="model" value="${escape(employee.model)}" maxlength="150" placeholder="留空使用宿主默认模型"></label>
      <label>思考强度<select name="reasoningEffort" ${employee.hostType !== 'codex' ? 'disabled' : ''}>${options({ '': employee.hostType === 'codex' ? '模型默认' : '此宿主暂不支持', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' }, employee.reasoningEffort)}</select></label>
      <label>员工母语<select name="nativeLanguage">${options({ '': '继承项目语言', ...this.languages }, employee.nativeLanguage || '')}</select></label><label>单轮时限（分钟）<input type="number" name="timeoutMinutes" min="1" max="240" value="${employee.timeoutMinutes}" required></label>
      <label>人物形象<select name="character">${options(Object.fromEntries(this.characters.map(name => [name, name])), employee.character)}</select></label><label class="inline-choice"><input type="checkbox" name="enabled" ${employee.enabled ? 'checked' : ''}>参与执行</label></div>
      <label>补充工作要求<textarea name="instructions" maxlength="4000" rows="2">${escape(employee.instructions)}</textarea></label><button class="secondary" type="button" data-remove-employee="${escape(employee.id)}">删除此员工</button></fieldset>`).join('') || '<p>暂无员工，点击“增加员工”组建团队。</p>';
    this.dialog.querySelector('#add-employee').disabled = this.employees.length >= 15;
  }
  // save 提交完整团队；运行中后端拒绝修改，错误保留当前编辑内容。
  async save() {
    if (this.saving) return; this.saving = true;
    const button = this.dialog.querySelector('[type=submit]'); button.disabled = true;
    try { await this.api(`/projects/${this.projectId}/employees`, { employees: this.employees, language: this.dialog.querySelector('#project-language').value }); this.dialog.close(); await this.refresh(); this.toast('项目员工配置已保存'); }
    catch (error) { this.dialog.querySelector('#employee-error').textContent = error.message; }
    finally { this.saving = false; button.disabled = false; }
  }
}

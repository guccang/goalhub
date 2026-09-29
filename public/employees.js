// 本文件管理项目员工草稿，以人物选择、职位定义和负责人设置完成组队。
// 预览模块缺失时隐藏增强入口，员工管理和主页面继续工作。
const { promptLink } = await import('./prompt-preview.js').catch(() => ({ promptLink: () => '' }));
import { roleTemplates, applyRoleTemplate } from './role-templates.js';
import { attachModelPicker } from './model-picker.js';
import { paintPortrait } from './vendor/munder-difflin/portrait-art.js';
const hosts = { codex: 'Codex', claudecode: 'Claude Code', 'deepseek-harness': 'DeepSeek Harness', opencode: 'OpenCode' };
// escape 防止用户文本或宿主数据进入 HTML 时形成可执行标记。
function escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// options 生成带选中状态的下拉选项。
function options(values, selected) { return Object.entries(values).map(([value, label]) => `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`).join(''); }
export class EmployeeManager {
  // constructor 绑定一次事件，员工与上下文的编辑保存在当前项目草稿中。
  constructor({ api, refresh, toast }) {
    Object.assign(this, { api, refresh, toast });
    this.dialog = document.querySelector('#employees-dialog');
    this.list = this.dialog.querySelector('#employee-list');
    this.detail = this.dialog.querySelector('#employee-detail');
    this.dialog.querySelector('[data-close-employees]').onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => { clearTimeout(this.pollTimer); this.openVersion++; });
    this.dialog.querySelector('#generate-team').onclick = () => this.generateTeam();
    this.dialog.querySelector('#load-team-proposal').onclick = () => this.applyProposal();
    this.dialog.querySelector('#cancel-team-generation').onclick = async () => {
      try { await this.api(`/projects/${this.projectId}/team-generation/cancel`, {}); }
      catch (error) { this.toast(error.message); }
    };
    this.dialog.querySelector('#undo-team-proposal').onclick = () => {
      if (!this.beforeGeneration) return;
      this.employees = this.beforeGeneration.employees;
      this.dialog.querySelector('#project-context').value = this.beforeGeneration.context;
      this.dialog.querySelector('#project-language').value = this.beforeGeneration.language;
      this.beforeGeneration = null; this.appliedId = null;
      this.selected = this.employees[0]?.id; this.render(); this.renderGeneration();
    };
    this.dialog.querySelector('#add-employee').onclick = () => {
      if (this.employees.length >= 15) return;
      const character = this.characters.find(name => !this.employees.some(employee => employee.character === name)) || this.characters[0];
      const employee = { id: crypto.randomUUID(), name: this.characterNames[character], position: '', capabilities: ['development'], character, isLead: false, enabled: true, hostType: 'codex', model: '', reasoningEffort: '', timeoutMinutes: 30, instructionsVersion: 2, instructions: '', nativeLanguage: '' };
      this.employees.push(employee); this.selected = employee.id; this.render();
    };
    this.list.addEventListener('click', event => {
      const button = event.target.closest('[data-select-employee]');
      if (button) { this.selected = button.dataset.selectEmployee; this.render(); }
    });
    this.detail.addEventListener('input', event => {
      const employee = this.current(), input = event.target;
      if (!employee || !input.name || ['isLead', 'enabled', 'hostType', 'capability', 'roleTemplate'].includes(input.name)) return;
      employee[input.name] = input.type === 'number' ? Number(input.value) : input.value;
      if (input.name === 'position') this.renderList();
    });
    this.detail.addEventListener('change', event => {
      const employee = this.current(), input = event.target;
      if (!employee) return;
      if (input.name === 'roleTemplate') {
        const template = roleTemplates.find(item => item.id === input.value);
        this.detail.querySelector('[data-template-preview]').textContent = template?.instructions || '';
        this.detail.querySelector('[data-apply-template]').disabled = !template;
      } else if (input.name === 'capability') {
        employee.capabilities = [...this.detail.querySelectorAll('[name=capability]:checked')].map(field => field.value);
      } else if (input.name === 'isLead') {
        this.employees.forEach(item => { item.isLead = input.checked && item.id === employee.id; });
        if (input.checked) employee.enabled = true;
        this.render();
      } else if (input.name === 'enabled') {
        employee.enabled = input.checked;
        if (!employee.enabled) employee.isLead = false;
        this.render();
      } else if (input.name === 'hostType') {
        employee.hostType = input.value; employee.model = ''; employee.reasoningEffort = ''; this.render();
      }
    });
    this.detail.addEventListener('click', event => {
      if (event.target.closest('[data-apply-template]')) {
        const employee = this.current(); this.templateUndo = { id: employee.id, position: employee.position, capabilities: [...(employee.capabilities || [])], instructions: employee.instructions, instructionsVersion: employee.instructionsVersion };
        Object.assign(employee, applyRoleTemplate(employee, this.detail.querySelector('[name=roleTemplate]').value)); this.render(); this.toast('职业模板已填入草稿，可编辑后保存');
      }
      if (event.target.closest('[data-undo-template]') && this.templateUndo?.id === this.current()?.id) { Object.assign(this.current(), this.templateUndo); this.templateUndo = null; this.render(); }
      const character = event.target.closest('[data-character]');
      if (character) { const employee = this.current(); employee.character = character.dataset.character; employee.name = this.characterNames[employee.character]; this.render(); }
      if (event.target.closest('[data-remove-employee]')) { this.employees = this.employees.filter(item => item.id !== this.selected); this.selected = this.employees[0]?.id; this.render(); }
    });
    this.dialog.querySelector('#copy-team').onclick = () => this.copyTeam();
    this.dialog.querySelector('form').onsubmit = event => { event.preventDefault(); this.save(); };
  }
  // current 返回右侧当前编辑的员工。
  current() { return this.employees.find(employee => employee.id === this.selected); }
  // open 并行读取团队与项目目录，过期请求不会覆盖另一个项目。
  async open(id, { generate = false } = {}) {
    const version = this.openVersion = (this.openVersion || 0) + 1;
    clearTimeout(this.pollTimer); this.autoApplyId = null; this.appliedId = null; this.beforeGeneration = null; this.startingGeneration = false;
    this.templateUndo = null; this.projectId = id; this.dialog.querySelector('#employee-error').textContent = '';
    try {
      const [value, projects] = await Promise.all([this.api(`/projects/${id}/employees`), this.api('/projects')]);
      if (this.openVersion !== version) return;
      Object.assign(this, value); this.selected = this.employees[0]?.id;
      this.dialog.querySelector('#project-language').innerHTML = options(this.languages, this.language);
      this.dialog.querySelector('#project-context').value = this.context || '';
      this.dialog.querySelector('#copy-team-source').innerHTML = '<option value="">选择其他项目</option>' + projects.filter(project => project.id !== id).map(project => `<option value="${escape(project.id)}">${escape(project.name)}</option>`).join('');
      this.dialog.querySelector('#team-project-name').textContent = projects.find(project => project.id === id)?.name || '当前项目';
      this.dialog.querySelector('#team-generation-goal').value = this.goal || '';
      this.render(); this.dialog.showModal(); this.renderGeneration();
      if (this.generation?.status === 'running') this.pollGeneration(version);
      else if (generate) await this.generateTeam();
    } catch (error) { this.toast(error.message); }
  }
  // renderGeneration 展示持久化状态，生成期间锁定团队草稿以避免覆盖手工编辑。
  renderGeneration() {
    const running = this.startingGeneration || this.generation?.status === 'running';
    this.dialog.querySelector('#team-edit-fields').disabled = running;
    this.dialog.querySelector('#team-generation-goal').disabled = running;
    this.dialog.querySelector('#generate-team').disabled = running || this.saving;
    this.dialog.querySelector('#cancel-team-generation').hidden = !running;
    this.dialog.querySelector('#load-team-proposal').hidden = this.generation?.status !== 'ready' || this.generation.stale || this.appliedId === this.generation.id;
    this.dialog.querySelector('#undo-team-proposal').hidden = !this.beforeGeneration || running;
    this.dialog.querySelector('#team-generation-status').textContent = running ? 'God 正在分析目标并搭建团队，可关闭页面，稍后回来查看。' : this.generation?.stale ? '目标或团队已更新，可以根据当前配置重新生成。' : this.generation?.status === 'ready' ? `${this.appliedId === this.generation.id ? '方案已载入草稿，可调整并保存。' : '已有生成方案，可载入后调整。'}\n${this.generation.result.summary}` : this.generation?.error || '';
  }
  // generateTeam 提交目标和背景，结果只载入草稿，由用户保存后生效。
  async generateTeam() {
    if (this.saving || this.startingGeneration || this.generation?.status === 'running') return;
    const version = this.openVersion, id = this.projectId;
    this.startingGeneration = true; this.renderGeneration();
    try {
      const value = await this.api(`/projects/${id}/team-generation`, { goal: this.dialog.querySelector('#team-generation-goal').value, context: this.dialog.querySelector('#project-context').value, language: this.dialog.querySelector('#project-language').value });
      if (version !== this.openVersion) return;
      this.generation = value; this.autoApplyId = value.id; this.pollGeneration(version);
    } catch (error) { this.toast(error.message); }
    finally { this.startingGeneration = false; if (version === this.openVersion) this.renderGeneration(); }
  }
  // pollGeneration 轮询当前对话框所属任务，关闭或切换项目后忽略旧响应。
  async pollGeneration(version) {
    clearTimeout(this.pollTimer);
    try {
      const value = await this.api(`/projects/${this.projectId}/team-generation`);
      if (version !== this.openVersion || !this.dialog.open) return;
      this.generation = value;
      if (value?.status === 'ready' && value.id === this.autoApplyId && !value.stale) { this.autoApplyId = null; this.applyProposal(); }
      this.renderGeneration();
      if (value?.status !== 'running') return;
    } catch (error) { if (version !== this.openVersion || !this.dialog.open) return; this.toast(error.message); }
    this.pollTimer = setTimeout(() => this.pollGeneration(version), 1500);
  }
  // applyProposal 保留原草稿供撤回，生成的员工继续使用原有编辑与保存流程。
  applyProposal() {
    if (this.generation?.status !== 'ready' || this.generation.stale) return;
    this.beforeGeneration = { employees: structuredClone(this.employees), context: this.dialog.querySelector('#project-context').value, language: this.dialog.querySelector('#project-language').value };
    this.dialog.querySelector('#project-context').value = this.generation.result.context;
    this.dialog.querySelector('#project-language').value = this.generation.result.language;
    this.employees = structuredClone(this.generation.result.employees); this.appliedId = this.generation.id;
    this.selected = this.employees[0]?.id; this.render(); this.renderGeneration();
  }
  // copyTeam 复制为独立员工编号，只有保存后生效，不复制会话或项目上下文。
  async copyTeam() {
    const source = this.dialog.querySelector('#copy-team-source').value, target = this.projectId;
    if (!source) { this.toast('请先选择要复制团队的项目'); return; }
    const button = this.dialog.querySelector('#copy-team'); button.disabled = true;
    try {
      const value = await this.api(`/projects/${source}/employees`);
      if (target !== this.projectId || !this.dialog.open || this.startingGeneration || this.generation?.status === 'running') return;
      this.employees = value.employees.map(employee => { const { role, ...config } = employee; return { ...config, id: crypto.randomUUID() }; });
      this.selected = this.employees[0]?.id; this.render(); this.toast('已复制到当前草稿，保存后成为本项目独立团队');
    } catch (error) { this.toast(error.message); }
    finally { button.disabled = false; }
  }
  // renderList 用同一人物绘制资源展示姓名、职位和负责人标记。
  renderList() {
    this.list.innerHTML = this.employees.map(employee => `<button type="button" class="employee-card" data-select-employee="${escape(employee.id)}" aria-pressed="${employee.id === this.selected}"><canvas width="36" height="56" data-portrait="${escape(employee.character)}" aria-hidden="true"></canvas><span><strong>${escape(employee.name)}</strong><small>${escape(employee.position || '待定义职位')}</small><small>${employee.isLead ? '项目负责人' : employee.enabled ? '参与执行' : '未参与执行'}</small></span></button>`).join('') || '<p class="setup-note">添加员工，为这个项目组建团队。</p>';
    this.paint(this.list);
    this.dialog.querySelector('#add-employee').disabled = this.employees.length >= 15;
    const lead = this.employees.find(employee => employee.isLead && employee.enabled);
    this.dialog.querySelector('#team-leader-note').textContent = lead ? `负责人 ${lead.name} 将根据职位分配任务。` : '尚未指定负责人；可以保存草稿，开始执行前请指定一人。';
  }
  // paint 将人物像素绘制到画布，静态显示避免列表持续动画。
  paint(container) { container.querySelectorAll('canvas[data-portrait]').forEach(canvas => paintPortrait(canvas.getContext('2d'), canvas.dataset.portrait, 2)); }
  // render 仅渲染当前员工的配置，模型目录与宿主设置共用实时查询组件。
  render() {
    this.renderList();
    const employee = this.current();
    if (!employee) { this.detail.innerHTML = '<p class="employee-empty">每位员工都有自己的职位、宿主和工作记录。点击“添加员工”开始配置。</p>'; return; }
    this.detail.innerHTML = `<div class="employee-identity"><canvas width="36" height="56" data-portrait="${escape(employee.character)}" aria-hidden="true"></canvas><div><h3>${escape(employee.name)}</h3><p>人物与姓名保持一致，工作内容由下方职位定义。</p></div></div>
      <details class="character-picker"><summary>选择人物形象</summary><div class="character-grid">${this.characters.map(character => `<button type="button" data-character="${escape(character)}" aria-pressed="${employee.character === character}"><canvas width="36" height="56" data-portrait="${escape(character)}" aria-hidden="true"></canvas><span>${escape(this.characterNames[character])}</span></button>`).join('')}</div></details>
      <fieldset><legend>默认职业模板</legend><label>选用规范<select name="roleTemplate"><option value="">选择模板，先查看规范</option>${roleTemplates.map(template => `<option value="${template.id}">${escape(template.name)}</option>`).join('')}</select></label><p data-template-preview class="setup-note"></p><p class="setup-note">应用会替换当前草稿的职位、能力和长期职责，保存团队后生效。负责人身份和模型设置保持不变。</p><button type="button" class="secondary" data-apply-template disabled>应用模板</button>${this.templateUndo?.id === employee.id ? '<button type="button" class="secondary" data-undo-template>撤销应用模板</button>' : ''}</fieldset>
      <label>职位名称<input name="position" value="${escape(employee.position)}" maxlength="100" placeholder="例如：Unity 客户端开发"></label>
      <fieldset><legend>可承担的工作（主管兼任开发需显式勾选）</legend>${Object.entries({development:'开发',testing:'测试',design:'设计',review:'审查',documentation:'文档',coordination:'协调'}).map(([value,label]) => `<label class="inline-choice"><input type="checkbox" name="capability" value="${value}" ${(employee.capabilities || []).includes(value) ? 'checked' : ''}>${label}</label>`).join('')}</fieldset>
      <label>长期职责<textarea name="instructions" maxlength="4000" rows="4" placeholder="跨目标复用的职责和质量标准；具体功能与验收要求填写在项目目标中">${escape(employee.instructions)}</textarea></label>
      ${employee.legacyInstructions ? `<details><summary>历史职位说明（已停用，仅供参考）</summary><p>${escape(employee.legacyPosition)}</p><pre>${escape(employee.legacyInstructions)}</pre></details>` : ''}
      <div class="employee-choices"><label class="inline-choice"><input type="checkbox" name="isLead" ${employee.isLead ? 'checked' : ''}>设为项目负责人</label><label class="inline-choice"><input type="checkbox" name="enabled" ${employee.enabled ? 'checked' : ''}>参与执行</label></div>
      <p class="setup-note">负责人理解目标、分配任务、跟进结果和核对交付。员工配置仅作用于本项目。</p>
      <div class="employee-grid"><label>执行宿主<select name="hostType">${options(hosts, employee.hostType)}</select></label><label>模型<input name="model" value="${escape(employee.model)}" maxlength="150"></label>
      <label>思考强度<select name="reasoningEffort" ${employee.hostType !== 'codex' ? 'disabled' : ''}>${options({ '': employee.hostType === 'codex' ? '模型默认' : '此宿主暂不支持', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, employee.reasoningEffort)}</select></label>
      <label>单轮时限（分钟）<input type="number" name="timeoutMinutes" min="1" max="240" value="${employee.timeoutMinutes}" required></label>
      <label>员工母语<select name="nativeLanguage">${options({ '': '继承项目语言', ...this.languages }, employee.nativeLanguage || '')}</select></label></div>
      ${promptLink('employee')}<button class="secondary employee-remove" type="button" data-remove-employee>移除此员工</button>`;
    this.paint(this.detail);
    attachModelPicker(this.detail.querySelector('[name=model]'), this.api, () => employee.hostType).load();
  }
  // save 提交项目上下文与团队；服务端拒绝运行中修改，错误保留草稿。
  async save() {
    if (this.saving || this.startingGeneration || this.generation?.status === 'running') return; this.saving = true; this.renderGeneration();
    const button = this.dialog.querySelector('[type=submit]'); button.disabled = true;
    try { await this.api(`/projects/${this.projectId}/employees`, { employees: this.employees, context: this.dialog.querySelector('#project-context').value, language: this.dialog.querySelector('#project-language').value }); this.dialog.close(); await this.refresh(); this.toast('项目团队已保存'); }
    catch (error) { this.dialog.querySelector('#employee-error').textContent = error.message; }
    finally { this.saving = false; button.disabled = false; this.renderGeneration(); }
  }
}

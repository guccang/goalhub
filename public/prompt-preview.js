// 本文件提供统一的提示词链接与独立预览弹窗，页面中不直接铺开提示词。
// promptLink 返回供动态页面复用的预览入口，参数仅使用内部标识。
export function promptLink(source = 'project', extra = '') {
  return `<a href="#prompt-preview" class="prompt-link" data-prompt="${source}" ${extra} aria-haspopup="dialog">预览提示词</a>`;
}

// installPromptPreviews 按点击时的表单值获取快照，只读请求不会启动执行。
export function installPromptPreviews({ api, getProject, employees, setup }) {
  const dialog = document.querySelector('#prompt-dialog');
  const content = dialog.querySelector('#prompt-content'), note = dialog.querySelector('#prompt-note');
  let version = 0;
  dialog.querySelector('[data-close-prompt]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { version++; });
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[data-prompt]');
    if (!link) return;
    event.preventDefault();
    const requestVersion = ++version;
    content.replaceChildren(); note.textContent = '正在读取提示词…';
    if (!dialog.open) dialog.showModal();
    try {
      let result;
      const source = link.dataset.prompt;
      if (source === 'run') {
        const run = await api(`/runs/${link.dataset.runId}`);
        result = { note: '本轮实际发送的输入（按执行记录的脱敏规则展示）。', entries: [{ title: '执行记录提示词', input: run.input }] };
      } else if (source === 'host-history') {
        const record = setup.state?.tests?.find(item => item.id === link.dataset.testId);
        if (!record) throw new Error('记录已更新，请关闭后重新打开');
        result = { note: '本次连通性测试实际发送的输入。', entries: [{ title: '连通性测试', input: record.input }] };
      } else if (source === 'host') {
        result = await api('/host/prompt-preview', { reasoningEffort: setup.form.elements.hostType.value === 'codex' ? setup.form.elements.reasoningEffort.value : '' });
      } else {
        let id = getProject()?.id, payload = {};
        if (source === 'team' || source === 'employee') {
          id = employees.projectId;
          payload = { context: document.querySelector('#project-context').value, language: document.querySelector('#project-language').value };
          if (source === 'team') Object.assign(payload, { role: 'team-builder', goal: document.querySelector('#team-generation-goal').value });
          else Object.assign(payload, { employees: employees.employees, role: 'developer', employeeId: employees.selected });
        } else if (source === 'goal') {
          const fields = document.querySelector('#create-form').elements;
          id = setup.projectId;
          payload = { role: fields.generateTeam.checked ? 'team-builder' : 'planner', goal: fields.goal.value, language: fields.language.value };
        } else if (source === 'steer') payload.instruction = document.querySelector('#office-instruction').value;
        else if (source === 'answers') payload.answers = [...document.querySelectorAll('#answer-form textarea')].map(field => ({ id: field.name, answer: field.value }));
        else if (source !== 'project') payload.role = source;
        if (link.dataset.taskId) payload.taskId = link.dataset.taskId;
        if (!id) throw new Error('请先选择项目');
        result = await api(`/projects/${id}/prompt-preview`, payload);
      }
      if (requestVersion !== version || !dialog.open) return;
      note.textContent = result.note;
      for (const entry of result.entries) {
        const section = document.createElement('section'), heading = document.createElement('h3'), pre = document.createElement('pre');
        heading.textContent = entry.title;
        section.append(heading);
        if (entry.executor) {
          const meta = document.createElement('p'); meta.className = 'setup-note';
          meta.textContent = `${entry.executor.name} · ${entry.executor.hostType} · ${entry.executor.model || '默认模型'} · 思考强度 ${entry.executor.reasoningEffort || '默认'}`;
          section.append(meta);
        }
        pre.textContent = entry.error ? `暂不可预览：${entry.error}` : entry.input;
        section.append(pre); content.append(section);
      }
    } catch (error) { if (requestVersion === version && dialog.open) note.textContent = `无法预览：${error.message}`; }
  });
}

// 本文件在用户启动模型前展示提示词并二次确认，历史输入仍可独立查看。
// promptLink 兼容动态页面旧调用；调用前不再提供独立预览链接。
export function promptLink() { return ''; }

// previewRequest 将模型调用入口映射为无副作用的预览请求，普通保存和停止操作直接通过。
export function previewRequest(path, value) {
  if (value === undefined) return null;
  if (path === '/host/test') return { path: '/host/prompt-preview', value: {}, title: '确认测试宿主' };
  const match = path.match(/^\/projects\/([^/]+)\/(goals|start|approve|evaluate|answer|steer|team-generation|delivery\/build)$/);
  if (!match || match[2] === 'goals' && value.autoStart === false) return null;
  const [, id, action] = match;
  let payload = { action };
  if (action === 'goals') payload = { action, role: 'planner', goal: value.goal, language: value.settings?.language };
  if (action === 'team-generation') payload = { ...value, role: 'team-builder' };
  if (action === 'answer') payload.answers = value.answers;
  if (action === 'steer') payload.instruction = value.content;
  const names = { goals: '开始规划', start: '继续执行', approve: '确认计划并执行', evaluate: '立即评估', answer: '提交回答并继续', steer: '发送指令并继续', 'team-generation': '生成团队', 'delivery/build': '准备交付' };
  return { path: `/projects/${id}/prompt-preview`, value: payload, title: `确认${names[action]}` };
}

// installPromptPreviews 统一管理确认与历史窗口，关闭、取消和读取失败均不启动模型。
export function installPromptPreviews({ api, setup }) {
  const dialog = document.querySelector('#prompt-dialog'), content = dialog.querySelector('#prompt-content'), note = dialog.querySelector('#prompt-note');
  const confirm = dialog.querySelector('#prompt-confirm'), cancel = dialog.querySelector('#prompt-cancel'), title = dialog.querySelector('#prompt-title');
  let version = 0, resolvePending = null;
  // finish 先使未完成请求失效，再返回用户选择，保证重复点击不会重复执行。
  function finish(accepted = false) {
    version++; const resolve = resolvePending; resolvePending = null;
    confirm.disabled = true; if (dialog.open) dialog.close(); resolve?.(accepted);
  }
  dialog.querySelector('[data-close-prompt]').onclick = () => finish(false);
  cancel.onclick = () => finish(false);
  confirm.onclick = () => { if (!confirm.disabled) finish(true); };
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  dialog.addEventListener('close', () => { if (resolvePending) finish(false); });
  // show 固定本次请求，默认展开提示词；只有完整读取成功后才能确认。
  async function show(load, heading, requiresConfirmation) {
    if (dialog.open || resolvePending) throw new Error('请先完成当前提示词确认');
    const current = ++version;
    title.textContent = heading; content.replaceChildren(); note.textContent = '正在读取本次提示词…';
    confirm.hidden = !requiresConfirmation; confirm.disabled = true; cancel.textContent = requiresConfirmation ? '取消' : '关闭';
    const answer = new Promise(resolve => { resolvePending = resolve; });
    dialog.showModal();
    // 异步加载不阻塞取消，网络未返回时也立即结束确认流程。
    void (async () => { try {
      const result = await load();
      if (current !== version || !dialog.open) return;
      const entries = result.entries || [];
      note.textContent = `${requiresConfirmation ? '确认后才会调用模型并消耗 tokens；本次确认后，后续自动执行流程会继续。' : ''} ${result.note || ''}`;
      for (const entry of entries) {
        const section = document.createElement('details'), heading = document.createElement('summary'), pre = document.createElement('pre');
        section.className = 'prompt-entry'; section.open = true; heading.textContent = entry.title; section.append(heading);
        if (entry.executor) { const meta = document.createElement('p'); meta.className = 'setup-note'; meta.textContent = `${entry.executor.name} · ${entry.executor.hostType} · ${entry.executor.model || '默认模型'} · 思考强度 ${entry.executor.reasoningEffort || '默认'}`; section.append(meta); }
        pre.textContent = entry.error ? `暂不可预览：${entry.error}` : entry.input; section.append(pre); content.append(section);
      }
      confirm.disabled = !entries.length || entries.some(entry => entry.error || !entry.input);
      if (!confirm.disabled && requiresConfirmation) confirm.focus();
    } catch (error) { if (current === version && dialog.open) note.textContent = `无法读取提示词，尚未执行：${error.message}。请取消后重试。`; } })();
    return answer;
  }
  document.addEventListener('click', async event => {
    const link = event.target.closest('a[data-prompt]'); if (!link) return;
    event.preventDefault();
    try {
      if (link.dataset.prompt === 'run') await show(async () => { const run = await api(`/runs/${link.dataset.runId}`); return { entries: [{ title: '本轮实际发送的提示词', input: run.input }] }; }, '执行记录提示词', false);
      if (link.dataset.prompt === 'host-history') await show(async () => { const record = setup.state?.tests?.find(item => item.id === link.dataset.testId); if (!record) throw new Error('记录已更新'); return { entries: [{ title: '连通性测试实际输入', input: record.input }] }; }, '测试记录提示词', false);
    } catch { /* 已有确认框时保留原操作，不覆盖待确认请求。 */ }
  });
  // confirmRequest 由统一 API 层调用；预览请求自身不匹配执行路由，不会递归弹窗。
  return async function confirmRequest(path, value) {
    const preview = previewRequest(path, value); if (!preview) return;
    if (!await show(() => api(preview.path, preview.value), preview.title, true)) throw new Error('已取消，未调用模型');
  };
}

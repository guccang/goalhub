// 本文件提供宿主与员工共用的动态模型选择器，旧模型和第三方自定义值均保留。
let sequence = 0;
// attachModelPicker 以 DOM 构建选项，避免宿主返回的名称注入 HTML。
export function attachModelPicker(input, api, hostType) {
  const id = `model-directory-${++sequence}`;
  const list = document.createElement('datalist'); list.id = id; input.setAttribute('list', id);
  const select = document.createElement('select'); select.setAttribute('aria-label', '选择可用模型');
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'secondary'; refresh.textContent = '刷新模型';
  const note = document.createElement('small'); note.setAttribute('role', 'status');
  input.setAttribute('aria-label', '模型名称（可自定义）');
  input.placeholder = '可输入自定义模型，留空使用宿主默认';
  input.before(select); input.after(list, refresh, note);
  let generation = 0;
  // load 每次按当前宿主读取，丢弃宿主切换后过期的响应，不覆盖用户输入。
  async function load() {
    const request = ++generation, host = hostType();
    select.replaceChildren(new Option('正在读取模型…', '')); select.disabled = true; select.dataset.unavailable = 'true'; refresh.disabled = true;
    note.textContent = '正在读取已保存认证配置的模型目录…';
    try {
      const result = await api(`/host/models?type=${encodeURIComponent(host)}`);
      if (request !== generation || host !== hostType() || !input.isConnected) return;
      list.replaceChildren(); select.replaceChildren(new Option('宿主默认模型', ''));
      for (const model of result.models) {
        const label = `${model.displayName || model.model}${model.isDefault ? '（默认）' : ''}`;
        list.append(new Option(label, model.model)); select.append(new Option(label, model.model));
      }
      if (input.value && !result.models.some(model => model.model === input.value)) select.append(new Option(`${input.value}（当前值，未在目录中）`, input.value));
      select.value = input.value; select.disabled = !result.supported; select.dataset.unavailable = String(!result.supported); note.textContent = result.message;
    } catch {
      if (request !== generation || host !== hostType() || !input.isConnected) return;
      list.replaceChildren(); select.replaceChildren(new Option('模型读取失败', '')); select.disabled = true;
      note.textContent = '无法读取模型目录。请检查已保存的认证配置与登录状态后重试；已填写的模型保持不变。';
    } finally { if (request === generation) refresh.disabled = false; }
  }
  select.addEventListener('change', () => { input.value = select.value; input.dispatchEvent(new Event('input', { bubbles: true })); });
  input.addEventListener('input', () => { select.value = input.value; });
  refresh.addEventListener('click', load);
  return { load };
}

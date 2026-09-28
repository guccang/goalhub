// 本文件验证确认弹窗的取消、关闭、错误和重复提交，不实际调用模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPromptPreviews, previewRequest } from '../public/prompt-preview.js';

// Element 模拟确认框依赖的原生元素与关闭事件。
class Element extends EventTarget {
  constructor() { super(); this.children = []; this.open = false; this.disabled = false; }
  querySelector(selector) { return this.elements?.[selector]; }
  append(...items) { this.children.push(...items); }
  replaceChildren() { this.children = []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  focus() {}
}
// fixture 创建隔离 DOM，测试结束后恢复全局对象。
function fixture(t, api) {
  const original = globalThis.document, dialog = new Element();
  dialog.elements = Object.fromEntries(['#prompt-copy', '#prompt-copy-status', '#prompt-content', '#prompt-note', '#prompt-title', '#prompt-confirm', '#prompt-cancel', '[data-close-prompt]'].map(key => [key, new Element()]));
  globalThis.document = Object.assign(new EventTarget(), { querySelector: () => dialog, createElement: () => new Element() });
  t.after(() => { globalThis.document = original; });
  return { dialog, confirm: dialog.elements['#prompt-confirm'], cancel: dialog.elements['#prompt-cancel'], gate: installPromptPreviews({ api, setup: {} }) };
}
// tick 等待异步预览响应完成渲染。
const tick = () => new Promise(resolve => setImmediate(resolve));

test('所有模型启动入口需要确认，普通保存、暂停及预览请求不递归确认', () => {
  for (const action of ['goals','start','approve','evaluate','answer','steer','team-generation','delivery/build']) assert.ok(previewRequest(`/projects/id/${action}`, {}));
  assert.ok(previewRequest('/host/test', {}));
  for (const action of ['pause','display','employees','prompt-preview','delivery/config','team-generation/cancel']) assert.equal(previewRequest(`/projects/id/${action}`, {}), null);
  assert.equal(previewRequest('/projects/id/goals', { autoStart: false }), null);
  assert.equal(previewRequest('/projects/id/start', undefined), null);
});

test('确认前仅预览，取消与 Escape 均拒绝执行，确认只释放一次', async t => {
  let previews = 0, executed = 0;
  const f = fixture(t, async () => { previews++; return { entries: [{ title: '真实提示词', input: '本次输入' }] }; });
  // submit 模拟统一请求层，只有确认通过才发送模型调用。
  const submit = async () => { await f.gate('/host/test', {}); executed++; };
  const cancelled = assert.rejects(submit(), /已取消/); await tick();
  assert.equal(executed, 0); assert.equal(f.confirm.disabled, false); f.cancel.onclick(); await cancelled;
  const escaped = assert.rejects(submit(), /已取消/); await tick(); f.dialog.dispatchEvent(new Event('cancel', { cancelable: true })); await escaped;
  const accepted = submit(); await tick(); f.confirm.onclick(); f.confirm.onclick(); await accepted;
  assert.equal(executed, 1); assert.equal(previews, 3);
});

test('加载失败禁止确认，加载中关闭不会被迟到响应重新打开', async t => {
  let respond;
  const f = fixture(t, () => new Promise(resolve => { respond = resolve; }));
  const cancelled = assert.rejects(f.gate('/host/test', {}), /已取消/);
  f.cancel.onclick(); await cancelled; respond({ entries: [{ title: '迟到', input: '输入' }] }); await cancelled; await tick();
  assert.equal(f.dialog.open, false); assert.equal(f.confirm.disabled, true);
  const failed = assert.rejects(f.gate('/host/test', {}), /已取消/);
  respond({ entries: [{ title: '错误', error: '宿主未配置' }] }); await tick();
  assert.equal(f.confirm.disabled, true); f.cancel.onclick(); await failed;
});
// 复制仅写入展示的完整正文，成功或权限拒绝都不会确认模型调用。
test('提示词复制保留换行并反馈结果，不关闭确认框', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let copied = '', deny = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
    // writeText 模拟剪贴板成功与浏览器权限拒绝。
    async writeText(text) { if (deny) throw new Error('权限拒绝'); copied = text; }
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  const f = fixture(t, async () => ({ entries: [{ title: '提示词', input: '第一行\n第二行 <tag>' }] }));
  const pending = assert.rejects(f.gate('/host/test', {}), /已取消/);
  const copy = f.dialog.elements['#prompt-copy'], status = f.dialog.elements['#prompt-copy-status'];
  assert.equal(copy.disabled, true); await tick(); await copy.onclick();
  assert.equal(copied, '第一行\n第二行 <tag>'); assert.equal(status.textContent, '已复制'); assert.equal(f.dialog.open, true);
  deny = true; await copy.onclick(); assert.match(status.textContent, /复制失败/); assert.equal(copy.disabled, false);
  f.cancel.onclick(); await pending;
});

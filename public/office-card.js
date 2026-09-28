// 总览卡片仅接收父页面快照，员工操作交回主页面统一处理。
import { OfficeScene } from './office-scene.js';
const status = document.querySelector('#status'), roster = document.querySelector('#employees');
let scene, snapshot, rosterKey = '';
// select 将员工编号交给父页面，保持项目与员工对应关系。
function select(id) { parent.postMessage({ type: 'office-select', id }, location.origin); }
try { scene = new OfficeScene(document.querySelector('#scene'), select); }
catch { status.textContent = '场景不可用，请选择下方员工'; }
roster.addEventListener('click', event => { const button = event.target.closest('button'); if (button) select(button.dataset.id); });
document.querySelector('#scene').addEventListener('office:navigate', () => { const lead = snapshot?.actors.find(actor => actor.isLead); if (lead) select(lead.id); });
// 同源父窗口是唯一数据来源，失联时冻结场景并保留明确提示。
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'office-offline') { if (scene) scene.online = false; status.hidden = false; status.textContent = '连接中断 · 显示上次状态'; return; }
  if (event.data?.type !== 'office-snapshot' || !event.data.office) return;
  snapshot = event.data.office; scene?.update(snapshot); scene?.setVisible(!document.hidden); status.hidden = !!scene;
  const actors = snapshot.actors.filter(actor => actor.kind !== 'facility'), key = JSON.stringify(actors.map(actor => [actor.id, actor.name, actor.state]));
  if (key === rosterKey) return; rosterKey = key; roster.replaceChildren();
  for (const actor of actors) { const button = document.createElement('button'); button.dataset.id = actor.id; button.textContent = actor.name + (actor.state === 'working' ? ' · 工作中' : ''); roster.append(button); }
});
document.addEventListener('visibilitychange', () => scene?.setVisible(!document.hidden));
parent.postMessage({ type: 'office-ready' }, location.origin);

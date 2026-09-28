// 本文件把完整 Munder Difflin 办公室挂载到 GoalHub，并保持现有控制组件接口。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OfficeFloor } from './upstream/scene/office/OfficeFloor';
import { setState } from './store';
import { goalhubBridge } from './bridge';

export class OfficeScene {
  root; container; onSelect; motion = !matchMedia('(prefers-reduced-motion: reduce)').matches; visible = false; connected = true; messages = []; projectId = ''; lastEvent: number | null = null; abort = new AbortController();
  // constructor 挂载原版场景，并绑定拖动、滚轮和场景道具入口。
  constructor(container: HTMLElement, onSelect: (id: string) => void) {
    this.container = container; this.onSelect = onSelect; this.root = createRoot(container);
    goalhubBridge.motion = this.motion;
    setState({ agents: [], ideOpen: true, select: id => { this.select(id); onSelect(id); }, requestCommandCenterTab: name => container.dispatchEvent(new CustomEvent('office:navigate', { detail: name, bubbles: true })) });
    this.mount();
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const options = { signal: this.abort.signal };
    container.addEventListener('pointerdown', event => { drag = { x: event.clientX, y: event.clientY, moved: false }; }, options);
    container.addEventListener('pointermove', event => {
      if (!drag || !(event.buttons & 1)) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      if (drag.moved) { goalhubBridge.scene?.camera.panBy(dx, dy); this.renderStill(); }
      drag.x = event.clientX; drag.y = event.clientY;
    }, options);
    container.addEventListener('pointerup', () => { drag = null; }, options);
    container.addEventListener('wheel', event => { event.preventDefault(); this.zoomBy(event.deltaY < 0 ? .15 : -.15); }, { ...options, passive: false });
  }
  // mount 通过项目键重建场景，隔离座位、气泡、看板动画和历史消息。
  mount() { this.root.render(<OfficeFloor key={this.projectId} />); }
  // online 冻结失联画面，避免把旧快照显示成实时工作。
  get online() { return this.connected; }
  set online(value: boolean) { this.connected = value; this.visibility(); }
  // update 同步真实角色与交接，不为未运行的角色伪造工作状态。
  update(snapshot: any, reconnect = false) {
    if (snapshot.projectId !== this.projectId) { this.projectId = snapshot.projectId; this.lastEvent = null; setState({ agents: [] }); this.mount(); }
    const accents = ['coral', 'sky', 'lemon', 'mint'];
    // 只有员工生成像素人物；测试命令设施不会变成人物或触发员工工作动画。
    setState({ agents: snapshot.actors.filter((actor: any) => actor.kind !== 'facility').map((actor: any, index: number) => ({ id: actor.id, character: actor.character, isGod: actor.id === 'planner', accent: accents[index], status: actor.state === 'paused' ? 'waiting' : actor.state === 'error' ? 'blocked' : actor.state, action: `${actor.name} · ${actor.hostType || ''} · ${actor.activity}`, carrying: '', lastPrompt: '' })) });
    for (const event of snapshot.messages) {
      if (this.lastEvent !== null && event.id > this.lastEvent && !reconnect && this.visible && this.motion && this.connected) goalhubBridge.emit({ from: event.from, targets: [event.to], act: event.kind.includes('completed') ? 'done' : event.kind === 'input.required' ? 'query' : 'inform', needsHuman: event.to === 'human' });
    }
    this.lastEvent = Math.max(this.lastEvent || 0, ...snapshot.messages.map((event: any) => event.id)); this.connected = true; this.visibility(); this.renderStill();
  }
  // setProject 把任务与问答传给原版看板，不触发第二套业务调度。
  setProject(project: any) { goalhubBridge.project = project; }
  // select 同步角色选中状态及相机焦点。
  select(id: string) { setState({ selectedId: id }); this.renderStill(); }
  // setVisible 在切换视图时停止场景 ticker。
  setVisible(value: boolean) { this.visible = value; this.visibility(); }
  // visibility 同步上游隐藏场景逻辑，保留资源以便恢复。
  visibility() { setState({ ideOpen: !this.visible || !this.connected || !this.motion }); }
  // setMotion 减少动态只冻结视觉效果，不影响任务执行。
  setMotion(value: boolean) { this.motion = value; goalhubBridge.motion = value; this.visibility(); this.renderStill(); }
  // renderStill 静止模式下仍更新状态和相机画面。
  renderStill() { const scene = goalhubBridge.scene; if (!scene) return; if (!this.motion) scene.camera.settle(); scene.app.render(); }
  // fit 恢复原版全景。
  fit() { goalhubBridge.scene?.camera.fitToScreen(); this.renderStill(); }
  // zoomBy 在原版相机边界约束内缩放。
  zoomBy(amount: number) { goalhubBridge.scene?.camera.zoomBy(amount); this.renderStill(); }
  // destroy 释放 React、订阅和相机事件。
  destroy() { this.abort.abort(); this.root.unmount(); }
}

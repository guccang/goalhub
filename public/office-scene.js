// 本文件将 Munder Difflin 的程序化角色接入浏览器 Canvas 办公室；状态和信封均来自真实项目事件。
import { sceneFrameBufs, SCENE_W, SCENE_H } from './vendor/munder-difflin/portrait-art.js';

const W = 720, H = 460;
const seats = { planner: { x: 117, y: 186 }, developer: { x: 288, y: 214 }, evaluator: { x: 597, y: 186 }, test: { x: 434, y: 214 }, human: { x: 363, y: 423 } };
const rests = { planner: { x: 112, y: 276 }, developer: { x: 248, y: 287 }, evaluator: { x: 610, y: 276 }, test: { x: 490, y: 287 } };
const stateColors = { idle: '#9ba8ad', working: '#edc45d', success: '#65b899', paused: '#9aabc6', blocked: '#e37b64', error: '#e37b64' };
const states = { idle: '待命', working: '工作中', success: '本轮结束', paused: '已暂停', blocked: '需要处理', error: '执行失败' };

// box 绘制清晰的整像素家具色块。
function box(ctx, x, y, width, height, fill, stroke) {
  ctx.fillStyle = fill; ctx.fillRect(Math.round(x), Math.round(y), width, height);
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.strokeRect(Math.round(x) + 1, Math.round(y) + 1, width - 2, height - 2); }
}

// text 绘制办公室内的中文标牌与状态文字。
function text(ctx, value, x, y, size = 11, color = '#435a58', align = 'left') {
  ctx.fillStyle = color; ctx.font = `600 ${size}px "Microsoft YaHei", sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(value, x, y);
}

// plant 绘制无需外部素材的盆栽。
function plant(ctx, x, y) {
  box(ctx, x - 8, y + 6, 17, 14, '#a4785f', '#785b4d'); box(ctx, x - 5, y + 8, 11, 3, '#c59777');
  box(ctx, x - 2, y - 12, 4, 22, '#678368'); box(ctx, x - 14, y - 6, 13, 8, '#7b9e75'); box(ctx, x + 1, y - 15, 12, 10, '#638c6e'); box(ctx, x - 9, y - 21, 10, 12, '#95b080');
}

// windowArt 绘制百叶窗和窗框。
function windowArt(ctx, x, y, width) {
  box(ctx, x, y, width, 33, '#c3d8d7', '#8eaba7');
  for (let row = 5; row < 30; row += 5) box(ctx, x + 3, y + row, width - 6, 2, '#a8c3c1');
  box(ctx, x + Math.floor(width / 2), y + 2, 3, 29, '#f2eee0'); box(ctx, x - 2, y + 32, width + 4, 5, '#e2ddc9');
}

// desk 绘制桌子、显示器、键盘与办公用品。
function desk(ctx, x, y, width = 82, accent = '#7b9f9f') {
  box(ctx, x + 5, y + 37, width - 3, 8, '#b7ae98'); box(ctx, x + 6, y + 30, 6, 24, '#8c755b'); box(ctx, x + width - 11, y + 30, 6, 24, '#8c755b');
  box(ctx, x, y, width, 38, '#c19b73', '#846c55'); box(ctx, x + 3, y + 3, width - 6, 4, '#dcb68c'); box(ctx, x + 3, y + 34, width - 6, 3, '#a98764');
  box(ctx, x + 26, y + 18, 23, 4, '#536562'); box(ctx, x + 34, y + 3, 7, 18, '#566864');
  box(ctx, x + 18, y - 22, 40, 31, '#3d5354', '#2d4247'); box(ctx, x + 21, y - 19, 34, 23, '#9dc4bb');
  box(ctx, x + 24, y - 15, 18, 2, '#5d948c'); box(ctx, x + 24, y - 10, 24, 2, '#72a198'); box(ctx, x + 24, y - 5, 13, 2, '#5d948c');
  box(ctx, x + 23, y + 25, 29, 7, '#e1deca', '#aaa48f'); box(ctx, x + 59, y + 21, 6, 9, accent); box(ctx, x + 65, y + 23, 3, 4, accent);
  box(ctx, x + 5, y + 11, 10, 15, '#f4eddb'); box(ctx, x + 7, y + 14, 6, 1, '#b2b8ae'); box(ctx, x + 7, y + 18, 6, 1, '#b2b8ae');
}

// drawRoom 绘制带走道门洞的独立办公室。
function drawRoom(ctx, x, label) {
  box(ctx, x, 72, 177, 143, '#d8d4c0');
  for (let row = 84; row < 215; row += 15) box(ctx, x + 2, row, 173, 1, '#c8c7b5');
  box(ctx, x, 65, 177, 12, '#9fb6a7', '#7e998d'); box(ctx, x, 76, 6, 144, '#9eb3a2'); box(ctx, x + 171, 76, 6, 144, '#9eb3a2');
  box(ctx, x, 216, 64, 7, '#899f92'); box(ctx, x + 110, 216, 67, 7, '#899f92');
  text(ctx, label, x + 88, 57, 11, '#4b665c', 'center'); windowArt(ctx, x + 58, 78, 62);
}

// background 使用自主绘制的家具和地板生成办公室，未引入上游独立授权的贴图。
function background() {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  box(ctx, 0, 0, W, H, '#d9e3d8'); box(ctx, 14, 26, 692, 423, '#718d80'); box(ctx, 18, 21, 684, 420, '#d4cab3', '#718d80');
  for (let y = 38; y < 435; y += 18) {
    box(ctx, 22, y, 676, 1, '#c1b79f');
    for (let x = 22 + (y % 36 === 2 ? 0 : 25); x < 698; x += 62) box(ctx, x, y, 1, 18, '#c5bba4');
  }
  box(ctx, 20, 22, 680, 14, '#a3b8a6'); box(ctx, 20, 33, 680, 4, '#809789');
  drawRoom(ctx, 30, '规划室'); drawRoom(ctx, 513, '评估室');
  desk(ctx, 77, 139); desk(ctx, 557, 139, 82, '#bc8a72');
  desk(ctx, 248, 165, 82, '#729bb4'); desk(ctx, 394, 165, 82, '#bda064');
  text(ctx, '开发工位', 289, 242, 10, '#53665d', 'center'); text(ctx, '测试验收', 435, 242, 10, '#53665d', 'center');
  box(ctx, 249, 54, 223, 49, '#74928d', '#4d706c'); box(ctx, 254, 59, 213, 39, '#e8e9d6');
  text(ctx, '项目交付看板', 360, 70, 11, '#4c6b66', 'center');
  plant(ctx, 46, 240); plant(ctx, 672, 240); plant(ctx, 489, 116); plant(ctx, 228, 116);
  // 左下的休息区用于表现真实暂停与待命。
  box(ctx, 40, 326, 137, 68, '#839988', '#647b6a'); box(ctx, 44, 322, 129, 18, '#a7b89c', '#768c77');
  box(ctx, 44, 343, 129, 29, '#9dae94'); box(ctx, 43, 369, 131, 12, '#718873'); box(ctx, 101, 342, 3, 27, '#84977e');
  box(ctx, 36, 337, 13, 47, '#91a58c', '#6c836c'); box(ctx, 166, 337, 13, 47, '#91a58c', '#6c836c');
  text(ctx, '休息区', 107, 413, 10, '#6f7f6e', 'center');
  // 中间接待桌对应用户输入、补充要求和项目交付。
  box(ctx, 262, 354, 192, 12, '#907154'); box(ctx, 255, 337, 206, 22, '#c8a57b', '#907154'); box(ctx, 259, 340, 198, 4, '#e0c091');
  box(ctx, 304, 328, 26, 9, '#f7f0db'); box(ctx, 307, 324, 22, 5, '#e5ddc8'); box(ctx, 389, 325, 24, 12, '#667e78');
  text(ctx, '你的控制台', 362, 348, 10, '#634f3b', 'center');
  // 右下文件柜与咖啡角。
  box(ctx, 540, 315, 63, 91, '#8b9e98', '#687e78');
  for (let row = 0; row < 3; row++) { box(ctx, 545, 321 + row * 27, 53, 23, '#bec6b4', '#84988d'); box(ctx, 565, 328 + row * 27, 14, 4, '#748b80'); }
  box(ctx, 622, 329, 53, 73, '#b8ab8b', '#887f67'); box(ctx, 619, 325, 59, 9, '#dccaaa', '#9d8d70'); box(ctx, 637, 298, 22, 29, '#647875', '#4f6665');
  box(ctx, 641, 303, 14, 9, '#a6bdad'); box(ctx, 643, 317, 10, 8, '#e8e0c6'); text(ctx, '源码 / 记录', 591, 423, 10, '#6f7f6e', 'center');
  return canvas;
}

// spriteFrames 把上游生成的 RGBA 动画帧转换为 Canvas 位图。
function spriteFrames(character) {
  const source = sceneFrameBufs(character), result = {};
  for (const direction of ['front', 'back']) result[direction] = source[direction].map((buffer) => {
    const canvas = document.createElement('canvas'); canvas.width = SCENE_W; canvas.height = SCENE_H;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(SCENE_W, SCENE_H);
    pixels.data.set(buffer); ctx.putImageData(pixels, 0, 0); return canvas;
  });
  return result;
}

// targetFor 将工作、暂停、阻断映射到工位、走道和用户接待区。
function targetFor(actor, index) {
  if (actor.state === 'blocked') return { x: 292 + index * 40, y: 321 };
  if (['idle', 'paused'].includes(actor.state)) return rests[actor.id];
  return seats[actor.id];
}

// easeInOut 沿用上游 MessageEnvelope 的缓入缓出曲线，适配 Canvas 渲染。
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; }

export class OfficeScene {
  // constructor 初始化绘制、拖动和角色命中检测；视觉操作不修改项目执行状态。
  constructor(canvas, onSelect) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.onSelect = onSelect;
    this.floor = background(); this.actors = new Map(); this.frames = new Map(); this.messages = []; this.lastEvent = null;
    this.selected = 'developer'; this.zoom = 1; this.pan = { x: 0, y: 0 }; this.visible = false; this.online = true;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches; this.motion = !this.reduced; this.progress = { done: 0, total: 0, passed: 0, checks: 0 };
    this.abort = new AbortController(); const options = { signal: this.abort.signal };
    canvas.addEventListener('pointerdown', (event) => { this.drag = { x: event.clientX, y: event.clientY, ox: this.pan.x, oy: this.pan.y, moved: false }; canvas.setPointerCapture(event.pointerId); }, options);
    canvas.addEventListener('pointermove', (event) => {
      if (!this.drag) return;
      const scale = W / canvas.getBoundingClientRect().width;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) this.drag.moved = true;
      if (this.zoom > 1) this.pan = { x: Math.max(-W / 2, Math.min(W / 2, this.drag.ox + dx * scale)), y: Math.max(-H / 2, Math.min(H / 2, this.drag.oy + dy * scale)) };
    }, options);
    canvas.addEventListener('pointerup', (event) => {
      if (!this.drag?.moved) {
        const rect = canvas.getBoundingClientRect();
        const x = ((event.clientX - rect.left) * W / rect.width - this.pan.x - W * (1 - this.zoom) / 2) / this.zoom;
        const y = ((event.clientY - rect.top) * H / rect.height - this.pan.y - H * (1 - this.zoom) / 2) / this.zoom;
        const hit = [...this.actors.values()].find((actor) => Math.abs(actor.x - x) < 30 && y > actor.y - 76 && y < actor.y + 20);
        if (hit) this.onSelect(hit.data.id);
      }
      this.drag = null;
    }, options);
    canvas.addEventListener('pointercancel', () => { this.drag = null; }, options);
    this.human = spriteFrames('oscar'); this.draw(0);
  }

  // update 接收真实快照；初次进入或断线恢复不重放历史事件作为新工作。
  update(snapshot, reconnect = false) {
    if (this.projectId !== snapshot.projectId) { this.projectId = snapshot.projectId; this.actors.clear(); this.messages = []; this.lastEvent = null; }
    this.progress = snapshot.progress;
    snapshot.actors.forEach((data, index) => {
      if (!this.frames.has(data.character)) this.frames.set(data.character, spriteFrames(data.character));
      const target = targetFor(data, index), actor = this.actors.get(data.id);
      if (!actor) this.actors.set(data.id, { data, x: target.x, y: target.y, path: [], target });
      else {
        actor.data = data;
        if (actor.target.x !== target.x || actor.target.y !== target.y) {
          actor.path = [{ x: actor.x, y: 258 }, { x: target.x, y: 258 }, target]; actor.target = target;
        }
      }
    });
    for (const event of snapshot.messages) {
      if (this.lastEvent !== null && event.id > this.lastEvent && !reconnect && this.visible && this.motion) {
        const start = this.actors.get(event.from) || seats[event.from], end = this.actors.get(event.to) || seats[event.to];
        if (start && end) this.messages.push({ sx: start.x, sy: start.y - 36, ex: end.x, ey: end.y - 36, elapsed: 0, duration: Math.max(.8, Math.min(2, Math.hypot(end.x - start.x, end.y - start.y) / 230)) });
      }
    }
    this.lastEvent = Math.max(this.lastEvent || 0, ...snapshot.messages.map((message) => message.id));
    this.online = true;
    if (!this.motion) this.snap();
    this.draw(0);
  }

  // snap 在减少动态或断线时直接展示确认过的位置。
  snap() { for (const actor of this.actors.values()) { actor.x = actor.target.x; actor.y = actor.target.y; actor.path = []; } this.messages = []; }

  // setVisible 只在办公室可见时运行帧循环，避免隐藏工作台消耗资源。
  setVisible(value) {
    if (this.visible === value) return;
    this.visible = value;
    cancelAnimationFrame(this.frame);
    if (value) { this.lastTime = performance.now(); this.frame = requestAnimationFrame((time) => this.tick(time)); }
  }

  // tick 限制每步时间，切回后台页面时不会突然快进动画。
  tick(time) {
    if (!this.visible) return;
    const dt = Math.min(.05, (time - this.lastTime) / 1000); this.lastTime = time;
    const moving = this.messages.length > 0 || [...this.actors.values()].some((actor) => actor.path.length || actor.data.state === 'working');
    if (!document.hidden && moving && this.motion && this.online) this.draw(dt);
    this.frame = requestAnimationFrame((next) => this.tick(next));
  }

  // setMotion 只控制动画，界面文字明确区分它与暂停项目。
  setMotion(value) { this.motion = value; if (!value) this.snap(); this.draw(0); }

  // fit 恢复完整办公室视野。
  fit() { this.zoom = 1; this.pan = { x: 0, y: 0 }; this.draw(0); }

  // zoomBy 调整镜头缩放，后续可通过拖动查看各个工位。
  zoomBy(amount) { this.zoom = Math.max(1, Math.min(2, this.zoom + amount)); if (this.zoom === 1) this.pan = { x: 0, y: 0 }; this.draw(0); }

  // select 更新选中角色的描边，控制动作仍由业务界面处理。
  select(id) { this.selected = id; this.draw(0); }

  // draw 绘制办公室、真实角色状态和基于实际事件的信封传递。
  draw(dt) {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== W * ratio) { this.canvas.width = W * ratio; this.canvas.height = H * ratio; }
    const ctx = this.ctx;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.save(); ctx.translate(W * (1 - this.zoom) / 2 + this.pan.x, H * (1 - this.zoom) / 2 + this.pan.y); ctx.scale(this.zoom, this.zoom);
    ctx.drawImage(this.floor, 0, 0); text(ctx, `任务 ${this.progress.done}/${this.progress.total}   ·   测试 ${this.progress.passed}/${this.progress.checks}`, 360, 89, 10, '#5c7970', 'center');
    for (const actor of this.actors.values()) {
      const next = actor.path[0];
      if (next && dt > 0) {
        const dx = next.x - actor.x, dy = next.y - actor.y, distance = Math.hypot(dx, dy), step = dt * 92;
        if (distance <= step) { actor.x = next.x; actor.y = next.y; actor.path.shift(); }
        else { actor.x += dx / distance * step; actor.y += dy / distance * step; }
      }
      const { data } = actor, x = Math.round(actor.x), y = Math.round(actor.y);
      const walking = actor.path.length > 0 && this.motion && this.online;
      const phase = walking ? [0, 1, 0, 2][Math.floor(performance.now() / 150) % 4] : 0;
      const frame = this.frames.get(data.character)?.front[phase];
      if (data.id === this.selected) { box(ctx, x - 25, y - 3, 50, 6, '#eadb9c', '#a79458'); }
      if (frame) ctx.drawImage(frame, x - 18, y - 64, 36, 64);
      const color = stateColors[data.state];
      box(ctx, x - 31, y - 83, 62, 16, '#fffaf0', '#889b8e'); box(ctx, x - 26, y - 78, 5, 5, color);
      text(ctx, states[data.state], x + 5, y - 75, 8, '#51675c', 'center');
      text(ctx, data.name, x, y + 13, 10, '#415c55', 'center');
      if (data.state === 'working' && this.online) { const phaseDot = Math.floor(performance.now() / 450) % 3; for (let dot = 0; dot < 3; dot++) box(ctx, x - 5 + dot * 5, y - 92, 3, 3, !this.motion || dot === phaseDot ? '#729c8e' : '#b1c4b1'); }
    }
    ctx.drawImage(this.human.front[0], seats.human.x - 18, seats.human.y - 64, 36, 64); text(ctx, '你', seats.human.x, 436, 10, '#526658', 'center');
    for (const message of this.messages) {
      message.elapsed += dt; const t = Math.min(1, message.elapsed / message.duration), e = easeInOut(t);
      const x = message.sx + (message.ex - message.sx) * e, y = message.sy + (message.ey - message.sy) * e - 38 * Math.sin(Math.PI * e);
      // 信封轨迹改编自上游 MessageEnvelope.ts，保留距离速度与弧线公式。
      box(ctx, x - 7, y - 5, 14, 10, '#ffedb2', '#725f44');
      ctx.strokeStyle = '#725f44'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 6, y - 4); ctx.lineTo(x, y + 1); ctx.lineTo(x + 6, y - 4); ctx.stroke();
    }
    this.messages = this.messages.filter((message) => message.elapsed < message.duration);
    ctx.restore();
  }

  // destroy 释放画布事件与动画帧，避免多次进入视图造成重复监听。
  destroy() { this.visible = false; cancelAnimationFrame(this.frame); this.abort.abort(); }
}

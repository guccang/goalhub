// 本文件验证原版地图完整性、真实任务桥接与寻路边界，避免只检查截图外观。
import { renderSpeech, speechToken } from '../office-engine/speech.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { goalhubBridge } from '../office-engine/bridge.ts';
import { findPath } from '../office-engine/upstream/scene/office/pathfinding.ts';

// 原图与图集不得被简化替换，所有绘制 tile 必须能落在实际图集范围内。
test('完整办公室地图及三张图集与固定上游一致，图块引用有效', () => {
  const root = new URL('../office-engine/upstream/', import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL('../office-engine/UPSTREAM.json', import.meta.url)));
  const files = ['assets/maps/office.tmj', 'assets/tilesets/office-tileset.png', 'assets/tilesets/a5-office-floors-walls.png', 'assets/tilesets/interiors.png'];
  for (const file of files) assert.equal(createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex'), metadata.originalSha256[file]);
  const map = JSON.parse(readFileSync(new URL(files[0], root)));
  const atlases = files.slice(1).map((file, index) => { const data = readFileSync(new URL(file, root)); return { first: [1, 513, 1025][index], count: data.readUInt32BE(16) * data.readUInt32BE(20) / 256 }; });
  for (const layer of map.layers.filter(layer => ['floor', 'walls', 'furniture-below', 'furniture-above'].includes(layer.name))) {
    assert.equal(layer.data.length, map.width * map.height);
    for (const raw of layer.data) { const gid = raw & 0x1fffffff; if (!gid) continue; const atlas = atlases.findLast(atlas => atlas.first <= gid); assert.ok(atlas && gid - atlas.first < atlas.count, `无效图块 ${gid}`); }
  }
  assert.ok(map.layers.find(layer => layer.name === 'spawn-points').objects.some(point => point.name === 'cafe-seat-4'));
});

// 场景纸条必须来自实际任务，人工问题和完成状态按原版契约映射。
test('办公室桥接保留真实任务、待答问题和消息取消订阅', async () => {
  goalhubBridge.project = { status: 'running', tasks: [{ id: 'a', status: 'done' }, { id: 'b', status: 'running' }], questions: [{ id: 'q', prompt: '需要资料', answer: null }] };
  const { tasks } = await goalhubBridge.hiveTasks();
  assert.deepEqual(tasks.map(task => task.status), ['done', 'doing', 'blocked']);
  assert.equal(tasks[2].humanQA[0].q, '需要资料');
  const messages = []; const unsubscribe = goalhubBridge.onHiveMessage(message => messages.push(message));
  goalhubBridge.emit({ from: 'planner', targets: ['developer'], act: 'request', needsHuman: false });
  unsubscribe(); goalhubBridge.emit({ from: 'test', targets: ['developer'], act: 'done', needsHuman: false });
  assert.equal(messages.length, 1); goalhubBridge.project = null;
});

// 碰撞寻路必须绕行墙体，禁止穿墙或把不可达目标当作成功。
test('原版 BFS 避开碰撞图块并拒绝不可达目标', () => {
  const map = { width: 5, height: 5, isWalkable(x, y) { return x >= 0 && y >= 0 && x < 5 && y < 5 && !(x === 2 && y < 4); } };
  const path = findPath(map, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.ok(path.some(point => point.y === 4)); assert.ok(path.every(point => map.isWalkable(point.x, point.y)));
  assert.equal(findPath(map, { x: 0, y: 0 }, { x: 2, y: 1 }), null);
});

// 气泡按说话员工选择语言，同一语义在混合母语对话中保持一致。
test('四语气泡、插值与原始工作内容互不混淆', () => {
  const greeting = speechToken('solo.coffee.0');
  assert.equal(renderSpeech(greeting), '先喝杯咖啡');
  assert.equal(renderSpeech(greeting, 'en'), 'Coffee first');
  assert.equal(renderSpeech(greeting, 'ja'), 'まずはコーヒー');
  assert.equal(renderSpeech(greeting, 'ko'), '먼저 커피 한 잔');
  assert.equal(renderSpeech(speechToken('pair.0.0'), 'en'), 'Coffee?');
  assert.equal(renderSpeech(speechToken('pair.0.1'), 'ja'), 'いいね、少し休もう。');
  assert.match(renderSpeech(speechToken('office.suckUp.1', { done: 7 }), 'ko'), /7/);
  assert.equal(renderSpeech('User-provided task title', 'ja'), 'User-provided task title');
  const catalog = JSON.parse(readFileSync(new URL('../office-engine/speech.json', import.meta.url)));
  // 递归检查各语言均具备中文目录中的内置台词，避免空白气泡。
  function walk(value, path = '') {
    if (typeof value === 'string') {
      if (path === 'gpuError') return;
      for (const language of ['en', 'ja', 'ko']) assert.ok(renderSpeech(speechToken(path), language), `${language}:${path}`);
    } else for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
  }
  walk(catalog['zh-CN']);
});

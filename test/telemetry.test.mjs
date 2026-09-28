// 本文件验证不同宿主的计量口径、缺失数据及上报事件去重。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTelemetry } from '../lib/telemetry.mjs';

test('用量不充当上下文，缓存读取只作为输入子集，缺失数据保持未知', () => {
  const codex = normalizeTelemetry({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 } }, 'codex');
  assert.deepEqual(codex.usage, { input: 100, output: 20, cached: 80, cacheWrite: 0 });
  assert.equal(codex.context, undefined);
  const claude = normalizeTelemetry({ type: 'result', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } }, 'claudecode');
  assert.equal(claude.usage.input, 95);
  assert.equal(normalizeTelemetry({ type: 'turn.completed', usage: { input_tokens: 100 } }, 'codex'), null);
  assert.equal(normalizeTelemetry({ type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 5 } }, 'codex'), null);
  assert.equal(normalizeTelemetry({ type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { total_tokens: 250 }, total_token_usage: { total_tokens: 50000 } } } }, 'codex').context.used, 250);
  assert.ok(normalizeTelemetry({ type: 'compacted', timestamp: '2026-09-28' }, 'codex').compaction);
});

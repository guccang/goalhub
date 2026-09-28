// 本文件从宿主原始事件提取真实用量与上下文；不把累计 tokens 当作上下文占用。
import { globSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// count 仅接受非负且安全的宿主整数，缺失值由调用者明确处理。
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

// normalizeTelemetry 按宿主事件语义计量，重复结束事件使用稳定编号覆盖而非重复累加。
export function normalizeTelemetry(event, host) {
  const value = typeof event === 'string' ? JSON.parse(event) : event;
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'turn_context' && typeof value.payload?.model === 'string') return { model: value.payload.model, source: host };
  if (host === 'claudecode' && value.type === 'system' && value.subtype === 'init' && typeof value.model === 'string') return { model: value.model, source: host };
  let usage, key;
  if (host === 'codex' && value.type === 'turn.completed' && value.usage) {
    const u = value.usage;
    usage = { input: count(u.input_tokens), output: count(u.output_tokens), cached: count(u.cached_input_tokens) ?? 0, cacheWrite: count(u.cache_write_input_tokens) ?? 0 };
    key = value.turn_id || 'codex-turn';
  } else if (host === 'claudecode' && value.type === 'result' && !value.parent_tool_use_id && value.usage) {
    const u = value.usage, cached = count(u.cache_read_input_tokens) ?? 0, cacheWrite = count(u.cache_creation_input_tokens) ?? 0;
    usage = { input: count(u.input_tokens) === null ? null : u.input_tokens + cached + cacheWrite, output: count(u.output_tokens), cached, cacheWrite };
    key = 'claude-result';
  } else if (host === 'opencode' && value.type === 'step_finish' && value.part?.tokens && value.part.id) {
    const u = value.part.tokens, cached = count(u.cache?.read) ?? 0, cacheWrite = count(u.cache?.write) ?? 0;
    usage = { input: count(u.input) === null ? null : u.input + cached + cacheWrite, output: count(u.output), cached, cacheWrite };
    key = value.part.id;
  }
  if (usage && usage.input !== null && usage.output !== null) return { key, usage, source: host, cumulative: host === 'codex' };
  const payload = value.type === 'event_msg' ? value.payload : value;
  if (payload?.type === 'token_count' && payload.info) {
    const window = count(payload.info.model_context_window), used = count(payload.info.last_token_usage?.total_tokens);
    if (window > 0 && used !== null) return { key: 'context', source: host, at: value.timestamp, context: { window, used } };
  }
  if (value.type === 'system' && value.subtype === 'compact_boundary' || value.type === 'compacted' || payload?.type === 'context_compacted') {
    return { key: value.uuid || createHash('sha256').update(JSON.stringify(value)).digest('hex'), source: host, at: value.timestamp, compaction: { before: count(value.compact_metadata?.pre_tokens) } };
  }
  return null;
}

// codexBaseline 在启动恢复会话之前读取累计计数，跨目标只计新增部分，旧版未知基线不猜测。
export function codexBaseline(home, session) {
  if (!session) return { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  if (!/^[a-f0-9-]{36}$/i.test(session) || !existsSync(home)) return null;
  try {
    const file = globSync('sessions/**/*.jsonl', { cwd: home }).find(path => path.includes(session));
    if (!file) return null;
    const path = join(home, file), size = statSync(path).size, fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, 1048576));
      readSync(fd, buffer, 0, buffer.length, size - buffer.length);
      for (const line of buffer.toString('utf8').split('\n').reverse()) {
        try {
          const u = JSON.parse(line).payload?.info?.total_token_usage;
          if (u && count(u.input_tokens) !== null && count(u.output_tokens) !== null) return { input: u.input_tokens, output: u.output_tokens, cached: count(u.cached_input_tokens) ?? 0, cacheWrite: count(u.cache_write_input_tokens) ?? 0 };
        } catch { /* 忽略尾部不完整行。 */ }
      }
    } finally { closeSync(fd); }
  } catch { /* 无基线时由持久统计补齐，否则保持未知。 */ }
  return null;
}

// watchCodexContext 只读取明确会话的新增记录，补齐 exec JSON 流未包含的上下文容量和压缩事件。
export function watchCodexContext(home, getSession, emit) {
  const startedAt = Date.now();
  let path, offset = 0, pending = '', searched = '', stopped = false, initial = true;
  // poll 初次只读尾部上下文，之后按字节游标读取，避免重复统计整个历史会话。
  function poll() {
    try {
      const session = getSession();
      if (!/^[a-f0-9-]{36}$/i.test(session || '') || !existsSync(home)) return;
      if (!path && searched !== session) {
        path = globSync('sessions/**/*.jsonl', { cwd: home }).find(file => file.includes(session));
        if (!path) return;
        path = join(home, path); searched = session;
        offset = Math.max(0, statSync(path).size - 262144);
      }
      if (!path) return;
      const size = statSync(path).size;
      if (size < offset) { offset = 0; pending = ''; }
      const fd = openSync(path, 'r');
      try {
        while (offset < size) {
          const buffer = Buffer.alloc(Math.min(size - offset, 262144));
          const n = readSync(fd, buffer, 0, buffer.length, offset); if (!n) break;
          offset += n; pending += buffer.subarray(0, n).toString('utf8');
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) {
            try { const sample = normalizeTelemetry(JSON.parse(line), 'codex'); if (sample?.context || sample?.model || sample?.compaction && (!initial || Date.parse(sample.at) >= startedAt)) emit(sample); } catch { /* 部分行不作为有效上报。 */ }
          }
        }
      } finally { closeSync(fd); initial = false; }
    } catch { /* 宿主未提供会话文件时显示未知，不影响业务执行。 */ }
  }
  const timer = setInterval(poll, 3000); timer.unref();
  return () => { if (!stopped) { stopped = true; clearInterval(timer); poll(); } };
}

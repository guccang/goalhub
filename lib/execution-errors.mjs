// 本文件把可验证的员工执行错误归档为独立记录，普通进展文字不推断为错误。
import { createHash } from 'node:crypto';

// executionError 从原始宿主协议识别命令失败、工具失败与回合失败。
export function executionError(value) {
  let event;
  try { event = typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  if (!event || typeof event !== 'object') return null;
  const item = event.item || event;
  if (item.type === 'command_execution' && Number.isInteger(item.exit_code) && item.exit_code !== 0) return { kind: 'command', itemId: item.id, command: item.command || '', exitCode: item.exit_code, message: item.aggregated_output || `命令退出码 ${item.exit_code}` };
  if (['turn.failed', 'error'].includes(event.type) || item.type === 'error') return { kind: 'host', itemId: item.id, message: event.error?.message || event.message || item.message || JSON.stringify(event) };
  if (item.type === 'mcp_tool_call' && (item.error || item.result?.isError || item.status === 'failed')) return { kind: 'tool', itemId: item.id, command: `${item.server || ''}/${item.tool || ''}`, message: JSON.stringify(item.error || item.result || item) };
  return null;
}

// initializeErrors 增量创建错误表，不改变已有运行状态和历史记录。
export function initializeErrors(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS error (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, task_id TEXT NOT NULL DEFAULT '', assignment_id TEXT NOT NULL DEFAULT '',
    run_id TEXT NOT NULL DEFAULT '', employee_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
    message TEXT NOT NULL, command TEXT NOT NULL DEFAULT '', exit_code INTEGER, context TEXT NOT NULL,
    event_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS error_project_time ON error(project_id,id);
    CREATE INDEX IF NOT EXISTS error_run ON error(run_id,id);
    CREATE INDEX IF NOT EXISTS error_assignment ON error(task_id,assignment_id,id);`);
}

// errorKey 同一协议事件只保存一次，不把不同轮次或不同命令的重复错误合并。
export function errorKey(runId, value) {
  return createHash('sha256').update(JSON.stringify([runId, value.kind, value.itemId || '', value.command || '', value.message, value.exitCode ?? null])).digest('hex');
}

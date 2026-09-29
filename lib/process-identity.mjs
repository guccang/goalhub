// 本文件用进程启动时间识别 Windows PID 复用，查询失败时保留保护性阻断。
import { execFileSync } from 'node:child_process';

// processStartedAt 只查询指定数字 PID 的创建时间，不读取命令行或终止进程。
export function processStartedAt(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return '';
  try {
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
    return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

// previousProcessAlive 比较真实创建时间；旧记录只在明确晚于结束时间时判定为 PID 复用。
export function previousProcessAlive(run, { probe = pid => process.kill(pid, 0), startedAt = processStartedAt } = {}) {
  try { probe(run.process_id); } catch (error) { if (error.code === 'ESRCH') return false; }
  const actual = Date.parse(startedAt(run.process_id));
  if (!Number.isFinite(actual)) return true;
  const recorded = Date.parse(run.process_started_at);
  if (Number.isFinite(recorded)) return actual === recorded;
  const ended = Date.parse(run.finished_at);
  return !Number.isFinite(ended) || actual <= ended;
}

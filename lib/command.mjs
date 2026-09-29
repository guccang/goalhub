// 本文件保留员工命令的解释器选择，避免外层 PowerShell 提前展开内层变量。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// windowsArguments 按 Windows 双引号及反斜杠规则拆参数，不解释变量和脚本语法。
export function windowsArguments(command) {
  const args = [];
  let value = '', quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\') {
      let count = 1;
      while (command[i + 1] === '\\') { count++; i++; }
      if (command[i + 1] === '"') {
        value += '\\'.repeat(Math.floor(count / 2)); i++;
        if (count % 2) value += '"'; else quoted = !quoted;
      } else value += '\\'.repeat(count);
      started = true;
    } else if (char === '"') {
      if (quoted && command[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
      started = true;
    }
    else if (/\s/.test(char) && !quoted) {
      if (started) { args.push(value); value = ''; started = false; }
    } else { value += char; started = true; }
  }
  if (quoted) throw new Error('验收命令的双引号未闭合，请员工修正命令');
  if (started) args.push(value);
  return args;
}

// runCommand 显式 PowerShell 只启动一次，其余 Windows 命令使用原生命令行语义。
export async function runCommand(runtime, command, cwd, onLine, platform = process.platform) {
  if (platform !== 'win32') return runtime.runProcess('/bin/sh', ['-c', command], { cwd, onLine });
  const executable = command.trim().match(/^(?:"([^"]+)"|(\S+))/);
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable?.[1] || executable?.[2] || '')) {
    const [program, ...args] = windowsArguments(command);
    return runtime.runProcess(program, args, { cwd, onLine });
  }
  // 临时批处理原样保存命令，避免 Node 对 cmd /c 参数的二次引号转义。
  const directory = await mkdtemp(join(tmpdir(), 'goalhub-command-'));
  const file = join(directory, 'command.cmd');
  try {
    await writeFile(file, `@echo off\r\n@chcp 65001 >nul\r\n${command}\r\n`, 'utf8');
    const handle = runtime.runProcess(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', file], { cwd, onLine });
    return { ...handle, done: handle.done.finally(() => rm(directory, { recursive: true, force: true })) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

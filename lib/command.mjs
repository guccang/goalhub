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

// quoteWindowsArgument 为原生进程保留空参数、内嵌引号和结尾反斜杠。
function quoteWindowsArgument(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

// powershellLiteral 只生成字符串常量，不让启动器解释用户脚本变量。
function powershellLiteral(value) { return `'${value.replaceAll("'", "''")}'`; }

// runPowerShell 在继承的控制台设置 UTF-8，原进程保留全部参数和原始输出管道。
async function runPowerShell(runtime, program, args, cwd, onLine) {
  const directory = await mkdtemp(join(tmpdir(), 'goalhub-powershell-'));
  const file = join(directory, 'launch.ps1');
  // 使用原生进程 API 继承管道，避免 PowerShell 将标准错误重新包装成错误对象。
  const script = `\ufeff$ErrorActionPreference = 'Stop'
# 优先加载当前解释器自带模块，避免 Windows PowerShell 误用父进程的 PowerShell 7 模块。
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules') + [System.IO.Path]::PathSeparator + $env:PSModulePath
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$process = [System.Diagnostics.Process]::new()
$process.StartInfo.FileName = ${powershellLiteral(program)}
$process.StartInfo.Arguments = ${powershellLiteral(args.map(quoteWindowsArgument).join(' '))}
$process.StartInfo.WorkingDirectory = ${powershellLiteral(cwd)}
$process.StartInfo.UseShellExecute = $false
[void]$process.Start()
$process.WaitForExit()
exit $process.ExitCode
`;
  try {
    await writeFile(file, script, 'utf8');
    const handle = runtime.runProcess(program, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { cwd, onLine });
    return { ...handle, done: handle.done.finally(() => rm(directory, { recursive: true, force: true })) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

// runCommand 保留显式解释器语义，统一 Windows 输出编码与采集器一致。
export async function runCommand(runtime, command, cwd, onLine, platform = process.platform) {
  if (platform !== 'win32') return runtime.runProcess('/bin/sh', ['-c', command], { cwd, onLine });
  const executable = command.trim().match(/^(?:"([^"]+)"|(\S+))/);
  if (/(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(executable?.[1] || executable?.[2] || '')) {
    const [program, ...args] = windowsArguments(command);
    return runPowerShell(runtime, program, args, cwd, onLine);
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

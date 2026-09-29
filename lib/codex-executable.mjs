// 本文件定位 Codex CLI，避免桌面应用注入的临时 PATH 成为后端启动前提。
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

// executableFile 只接受仍存在的普通文件，应用升级移除旧版本后重新发现。
function executableFile(path) { try { return isAbsolute(path) && statSync(path).isFile(); } catch { return false; } }

// codexInvocation 优先显式配置和已有 PATH/npm 安装，再发现桌面应用提供的 CLI。
export function codexInvocation(module, args, env = process.env, platform = process.platform) {
  const configured = env.GOALHUB_CODEX_PATH;
  if (configured) {
    if (!executableFile(configured) || platform === 'win32' && !/\.exe$/i.test(configured)) throw new Error('GOALHUB_CODEX_PATH 必须指向存在的 Codex 可执行文件绝对路径');
    return { command: configured, args };
  }
  if (platform !== 'win32') return { command: 'codex', args };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  // 独立启动后端可能没有 npm 路径，补充当前用户的标准安装位置，不修改全局环境。
  const paths = [env[pathKey] || '', join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm')].filter(Boolean).join(';');
  const existing = module.processCommand?.('codex', args, { ...env, [pathKey]: paths }, platform);
  if (existing && existing.command !== 'codex' && executableFile(existing.command)) return existing;
  for (const path of paths.split(';')) if (path && executableFile(join(path, 'codex.exe'))) return { command: join(path, 'codex.exe'), args };
  const root = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  let versions = [];
  if (existsSync(root)) versions = readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => join(root, item.name, 'codex.exe')).filter(executableFile);
  // 不把哈希目录名当版本号；按实际更新时间选择，并在每次启动时重新检查。
  versions.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
  const command = executableFile(join(root, 'codex.exe')) ? join(root, 'codex.exe') : versions[0];
  if (!command) throw new Error('找不到 Codex CLI：已检查 PATH、用户 npm 和 Codex 桌面安装目录。请安装 Codex CLI，或用 GOALHUB_CODEX_PATH 指定 codex.exe 的绝对路径。此错误发生在登录之前。');
  return { command, args };
}

// runCodexProcess 所有认证、模型查询和员工执行入口共用同一定位逻辑。
export function runCodexProcess(module, command, args, options = {}) {
  const invocation = command === 'codex' ? codexInvocation(module, args, options.env || process.env) : { command, args };
  return module.runProcess(invocation.command, invocation.args, options);
}

// 本文件接入公共 agent-runtime，只封装加载与宿主状态，不复制 CLI 协议实现。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { codexSettings, codexEnvironment } from './host-auth.mjs';

export const defaultRuntimePath = 'F:\\Documents\\game-engine\\tools\\agent-runtime\\index.mjs';

export class Runtime {
  // constructor 允许通过环境变量指定公共模块路径。
  constructor(dataDir, modulePath = process.env.AGENT_RUNTIME_PATH || defaultRuntimePath) {
    this.dataDir = dataDir; this.path = resolve(modulePath); this.loaded = null;
  }

  // load 延迟加载，使缺少运行模块时页面仍可打开并显示配置提示。
  async load() {
    if (!this.loaded) this.loaded = import(pathToFileURL(this.path).href).catch((error) => { this.loaded = null; throw new Error(`无法加载 agent-runtime：${error.message}`); });
    return this.loaded;
  }

  // status 展示模块是否存在，不将文件存在冒充模型认证成功。
  status() { return { available: existsSync(this.path), path: this.path, message: existsSync(this.path) ? '公共运行模块可用；CLI 登录与额度在执行时验证。' : '找不到公共运行模块，请设置 AGENT_RUNTIME_PATH。' }; }

  // host 把项目设置和事件回调传给公共运行入口。
  async host(options) {
    const runtime = await this.load();
    const mode = codexSettings(this.dataDir).authMode;
    const parent = options.hostType === 'codex' ? codexEnvironment(runtime, this.dataDir, mode) : process.env;
    // Claude 全局配置对任意模型名生效，包括第三方包含斜杠的模型标识。
    const env = runtime.hostEnvironment(this.dataDir, options.hostType, parent, options.hostType === 'claudecode' ? '' : options.model);
    if (options.hostType === 'claudecode' && options.model) {
      env.ANTHROPIC_MODEL = options.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = options.model; env.ANTHROPIC_DEFAULT_SONNET_MODEL = options.model; env.ANTHROPIC_DEFAULT_HAIKU_MODEL = options.model;
    }
    // 独立 Codex 凭据目录同时用于登录与执行，明确固定所选认证方式。
    const execute = options.hostType === 'codex' && mode !== 'local'
      ? (command, args, config) => runtime.runProcess(command, ['-c', 'cli_auth_credentials_store="file"', '-c', `forced_login_method="${mode === 'api' ? 'api' : 'chatgpt'}"`, ...args], config)
      : undefined;
    return runtime.runHost({ ...options, env, ...(execute ? { execute } : {}), stopOnNetworkError: true });
  }

  // command 使用公共进程管理器运行验收命令，支持停止整个进程树。
  async command(command, cwd, onLine) {
    const runtime = await this.load();
    return process.platform === 'win32'
      ? runtime.runProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${command}; if ($LASTEXITCODE) { exit $LASTEXITCODE }`], { cwd, onLine })
      : runtime.runProcess('/bin/sh', ['-c', command], { cwd, onLine });
  }
}

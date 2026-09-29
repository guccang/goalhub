// 本文件接入公共 agent-runtime，只封装加载与宿主状态，不复制 CLI 协议实现。
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { normalizeTelemetry, watchCodexContext, codexBaseline } from './telemetry.mjs';
import { codexSettings, codexEnvironment } from './host-auth.mjs';
import { runCommand } from './command.mjs';
import { executionError } from './execution-errors.mjs';
import { runCodexProcess } from './codex-executable.mjs';

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

  // models 复用公共 Codex 目录协议，与实际执行采用相同的认证目录和模式。
  async models(hostType) {
    this.modelQueries ||= new Map();
    if (!this.modelQueries.has(hostType)) {
      const query = this.queryModels(hostType).finally(() => { if (this.modelQueries.get(hostType) === query) this.modelQueries.delete(hostType); });
      this.modelQueries.set(hostType, query);
    }
    return this.modelQueries.get(hostType);
  }
  // invalidateModels 保存认证后使后续查询使用新配置，旧响应不影响新的查询。
  invalidateModels(hostType) { this.modelQueries?.delete(hostType); }
  // queryModels 只读取目录，合并同一宿主的并发查询，失败不缓存。
  async queryModels(hostType) {
    if (!['codex', 'claudecode', 'deepseek-harness', 'opencode'].includes(hostType)) throw new Error('不支持的 Agent 宿主');
    if (hostType !== 'codex') return { models: [], supported: false, message: '此宿主暂未提供模型目录接口，可输入供应商模型名称。' };
    const runtime = await this.load();
    const { listCodexModels } = await import(new URL('./codex-models.mjs', pathToFileURL(this.path)));
    const mode = codexSettings(this.dataDir).authMode;
    const env = codexEnvironment(runtime, this.dataDir, mode);
    // execute 保证查询不会意外使用其他登录方式，超时与进程回收由公共模块负责。
    const execute = (command, args, options) => runCodexProcess(runtime, command, mode === 'local' ? args : ['-c', 'cli_auth_credentials_store="file"', '-c', `forced_login_method="${mode === 'api' ? 'api' : 'chatgpt'}"`, ...args], options);
    const models = await listCodexModels({ cwd: this.dataDir, env, execute });
    return { models, supported: true, message: '已读取当前已保存认证配置的模型目录；可用性请通过连通性测试确认。' };
  }

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
    const baseline = options.hostType === 'codex' ? codexBaseline(env.CODEX_HOME || join(homedir(), '.codex'), options.sessionId) : null;
    // execute 同时保留原协议解析与原始统计事件，避免 result 文本化后丢失用量。
    const execute = (command, args, config) => {
      const actualArgs = options.hostType === 'codex' && mode !== 'local'
        ? ['-c', 'cli_auth_credentials_store="file"', '-c', `forced_login_method="${mode === 'api' ? 'api' : 'chatgpt'}"`, ...args] : args;
      return runCodexProcess(runtime, command, actualArgs, { ...config,
        // onLine 先采集统计，再把原始行交回共享运行模块。
        onLine(kind, line) {
          if (kind === 'stdout') { const failure = executionError(line); if (failure) options.onExecutionError?.(failure); try { const sample = normalizeTelemetry(line, options.hostType); if (sample) options.onTelemetry?.({ ...sample, baseline, resumed: !!options.sessionId }); } catch { /* 普通文本不是统计事件。 */ } }
          config.onLine?.(kind, line);
        }
      });
    };
    let session = options.sessionId || '';
    const stopWatch = options.hostType === 'codex' && options.onTelemetry
      ? watchCodexContext(env.CODEX_HOME || join(homedir(), '.codex'), () => session, options.onTelemetry) : () => {};
    try {
      const job = runtime.runHost({ ...options, env, execute, stopOnNetworkError: true,
        // onSession 以宿主真实会话编号定位上下文文件。
        onSession(value) { session = value; options.onSession?.(value); }
      });
      return { ...job, done: job.done.finally(stopWatch) };
    } catch (error) { stopWatch(); throw error; }
  }

  // command 使用公共进程管理器运行验收命令，支持停止整个进程树。
  async command(command, cwd, onLine) {
    const runtime = await this.load();
    return runCommand(runtime, command, cwd, onLine);
  }
}

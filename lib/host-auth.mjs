// 本文件适配公共 agent-runtime 的认证能力，Codex 凭据保存在独立目录，公开接口只返回状态。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCodexProcess } from './codex-executable.mjs';
import { redact } from './store.mjs';

// codexSettings 读取认证方式，旧项目默认继续沿用本机登录。
export function codexSettings(dataDir) {
  const path = join(dataDir, 'host-settings', 'codex-auth.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { authMode: 'local' };
}

// codexEnvironment 为设备码与 API 登录隔离凭据，避免覆盖用户桌面登录。
export function codexEnvironment(module, dataDir, mode, parent = process.env) {
  const env = module.codexAuthEnvironment(parent);
  for (const key of Object.keys(env)) if (['OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'].includes(key.toUpperCase())) delete env[key];
  if (mode !== 'local') {
    env.CODEX_HOME = join(dataDir, 'codex-auth', mode);
    mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  }
  return env;
}

// inspectCodex 只公开 API 凭据存在状态，不回显认证文件内容。
export function inspectCodex(dataDir) {
  return { hostType: 'codex', ...codexSettings(dataDir), hasApiKey: existsSync(join(dataDir, 'codex-auth', 'api', 'auth.json')), baseUrl: '', provider: 'deepseek' };
}

// saveCodex 通过 stdin 交给 CLI 保存 API 登录，不把密钥放进命令参数或日志。
export async function saveCodex(module, dataDir, value) {
  const authMode = value.authMode || 'local';
  if (!['local', 'device', 'api'].includes(authMode)) throw new Error('不支持的 Codex 认证方式');
  const key = value.apiKey || '';
  if (typeof key !== 'string' || key.length > 16000 || /[\r\n]/.test(key)) throw new Error('API Key 必须为单行字符串');
  if (value.clearApiKey !== undefined && typeof value.clearApiKey !== 'boolean') throw new Error('清除密钥必须为布尔值');
  const env = codexEnvironment(module, dataDir, 'api');
  if (value.clearApiKey) rmSync(join(env.CODEX_HOME, 'auth.json'), { force: true });
  else if (authMode === 'api' && key.trim()) {
    const job = runCodexProcess(module, 'codex', ['-c', 'cli_auth_credentials_store="file"', 'login', '--with-api-key'], { cwd: dataDir, env, input: key.trim() + '\n' });
    const timer = setTimeout(() => job.stop(), 15000);
    try { const result = await job.done; if (result.code !== 0 || result.error) throw new Error(`Codex API 登录保存失败：${redact(String(result.error || `CLI 退出码 ${result.code}`).replaceAll(key.trim(), '[已隐藏]'))}`); }
    finally { clearTimeout(timer); }
  }
  if (authMode === 'api' && !value.clearApiKey && !inspectCodex(dataDir).hasApiKey) throw new Error('请填写 Codex API Key');
  const directory = join(dataDir, 'host-settings'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'codex-auth.json');
  writeFileSync(path + '.tmp', JSON.stringify({ authMode }), { mode: 0o600 }); renameSync(path + '.tmp', path);
}

export class HostAuth {
  // constructor 从数据库恢复审计，服务重启后将未完成登录标记为中断。
  constructor(store, runtime, timeoutMs = 900000) {
    this.store = store; this.runtime = runtime; this.job = null;
    this.timeoutMs = timeoutMs;
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_auth_events (id INTEGER PRIMARY KEY, status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
      UPDATE host_auth_events SET status='interrupted', message='服务重启，登录已中断' WHERE status='logging_in' AND id=(SELECT MAX(id) FROM host_auth_events);`);
    this.state = { status: 'idle', message: '设备码登录会在官方页面完成授权。', url: '', code: '', expiresAt: null };
  }
  // snapshot 授权码仅在登录期间从内存返回，历史只保存安全状态。
  snapshot() { return { ...this.state, history: this.store.db.prepare('SELECT * FROM host_auth_events ORDER BY id DESC LIMIT 10').all() }; }
  // record 记录不含令牌、密钥及设备码的认证步骤。
  record(status, message) { this.store.db.prepare('INSERT INTO host_auth_events(status,message,created_at) VALUES(?,?,?)').run(status, message, new Date().toISOString()); }
  // start 使用公共设备码入口启动可取消登录，重复请求不会产生多个进程。
  start() {
    if (this.job) return this.snapshot();
    const job = { handle: null, cancelled: false }; this.job = job;
    this.state = { status: 'logging_in', message: '正在获取设备码…', url: '', code: '', expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() };
    this.record('logging_in', '启动 Codex 无头设备码登录');
    job.promise = this.run(job).finally(() => { if (this.job === job) this.job = null; });
    return this.snapshot();
  }
  // run 清洗 CLI 输出，只提取官方地址和设备码，结束时清除一次性信息。
  async run(job) {
    let timer, output = '';
    try {
      const module = await this.runtime.load();
      if (job.cancelled) return;
      const env = codexEnvironment(module, this.runtime.dataDir, 'device');
      job.handle = module.startCodexDeviceLogin({ cwd: this.runtime.dataDir, env, onLine: (_kind, line) => {
        if (job.cancelled) return;
        output = (output + '\n' + line).slice(-12000);
        const auth = module.deviceAuthorization(output);
        this.state = { ...this.state, ...auth, message: auth.url && auth.code ? '打开官方授权页面并输入设备码，完成后返回测试连通性。' : '正在获取设备码…' };
      } }, (command, args, options) => runCodexProcess(module, command, ['-c', 'cli_auth_credentials_store="file"', ...args], options));
      timer = setTimeout(() => { this.cancel('设备码已过期，请重新登录'); }, this.timeoutMs);
      const result = await job.handle.done;
      if (job.cancelled) return;
      if (result.code !== 0 || result.error) throw new Error(result.error || `设备码登录进程退出，退出码 ${result.code}；未完成授权`);
      this.state = { status: 'ready', message: 'Codex 登录成功，请测试连通性。', url: '', code: '', expiresAt: null };
      this.record('ready', this.state.message);
    } catch (error) {
      const detail = redact(String(error.message || error)).split(this.state.code || '\u0000').join('[设备码已清除]').slice(0, 1200);
      if (!job.cancelled) { this.state = { status: 'failed', message: `设备码登录失败：${detail}`, url: '', code: '', expiresAt: null }; this.record('failed', this.state.message); }
    } finally { clearTimeout(timer); }
  }
  // cancel 停止进程并清除设备码，保持任务锁直到进程确认退出。
  cancel(message = '登录已取消') {
    if (this.job) { this.job.cancelled = true; this.job.handle?.stop(); this.record('cancelled', message); }
    this.state = { status: 'idle', message, url: '', code: '', expiresAt: null }; return this.snapshot();
  }
  // close 退出服务时等待登录进程清理，避免在关闭数据库后写入。
  async close() { if (this.job) { this.cancel(); await this.job.promise; } }
}

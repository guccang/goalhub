// 本文件管理宿主配置及真实模型探测，测试输入输出保存到 SQLite，凭据交由公共运行模块保存。
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { redact } from './store.mjs';
import { HostAuth, inspectCodex, saveCodex } from './host-auth.mjs';

export class HostSetup {
  // constructor 恢复公开配置，重启时不把未完成探测视为成功。
  constructor(store, runtime) {
    this.store = store; this.runtime = runtime; this.job = null;
    this.auth = new HostAuth(store, runtime); this.saving = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_profile (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_choices (host_type TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS host_tests (id TEXT PRIMARY KEY, revision TEXT NOT NULL, host_type TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, finished_at TEXT);
      UPDATE host_tests SET status='interrupted', finished_at=datetime('now') WHERE status='running';`);
    const current = this.profile();
    if (current.revision) store.db.prepare('INSERT OR IGNORE INTO host_choices(host_type,value) VALUES(?,?)').run(current.hostType, JSON.stringify(current));
  }
  // profile 返回可公开的默认选择，不包含密钥。
  profile() { const row = this.store.db.prepare('SELECT value FROM host_profile WHERE id=1').get(); return row ? JSON.parse(row.value) : { hostType: 'codex', model: '', revision: '' }; }
  // test 读取一次探测的完整记录。
  test(id) { return this.store.db.prepare('SELECT * FROM host_tests WHERE id=?').get(id); }
  // snapshot 返回设置及最近测试，支持页面刷新恢复。
  async snapshot() {
    const profile = this.profile();
    const module = await this.runtime.load();
    // 每个宿主独立查询最新测试，避免其他宿主的大量记录挤掉其状态。
    const hosts = ['codex', 'claudecode', 'deepseek-harness', 'opencode'].map(hostType => {
      const row = this.store.db.prepare('SELECT value FROM host_choices WHERE host_type=?').get(hostType);
      const saved = row ? JSON.parse(row.value) : null;
      const latest = this.store.db.prepare('SELECT status,revision,created_at FROM host_tests WHERE host_type=? ORDER BY rowid DESC LIMIT 1').get(hostType);
      const status = latest ? latest.revision === saved?.revision ? latest.status : 'stale' : 'untested';
      return { hostType, status, model: saved?.model || '', active: profile.hostType === hostType, testedAt: latest?.created_at || null };
    });
    return { ...profile, hosts, auth: this.auth.snapshot(), credentials: profile.hostType === 'codex' ? inspectCodex(this.runtime.dataDir) : module.inspectHostSettings(this.runtime.dataDir, profile.hostType), tests: this.store.db.prepare('SELECT * FROM host_tests ORDER BY rowid DESC LIMIT 10').all() };
  }
  // save 保存宿主配置；更新版本后旧测试不再满足新建项目的门槛。
  async save(value) {
    if (this.job || this.auth.job || this.saving) throw new Error('请等待当前宿主测试、登录或保存结束');
    this.saving = true;
    try {
    const module = await this.runtime.load();
    if (value.hostType === 'codex') await saveCodex(module, this.runtime.dataDir, value);
    if (value.hostType !== 'codex') module.saveHostSettings(this.runtime.dataDir, value.hostType, { apiKey: value.apiKey || '', baseUrl: value.baseUrl || '', provider: value.provider || 'deepseek', clearApiKey: value.clearApiKey === true });
    this.runtime.invalidateModels?.(value.hostType);
    const profile = { hostType: value.hostType, model: value.model, revision: randomUUID() };
    this.store.db.prepare('INSERT OR REPLACE INTO host_profile(id,value) VALUES(1,?)').run(JSON.stringify(profile));
    this.store.db.prepare('INSERT OR REPLACE INTO host_choices(host_type,value) VALUES(?,?)').run(profile.hostType, JSON.stringify(profile));
    this.auth.record('saved', `${profile.hostType} 配置已保存${value.hostType === 'codex' ? '：' + (value.authMode || 'local') : ''}`);
    return this.snapshot();
    } finally { this.saving = false; }
  }
  // login 只为已保存的设备码模式授权，登录开始即使旧测试失效。
  login() {
    if (this.job || this.saving) throw new Error('请等待宿主测试或保存结束');
    if (this.auth.job) return this.auth.snapshot();
    const profile = this.profile();
    if (profile.hostType !== 'codex' || inspectCodex(this.runtime.dataDir).authMode !== 'device') throw new Error('请先保存 Codex 无头设备码登录模式');
    profile.revision = randomUUID();
    this.store.db.prepare('UPDATE host_profile SET value=? WHERE id=1').run(JSON.stringify(profile));
    this.store.db.prepare('INSERT OR REPLACE INTO host_choices(host_type,value) VALUES(?,?)').run(profile.hostType, JSON.stringify(profile));
    return this.auth.start();
  }
  // verified 只接受与当前保存配置完全一致且成功的真实调用记录。
  verified(id) {
    if (this.saving || this.auth.job) throw new Error('请等待宿主配置或登录结束');
    const record = this.test(id || ''), profile = this.profile();
    if (!record || record.status !== 'passed' || record.revision !== profile.revision) throw new Error('请先保存宿主配置并通过连通性测试');
    return profile;
  }
  // start 发起独立目录中的小额真实调用，立即返回可轮询的测试编号。
  start() {
    if (this.saving || this.auth.job) throw new Error('请等待宿主配置或登录结束');
    if (this.job) throw new Error('宿主测试正在进行');
    const profile = this.profile();
    if (!profile.revision) throw new Error('请先保存宿主配置');
    const id = randomUUID(), token = `GOALHUB_OK_${id}`;
    const input = `这是宿主连通性测试。不要读取、创建或修改文件，不要使用工具。请仅回复：${token}`;
    this.store.db.prepare('INSERT INTO host_tests(id,revision,host_type,model,status,input,created_at) VALUES(?,?,?,?,?,?,?)').run(id, profile.revision, profile.hostType, profile.model, 'running', input, new Date().toISOString());
    const job = { handle: null, cancelled: false }; this.job = job;
    job.promise = this.run(job, id, profile, input, token).finally(() => { this.job = null; });
    return this.test(id);
  }
  // run 捕获流输出、退出码和模型回复；超时或协议不符均判为失败。
  async run(job, id, profile, input, token) {
    let timer, timedOut = false, output = '';
    // append 对每次输出先脱敏再持久化，刷新页面不会丢失测试进度。
    const append = (text) => { output = (output + redact(text) + '\n').slice(-200000); this.store.db.prepare('UPDATE host_tests SET output=? WHERE id=?').run(output, id); };
    try {
      const cwd = join(this.runtime.dataDir, 'host-probes', id); await mkdir(cwd, { recursive: true });
      job.handle = await this.runtime.host({ ...profile, cwd, input, onEvent: (kind, text) => append(`${kind}: ${text}`), onSession() {} });
      if (job.cancelled) job.handle.stop();
      timer = setTimeout(() => { timedOut = true; job.handle.stop(); }, 120000);
      const result = await job.handle.done;
      append(result.finalMessage || result.error || '无最终回复');
      if (job.cancelled || timedOut || result.code !== 0 || result.error || result.finalMessage?.trim() !== token) throw new Error(job.cancelled ? '测试已停止' : timedOut ? '测试超过 120 秒，已停止' : result.error || '宿主退出异常或回复未通过连通性校验');
      this.store.db.prepare("UPDATE host_tests SET status='passed',finished_at=? WHERE id=?").run(new Date().toISOString(), id);
    } catch (error) { append(error.message); this.store.db.prepare("UPDATE host_tests SET status='failed',finished_at=? WHERE id=?").run(new Date().toISOString(), id); }
    finally { clearTimeout(timer); }
  }
  // close 等待探测进程退出后才允许关闭数据库。
  async close() { await this.auth.close(); if (this.job) { this.job.cancelled = true; this.job.handle?.stop(); await this.job.promise; } }
}

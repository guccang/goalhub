// 本文件构建持久化交付快照，管理本机 Web 预览和经校验的安装包下载。
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, copyFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, relative, isAbsolute, basename, extname } from 'node:path';
import { createServer } from 'node:net';
import { redact } from './store.mjs';
import { assignEmployee, executionTimeoutMs } from './employees.mjs';

export const deliveryInstruction = `交付也是完成条件：在仓库根目录创建 goalhub.delivery.json，并将构建和交付验证列入任务。
Web 格式：{"kind":"web","build":"安装依赖并构建的命令","preview":"绑定 127.0.0.1 且使用 {port} 的启动命令","port":4173,"instructions":"如何使用"}。
桌面或 App 格式：{"kind":"desktop|android|ios","build":"真实打包命令","verify":"验证产物可安装或启动的命令","artifacts":["仓库相对安装包路径"],"instructions":"目标操作系统、安装启动方法、签名或设备限制"}。
Android 必须提供 APK，iOS 提供已签名 IPA，桌面提供目标系统可用的安装包或便携包。不得生成占位文件或仅声称构建完成。构建在独立干净源码快照执行，必须自行安装依赖。缺少外部凭据或必须由用户提供的签名时请求用户输入；可从当前环境发现或修复的问题先自行处理。
只有确实无需运行界面的库、脚本或文档项目才可用 {"kind":"source","instructions":"无需安装包的理由和具体使用方法"}；不得用 source 规避 Web 或 App 交付。仅 settings.delivery 中真实保存的人工设置优先于文件；历史 release.config 是上次构建快照，不是当前覆盖设置。员工只维护仓库配置与代码，平台负责构建、预览端口和发布；不要访问、修改 GoalHub 管理接口，也不要询问用户 GoalHub 地址。构建验证遇到端口占用时平台会自动换用空闲端口，无需为此修改源码或请求用户确认。`;

// deliveryRepairInstruction 让执行与二次确认共用交付修复要求，预览不改变人工配置。
export function deliveryRepairInstruction(project) { return `用户要求项目员工准备可使用的预览或安装包。检查真实项目结构、当前环境和已有交付失败日志，自行确定并实现启动、构建及验证方式，补齐或修复交付文件与所需脚本，不要求用户填写技术命令。保留已完成的业务功能；此前“仅创建指定文件”“不启动开发服务器”等范围限制不适用于本次必要的交付工作。Web 必须真实启动并验证页面，桌面或 App 必须生成并验证真实安装产物。仅在缺少凭据、SDK 或必要产品决策时请求用户输入。此前人工交付设置（本次已转交员工维护，不再覆盖文件；保留目标平台和端口意图，修正失效命令）：${JSON.stringify(project.settings.delivery || null)}。${deliveryInstruction}`; }

// validateDelivery 对命令、端口与相对产物路径做边界校验，不接受任意下载路径。
export function validateDelivery(value) {
  if (!value || !['web', 'desktop', 'android', 'ios', 'source'].includes(value.kind)) throw new Error('请选择有效交付类型');
  const result = { kind: value.kind };
  for (const key of ['build', 'verify', 'preview', 'instructions']) {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > 8000 || text.includes('\0')) throw new Error(`交付 ${key} 无效`);
    result[key] = text.trim();
  }
  if (!result.instructions) throw new Error('请提供交付使用说明');
  if (value.kind !== 'source' && !result.build) throw new Error('请提供真实构建命令');
  result.port = value.port ?? 4173;
  if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error('预览端口应为 1024–65535');
  if (value.kind === 'web' && (!result.preview.includes('{port}') || !result.preview.includes('127.0.0.1'))) throw new Error('预览命令必须绑定 127.0.0.1，并用 {port} 指定端口');
  result.artifacts = value.artifacts ?? [];
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 20) throw new Error('安装包路径最多 20 个');
  const extensions = { android: ['.apk'], ios: ['.ipa'], desktop: ['.exe', '.msi', '.msix', '.dmg', '.pkg', '.zip', '.deb', '.rpm', '.appimage'] };
  if (extensions[value.kind] && (!result.verify || !result.artifacts.length)) throw new Error('安装交付需要验证命令和安装包路径');
  for (const path of result.artifacts) {
    if (typeof path !== 'string' || !path || path.length > 1000 || isAbsolute(path) || /[:\0]/.test(path) || path.split(/[\\/]/).some(p => p === '..' || p === '.git' || p.startsWith('.env'))) throw new Error('安装包必须使用仓库内的相对文件路径');
    if (extensions[value.kind] && ![...extensions[value.kind], '.json'].includes(extname(path).toLowerCase())) throw new Error(`交付产物格式与目标平台不符：${path}`);
  }
  // JSON 清单只能随真实安装包交付，不能单独冒充可安装产物。
  if (extensions[value.kind] && !result.artifacts.some(path => extensions[value.kind].includes(extname(path).toLowerCase()))) throw new Error('安装交付至少需要一个目标平台安装包，JSON 清单不能代替安装包');
  return result;
}

// contained 解析真实路径，拒绝符号链接或目录穿越将仓库外文件作为交付物。
async function contained(root, path) {
  const base = await realpath(root), file = await realpath(resolve(base, path)), sub = relative(base, file);
  if (!sub || sub.startsWith('..') || isAbsolute(sub)) throw new Error('交付文件超出允许目录');
  return file;
}

// freePort 探测本机端口；传入 0 时由系统选择空闲端口，不结束用户已有服务。
async function freePort(port) {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', error => reject(Object.assign(new Error(`端口 ${port} 无法使用：${error.code}`), { code: error.code })));
    server.listen(port, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
}

export class DeliveryManager {
  // constructor 恢复交付元数据，重启后的未知进程不会被错误显示为可用。
  constructor({ store, runtime, git, readyTimeoutMs, buildTimeoutMs }) {
    Object.assign(this, { store, runtime, git }); this.jobs = new Map(); this.previews = new Map();
    // 仅测试可注入短时限；生产执行从负责员工读取，不设隐藏的构建或启动上限。
    this.readyTimeoutMs = readyTimeoutMs; this.buildTimeoutMs = buildTimeoutMs;
    store.db.exec(`CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal_id TEXT NOT NULL,
      commit_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', directory TEXT NOT NULL DEFAULT '', files TEXT NOT NULL DEFAULT '[]',
      log TEXT NOT NULL DEFAULT '', preview_status TEXT NOT NULL DEFAULT 'stopped', port INTEGER, process_id INTEGER, created_at TEXT NOT NULL);
      UPDATE deliveries SET status='failed',log=log||'\n服务重启，构建已中断。' WHERE status='building';
      UPDATE deliveries SET preview_status='interrupted' WHERE preview_status IN ('starting','running');`);
    if (!store.db.prepare('PRAGMA table_info(deliveries)').all().some(column => column.name === 'executor')) store.db.exec("ALTER TABLE deliveries ADD COLUMN executor TEXT NOT NULL DEFAULT '{}'");
  }
  // row 使用固定编号获取不可变交付记录。
  row(id) { return this.store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); }
  // update 只供内部更新明确的交付字段。
  update(id, values) { this.store.db.prepare(`UPDATE deliveries SET ${Object.keys(values).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(values), id); }
  // log 保留有限长度、脱敏的真实构建和预览输出。
  log(id, message) { const row = this.row(id); this.update(id, { log: (row.log + '\n' + redact(message)).slice(-64000) }); }
  // snapshot 只向客户端返回下载编号与状态，预览 URL 固定为回环地址。
  snapshot(projectId, goalId = this.store.project(projectId)?.active_goal_id) {
    const row = this.store.db.prepare('SELECT * FROM deliveries WHERE project_id=? AND goal_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, goalId || '');
    const saved = this.store.project(projectId)?.settings.delivery || null;
    if (!row) return { release: null, config: saved, configSource: saved ? 'saved' : 'repository', building: this.jobs.has(projectId) };
    return { config: saved, configSource: saved ? 'saved' : 'repository', building: this.jobs.has(projectId), release: { id: row.id, config: JSON.parse(row.config), status: row.status, kind: JSON.parse(row.config).kind, commit: row.commit_hash, instructions: JSON.parse(row.config).instructions || '', log: row.log,
      preview: row.preview_status, port: row.port, url: row.preview_status === 'running' ? `http://127.0.0.1:${row.port}` : null,
      files: JSON.parse(row.files).map((f, i) => ({ name: f.name, size: f.size, sha256: f.sha256, url: `/api/deliveries/${row.id}/files/${i}` })) } };
  }
  // prepare 为本目标创建一次受管构建任务，暂停项目时可停止全部构建子进程。
  prepare(projectId, source, control = { cancelled: false, handles: new Set() }) {
    if (this.jobs.has(projectId)) throw new Error('此项目正在构建交付');
    const job = { control };
    this.jobs.set(projectId, job);
    job.promise = this.build(projectId, source, control).finally(() => this.jobs.delete(projectId));
    return job.promise;
  }
  // build 从已提交代码复制独立仓库，构建产物和运行依赖不会随开发 worktree 清理。
  async build(projectId, source, control) {
    const project = this.store.project(projectId), id = randomUUID();
    this.store.db.prepare('INSERT INTO deliveries(id,project_id,goal_id,status,created_at) VALUES(?,?,?,?,?)').run(id, projectId, project.active_goal_id, 'building', new Date().toISOString());
    try {
      const employee = assignEmployee(this.store, project, 'final-review');
      executionTimeoutMs(employee);
      this.update(id, { executor: JSON.stringify(employee) });
      this.log(id, `交付负责人：${employee.name}；每条构建、验证命令及预览启动时限：${employee.timeoutMinutes} 分钟；来源：员工配置`);
      let config = project.settings.delivery;
      if (!config) {
        // Windows PowerShell 写入的 UTF-8 文件可能含 BOM，只去除开头标记，不掩盖语法错误。
        try { config = JSON.parse((await readFile(await contained(source, 'goalhub.delivery.json'), 'utf8')).replace(/^\uFEFF/, '')); }
        catch (error) {
          if (error.code === 'ENOENT') throw new Error(`缺少有效的 goalhub.delivery.json：${join(source, 'goalhub.delivery.json')}`, { cause: error });
          throw new Error(`读取 goalhub.delivery.json 失败（${source}）：${error.message}`, { cause: error });
        }
      }
      config = validateDelivery(config); this.update(id, { config: JSON.stringify(config) });
      const commit = await this.git.command(projectId, source, ['rev-parse', 'HEAD']);
      this.update(id, { commit_hash: commit });
      if (control.cancelled) throw new Error('交付已取消');
      if (config.kind !== 'source') {
        const directory = join(this.runtime.dataDir, 'deliveries', id);
        await mkdir(directory, { recursive: true });
        const checkout = join(directory, 'source');
        this.update(id, { directory });
        await this.git.command(projectId, this.git.paths(projectId).repo, ['clone', '--no-hardlinks', '--no-checkout', this.git.paths(projectId).repo, checkout]);
        await this.git.command(projectId, checkout, ['checkout', '--detach', commit]);
        await this.run(id, config.build, checkout, control);
        if (config.verify) await this.run(id, config.verify, checkout, control);
        if (config.kind === 'web') {
          await this.startPreview(id, config.port, true, control);
          await this.stopPreview(id);
        } else {
          const files = [];
          await mkdir(join(directory, 'files'), { recursive: true });
          await contained(directory, 'source');
          for (const [index, path] of config.artifacts.entries()) {
            const file = await contained(checkout, path), info = await stat(file);
            if (!info.isFile() || !info.size) throw new Error(`安装包不存在或为空：${path}`);
            // 校验常见安装格式的文件头，拒绝用文本占位文件冒充二进制安装包。
            const signatures = { '.exe': '4d5a', '.apk': '504b0304', '.ipa': '504b0304', '.msix': '504b0304', '.zip': '504b0304', '.msi': 'd0cf11e0', '.appimage': '7f454c46', '.pkg': '78617221', '.deb': '213c6172', '.rpm': 'edabeedb' };
            const signature = signatures[extname(path).toLowerCase()];
            if (signature) {
              const handle = await open(file, 'r'), bytes = Buffer.alloc(4);
              try { await handle.read(bytes, 0, 4, 0); } finally { await handle.close(); }
              if (!bytes.toString('hex').startsWith(signature)) throw new Error(`安装包格式无效：${path}`);
            }
            const destination = join(directory, 'files', String(index));
            await copyFile(file, destination);
            const hash = createHash('sha256'); for await (const chunk of createReadStream(destination)) hash.update(chunk);
            files.push({ name: basename(path), size: info.size, sha256: hash.digest('hex') });
          }
          this.update(id, { files: JSON.stringify(files) });
        }
      }
      if (control.cancelled) throw new Error('交付已取消');
      this.update(id, { status: 'verified' }); this.log(id, '交付构建与验证通过，等待源码合并。');
      return id;
    } catch (error) { this.update(id, { status: 'failed' }); this.log(id, error.message); throw error; }
  }
  // executionPolicy 使用本次交付的员工快照；旧记录按所属目标恢复负责人，避免串用其他目标。
  executionPolicy(id) {
    const row = this.row(id);
    const saved = JSON.parse(row.executor || '{}');
    const project = this.store.forGoal(row.project_id, row.goal_id).project(row.project_id);
    const employee = saved.id ? saved : assignEmployee(this.store, project, 'final-review');
    return { employee, timeoutMs: executionTimeoutMs(employee) };
  }
  // run 执行真实构建或验证命令，退出码、超时和取消都影响完成判定。
  async run(id, command, cwd, control) {
    if (control.cancelled) throw new Error('交付已取消');
    const { employee, timeoutMs } = this.executionPolicy(id);
    this.log(id, '> ' + command);
    const handle = await this.runtime.command(command, cwd, (kind, line) => this.log(id, `${kind}: ${line}`));
    control.handles.add(handle);
    this.update(id, { process_id: handle.pid ?? null });
    let expired = false;
    const timer = setTimeout(() => { expired = true; handle.stop(); }, this.buildTimeoutMs ?? timeoutMs);
    try {
      if (control.cancelled) handle.stop();
      const result = await handle.done;
      if (control.cancelled || expired || result.code !== 0 || result.error) throw new Error(control.cancelled ? '交付已取消' : expired ? `构建超时（${employee.name}，员工时限 ${employee.timeoutMinutes} 分钟）` : result.error || `构建命令退出码 ${result.code}，请查看交付日志`);
    } finally { clearTimeout(timer); control.handles.delete(handle); this.update(id, { process_id: null }); }
  }
  // publish 仅在源码完成合并后开放安装包下载和用户预览。
  publish(id) { this.update(id, { status: 'ready' }); this.log(id, '交付已发布，可下载或启动预览。'); }
  // startPreview 固定回环 URL，等待真实 HTTP 成功响应后才标记可预览。
  async startPreview(id, port, verifying = false, control) {
    const row = this.row(id);
    if (!row || (!verifying && row.status !== 'ready')) throw new Error('交付尚未准备完成');
    const config = JSON.parse(row.config);
    if (config.kind !== 'web') throw new Error('此交付不是 Web 项目');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('预览端口应为 1024–65535');
    if (this.previews.has(id)) throw new Error('预览已启动或正在启动');
    const job = { cancelled: false, handle: null, done: null };
    job.starting = new Promise(resolve => { job.started = resolve; }); this.previews.set(id, job);
    this.update(id, { preview_status: 'starting', port });
    try {
      try { await freePort(port); }
      catch (error) {
        if (!verifying || error.code !== 'EADDRINUSE') throw error;
        const requested = port; port = await freePort(0);
        this.update(id, { port }); this.log(id, `验证端口 ${requested} 已占用，自动使用 ${port}；保留仓库与人工配置，不终止其他服务。`);
      }
      if (job.cancelled || control?.cancelled) throw new Error('预览已取消');
      const handle = await this.runtime.command(config.preview.replaceAll('{port}', String(port)), join(row.directory, 'source'), (kind, line) => this.log(id, `${kind}: ${line}`));
      job.handle = handle; control?.handles.add(handle);
      this.update(id, { process_id: handle.pid ?? null });
      job.done = handle.done.catch(error => ({ code: -1, error: error.message })).then(result => { job.exited = true; if (!job.cancelled) { this.update(id, { preview_status: 'failed', process_id: null }); this.log(id, `预览进程已退出：${result.error || result.code}`); } if (this.previews.get(id) === job) this.previews.delete(id); return result; });
      if (job.cancelled || control?.cancelled) handle.stop();
      const { employee, timeoutMs } = this.executionPolicy(id);
      this.log(id, `预览启动时限：${employee.timeoutMinutes} 分钟；来源：${employee.name} 的交付配置快照`);
      const deadline = Date.now() + (this.readyTimeoutMs ?? timeoutMs);
      while (Date.now() < deadline && !job.exited && !job.cancelled && !control?.cancelled) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200), redirect: 'manual' });
          await response.body?.cancel();
          if (response.status >= 200 && response.status < 400 && !job.exited && !job.cancelled && !control?.cancelled) { this.update(id, { preview_status: 'running' }); this.log(id, `HTTP ${response.status}：http://127.0.0.1:${port}/`); return; }
        } catch { /* 服务尚未就绪，继续有界探测。 */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('预览未就绪、进程退出或已取消，请查看日志');
    } catch (error) { await this.stopPreview(id, false); this.previews.delete(id); this.update(id, { preview_status: 'failed' }); this.log(id, error.message); throw error; }
    finally { if (job.handle) control?.handles.delete(job.handle); job.started(); }
  }
  // stopPreview 仅停止本服务持有的进程树，不处理端口上无关的程序。
  async stopPreview(id, waitStarting = true) {
    const job = this.previews.get(id);
    if (job) { job.cancelled = true; job.handle?.stop(); if (waitStarting) await job.starting; job.handle?.stop(); if (job.done) await job.done; if (this.previews.get(id) === job) this.previews.delete(id); }
    else if (this.row(id)?.process_id) {
      let alive = false; try { process.kill(this.row(id).process_id, 0); alive = true; } catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) throw new Error('上次服务的进程可能仍在运行，请在系统中确认并停止该进程后重试');
    }
    this.update(id, { preview_status: 'stopped', process_id: null });
  }
  // download 打开受管产物并返回文件句柄，HTTP 层不接受客户端文件路径。
  async download(id, index) {
    const row = this.row(id), file = row && JSON.parse(row.files)[index];
    if (!row || row.status !== 'ready' || !file) throw new Error('安装包不存在或尚未发布');
    const expected = join(await realpath(this.runtime.dataDir), 'deliveries', id, 'files', String(index)), path = await realpath(expected);
    const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (canonical(path) !== canonical(expected)) throw new Error('下载路径被重定向，拒绝读取');
    const handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size !== file.size) { await handle.close(); throw new Error('交付文件已损坏，请重新构建'); }
    const hash = createHash('sha256');
    try { for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk); }
    catch (error) { await handle.close(); throw error; }
    if (hash.digest('hex') !== file.sha256) { await handle.close(); throw new Error('交付文件校验失败，请重新构建'); }
    return { handle, ...file };
  }
  // close 先停止所有预览和构建，再允许数据库关闭。
  async close() {
    for (const job of this.jobs.values()) { job.control.cancelled = true; for (const handle of job.control.handles) handle.stop(); }
    await Promise.all([...this.previews.keys()].map(id => this.stopPreview(id)));
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}

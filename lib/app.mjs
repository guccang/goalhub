// 本文件提供仅本机访问的 HTTP API 与静态工作台，业务动作交由调度器处理。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOfficeSnapshot } from './office.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const hosts = ['codex', 'claudecode', 'deepseek-harness', 'opencode'];

// json 统一返回 JSON 并禁止缓存业务状态。
function json(response, code, value) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

// body 读取有大小限制的 JSON，禁止浏览器表单跨站触发写入。
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 application/json');
  let content = '';
  for await (const chunk of request) {
    content += chunk;
    if (Buffer.byteLength(content) > 128 * 1024) throw new Error('请求内容超过 128 KB');
  }
  const parsed = JSON.parse(content || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求必须为 JSON 对象');
  return parsed;
}

// field 校验用户输入的文本。
function field(value, name, max, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}需要 1–${max} 个字符`);
  return value.trim();
}

// number 校验运行参数的数值区间。
function number(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name}应在 ${min}–${max} 之间`);
  return result;
}

// createApp 创建服务，固定静态文件映射并检查浏览器请求来源。
export function createApp({ store, orchestrator, git, runtime }) {
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const expectedPort = request.socket.localPort;
      const allowed = [`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`];
      if (!allowed.includes(request.headers.host) || (request.headers.origin && !allowed.map((host) => `http://${host}`).includes(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        return json(response, 403, { error: '仅允许本机同源请求' });
      }
      const url = new URL(request.url, `http://${request.headers.host}`), path = url.pathname;
      if (request.method === 'GET' && path === '/api/status') return json(response, 200, { runtime: runtime.status(), activeProjects: [...orchestrator.controls.keys()], node: process.version });
      if (path === '/api/projects' && request.method === 'GET') return json(response, 200, store.list());
      if (path === '/api/projects' && request.method === 'POST') {
        const value = await body(request), settings = value.settings || {};
        if (!hosts.includes(settings.hostType || 'codex')) throw new Error('不支持的 Agent 宿主');
        const project = store.create({ name: field(value.name, '项目名称', 100), goal: field(value.goal, '目标', 30000), settings: {
          hostType: settings.hostType || 'codex', model: field(settings.model, '模型', 150, true),
          evaluationMinutes: number(settings.evaluationMinutes, 5, 0.1, 1440, '评估间隔（分钟）'),
          agentTimeoutMinutes: number(settings.agentTimeoutMinutes, 30, 1, 240, '单轮时限（分钟）'),
          testTimeoutSeconds: number(settings.testTimeoutSeconds, 120, 5, 3600, '测试时限（秒）'),
        } });
        if (value.autoStart !== false) orchestrator.start(project.id);
        return json(response, 201, store.detail(project.id));
      }
      const match = path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(start|pause|answer|evaluate|events|office|steer))?$/);
      if (match) {
        const [, id, action] = match;
        if (!store.project(id)) return json(response, 404, { error: '项目不存在' });
        if (request.method === 'GET' && !action) return json(response, 200, { ...store.detail(id), paths: git.paths(id), active: orchestrator.controls.has(id), office: buildOfficeSnapshot(store, orchestrator, id) });
        if (request.method === 'GET' && action === 'office') return json(response, 200, buildOfficeSnapshot(store, orchestrator, id));
        if (request.method === 'GET' && action === 'events') return json(response, 200, store.events(id, {
          after: number(url.searchParams.get('after') ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, '游标'),
          before: number(url.searchParams.get('before') ?? undefined, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, '游标'),
          limit: Math.floor(number(url.searchParams.get('limit') ?? undefined, 100, 1, 500, '记录数量')),
          search: url.searchParams.get('search') || '', kind: url.searchParams.get('kind') || '',
        }));
        if (request.method === 'POST' && action) {
          const value = await body(request);
          if (action === 'start') orchestrator.start(id);
          else if (action === 'pause') await orchestrator.pause(id);
          else if (action === 'evaluate') orchestrator.evaluateNow(id);
          else if (action === 'steer') await orchestrator.steer(id, field(value.content, '补充指令', 10000));
          else if (action === 'answer') {
            if (orchestrator.controls.has(id)) throw new Error('当前轮次尚未退出，请稍后提交');
            const pending = store.questions(id).filter((question) => question.answer === null);
            if (!pending.length || !Array.isArray(value.answers) || value.answers.length !== pending.length) throw new Error('请回答全部待处理问题');
            const answers = pending.map((question) => ({ id: question.id, answer: field(value.answers.find((answer) => answer.id === question.id)?.answer, '回答', 10000) }));
            for (const answer of answers) {
              store.answer(id, answer.id, answer.answer);
              store.event(id, 'input.answer', `${pending.find((question) => question.id === answer.id).prompt}\n回答：${answer.answer}`);
            }
            orchestrator.start(id);
          } else return json(response, 405, { error: '不支持此操作' });
          return json(response, 200, store.detail(id));
        }
      }
      const run = path.match(/^\/api\/runs\/([a-f0-9-]{36})$/);
      if (request.method === 'GET' && run) {
        const value = store.run(run[1]);
        return json(response, value ? 200 : 404, value || { error: '记录不存在' });
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/office-view.js': ['office-view.js', 'text/javascript'], '/office-scene.js': ['office-scene.js', 'text/javascript'], '/office.css': ['office.css', 'text/css'],
        '/vendor/munder-difflin/portrait-art.js': ['vendor/munder-difflin/portrait-art.js', 'text/javascript'],
        '/office-license.txt': ['vendor/munder-difflin/LICENSE.txt', 'text/plain'] };
      if (request.method === 'GET' && Object.hasOwn(files, path)) {
        const [name, type] = files[path];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return response.end(await readFile(join(publicDir, name)));
      }
      json(response, 404, { error: '页面或接口不存在' });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });
}

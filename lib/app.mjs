// 本文件提供仅本机访问的 HTTP API 与静态工作台，业务动作交由调度器处理。
import { languages, validateLanguage } from './languages.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostSetup } from './host-setup.mjs';
import { inspectCodex } from './host-auth.mjs';
import { team, validateTeam, duties, characters } from './employees.mjs';
import { buildOfficeSnapshot } from './office.mjs';
import { validatePlan } from './protocol.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
// 从构建目录生成静态白名单，禁止通过路径穿越读取源码或凭据。
const engineFiles = Object.fromEntries(readdirSync(join(publicDir, 'office-engine'), { recursive: true }).map(name => String(name).replaceAll('\\', '/')).filter(name => /\.(js|png|txt)$/.test(name)).map(name => [`/office-engine/${name}`, [`office-engine/${name}`, name.endsWith('.png') ? 'image/png' : name.endsWith('.js') ? 'text/javascript' : 'text/plain']]));
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
  const hostSetup = new HostSetup(store, runtime);
  const server = createServer(async (request, response) => {
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
      if (path === '/api/host/models' && request.method === 'GET') {
        if (hostSetup.saving || hostSetup.auth.job) throw new Error('请等待配置保存或登录结束，再刷新模型');
        return json(response, 200, await runtime.models(url.searchParams.get('type') || 'codex'));
      }
      if (path === '/api/host' && request.method === 'GET') return json(response, 200, await hostSetup.snapshot());
      if (path === '/api/host/credentials' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!hosts.includes(type)) throw new Error('不支持的宿主');
        const module = await runtime.load();
        return json(response, 200, type === 'codex' ? inspectCodex(runtime.dataDir) : module.inspectHostSettings(runtime.dataDir, type));
      }
      if (path === '/api/host' && request.method === 'POST') {
        const value = await body(request);
        if (!hosts.includes(value.hostType)) throw new Error('不支持的宿主');
        if (orchestrator.controls.size) throw new Error('请先暂停正在运行的项目再修改宿主配置');
        value.model = field(value.model, '模型', 150, true);
        return json(response, 200, await hostSetup.save(value));
      }
      if (path === '/api/host/test' && request.method === 'POST') { await body(request); return json(response, 202, hostSetup.start()); }
      if (path === '/api/host/login' && request.method === 'POST') {
        await body(request);
        if (orchestrator.controls.size) throw new Error('请先暂停正在运行的项目再登录');
        return json(response, 202, hostSetup.login());
      }
      if (path === '/api/host/login/cancel' && request.method === 'POST') { await body(request); return json(response, 200, hostSetup.auth.cancel()); }
      if (path === '/api/usage' && request.method === 'GET') return json(response, 200, store.usage());
      if (path === '/api/projects/register' && request.method === 'POST') {
        const value = await body(request);
        const name = field(value.name, '项目名称', 100);
        const registration = await git.registration(field(value.path, '项目目录', 2000, true), value.mode === 'new' ? 'new' : 'existing');
        const project = store.create({ name, ...registration, settings: { hostType: 'codex', model: '', confirmationMode: 'manual', evaluationMinutes: 5, agentTimeoutMinutes: 30, testTimeoutSeconds: 120 } });
        return json(response, 201, store.detail(project.id));
      }
      const goalsRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/(goals|sessions-reset|plan)(?:\/([a-f0-9-]{36}))?$/);
      if (goalsRoute) {
        const [, id, operation, goalId] = goalsRoute;
        const project = store.project(id);
        if (!project) return json(response, 404, { error: '项目不存在' });
        if (request.method === 'GET' && operation === 'goals') {
          let detail = goalId ? store.detail(id, goalId) : store.goals(id);
          if (detail && goalId) detail = { ...detail, paths: git.paths(id), active: !detail.historical && orchestrator.controls.has(id), ...(!detail.historical ? { office: buildOfficeSnapshot(store, orchestrator, id) } : {}) };
          return json(response, detail ? 200 : 404, detail || { error: '目标不存在' });
        }
        if (request.method === 'POST' && !goalId) {
          const value = await body(request);
          if (orchestrator.controls.has(id)) throw new Error('请等待当前轮次停止后再操作');
          if (operation === 'goals') {
            const profile = hostSetup.verified(value.hostTestId), settings = value.settings || {};
            if (!['manual', 'auto'].includes(settings.confirmationMode || 'manual')) throw new Error('确认方式无效');
            store.createGoal(id, { title: field(value.title, '目标标题', 100, true), goal: field(value.goal, '目标', 30000), settings: {
              ...project.settings, hostType: profile.hostType, model: profile.model, reasoningEffort: profile.reasoningEffort || '', hostTestId: value.hostTestId,
              language: validateLanguage(settings.language ?? project.settings.language ?? 'zh-CN'), confirmationMode: settings.confirmationMode || 'manual',
              evaluationMinutes: number(settings.evaluationMinutes, 5, 0.1, 1440, '评估间隔'),
              agentTimeoutMinutes: number(settings.agentTimeoutMinutes, 30, 1, 240, 'Agent 时限'),
              testTimeoutSeconds: number(settings.testTimeoutSeconds, 120, 5, 3600, '测试时限')
            } });
            if (value.autoStart !== false) orchestrator.start(id);
          } else if (operation === 'sessions-reset') store.resetSessions(id);
          else {
            if (project.status !== 'awaiting_approval') throw new Error('仅等待确认的计划可以编辑');
            const plan = validatePlan(JSON.stringify(value));
            if (plan.needsInput) throw new Error('请提交完整计划');
            store.plan(id, plan); store.event(id, 'plan.edited', '用户调整计划，等待确认');
          }
          return json(response, 200, store.detail(id));
        }
      }
      if (path === '/api/projects' && request.method === 'GET') return json(response, 200, store.list());
      if (path === '/api/projects' && request.method === 'POST') {
        const value = await body(request), settings = value.settings || {};
        const profile = hostSetup.verified(value.hostTestId);
        if (!['manual', 'auto'].includes(settings.confirmationMode || 'manual')) throw new Error('确认方式无效');
        if (!hosts.includes(settings.hostType || 'codex')) throw new Error('不支持的 Agent 宿主');
        const project = store.create({ name: field(value.name, '项目名称', 100), goal: field(value.goal, '目标', 30000), settings: {
          language: validateLanguage(settings.language ?? 'zh-CN'), hostType: profile.hostType, model: profile.model, reasoningEffort: profile.reasoningEffort || '', hostTestId: value.hostTestId, confirmationMode: settings.confirmationMode || 'manual',
          evaluationMinutes: number(settings.evaluationMinutes, 5, 0.1, 1440, '评估间隔（分钟）'),
          agentTimeoutMinutes: number(settings.agentTimeoutMinutes, 30, 1, 240, '单轮时限（分钟）'),
          testTimeoutSeconds: number(settings.testTimeoutSeconds, 120, 5, 3600, '测试时限（秒）'),
        } });
        if (value.autoStart !== false) orchestrator.start(project.id);
        return json(response, 201, store.detail(project.id));
      }
      const match = path.match(/^\/api\/projects\/([a-f0-9-]{36})(?:\/(start|approve|pause|answer|evaluate|events|office|steer|employees))?$/);
      if (match) {
        const [, id, action] = match;
        if (!store.project(id)) return json(response, 404, { error: '项目不存在' });
        if (action === 'employees') {
          if (request.method === 'GET') return json(response, 200, { employees: team(store.project(id)), duties, characters, languages, language: store.project(id).settings.language || 'zh-CN' });
          if (request.method === 'POST') {
            const value = await body(request);
            if (orchestrator.controls.has(id) || orchestrator.steering.has(id)) throw new Error('请先暂停项目，等待当前轮次退出后再修改团队');
            store.saveEmployees(id, validateTeam(value.employees), value.language === undefined ? undefined : validateLanguage(value.language));
            return json(response, 200, { employees: team(store.project(id)) });
          }
        }
        if (request.method === 'GET' && !action) return json(response, 200, { ...store.detail(id), paths: git.paths(id), active: orchestrator.controls.has(id), office: buildOfficeSnapshot(store, orchestrator, id) });
        if (request.method === 'GET' && action === 'office') return json(response, 200, buildOfficeSnapshot(store, orchestrator, id));
        if (request.method === 'GET' && action === 'events') return json(response, 200, store.events(id, {
          after: number(url.searchParams.get('after') ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, '游标'),
          before: number(url.searchParams.get('before') ?? undefined, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, '游标'),
          limit: Math.floor(number(url.searchParams.get('limit') ?? undefined, 100, 1, 500, '记录数量')),
          goalId: url.searchParams.get('goal') || undefined, search: url.searchParams.get('search') || '', kind: url.searchParams.get('kind') || '',
        }));
        if (request.method === 'POST' && action) {
          const value = await body(request);
          if (action === 'start') orchestrator.start(id);
          else if (action === 'approve') orchestrator.approve(id);
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
      const files = { ...engineFiles, '/fonts/HYQiHei_75S.ttf': ['fonts/HYQiHei_75S.ttf', 'font/ttf'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/model-picker.js': ['model-picker.js', 'text/javascript'], '/employees.js': ['employees.js', 'text/javascript'],
        '/projects.js': ['projects.js', 'text/javascript'], '/projects.css': ['projects.css', 'text/css'], '/setup.js': ['setup.js', 'text/javascript'], '/setup.css': ['setup.css', 'text/css'], '/office-view.js': ['office-view.js', 'text/javascript'], '/office-scene.js': ['office-scene.js', 'text/javascript'], '/office.css': ['office.css', 'text/css'],
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
  server.hostSetup = hostSetup;
  return server;
}

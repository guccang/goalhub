// 本文件提供仅本机访问的 HTTP API 与静态工作台，业务动作交由调度器处理。
import { previewPrompts } from './prompt-preview.mjs';
import { languages, validateLanguage } from './languages.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostSetup } from './host-setup.mjs';
import { TeamBuilder } from './team-builder.mjs';
import { inspectCodex } from './host-auth.mjs';
import { team, validateTeam, characterNames, characters, validateAssignments } from './employees.mjs';
import { buildOfficeSnapshot } from './office.mjs';
import { validatePlan } from './protocol.mjs';
import { validateDelivery } from './delivery.mjs';
import { pipeline } from 'node:stream/promises';

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

// homeOfficeSnapshot 总览只传递场景所需状态，不重复发送员工日志与完整输出。
function homeOfficeSnapshot(store, orchestrator, id) {
  const snapshot = buildOfficeSnapshot(store, orchestrator, id);
  return { projectId: id, status: snapshot.status, messages: snapshot.messages, actors: snapshot.actors.map(({ events, recentOutput, run, instructions, ...actor }) => actor) };
}

// createApp 创建服务，固定静态文件映射并检查浏览器请求来源。
export function createApp({ store, orchestrator, git, runtime }) {
  const hostSetup = new HostSetup(store, runtime);
  const teamBuilder = new TeamBuilder({ store, runtime, orchestrator, hostSetup });
  orchestrator.teamBuilder = teamBuilder;
  const delivery = orchestrator.delivery;
  // projectDetail 同时返回目标执行状态和项目队列，查看目标不会切换后台执行状态。
  const projectDetail = (id, goalId) => {
    if (!orchestrator.engine) return { ...store.detail(id, goalId), delivery: delivery.snapshot(id, goalId), paths: git.paths(id), active: orchestrator.controls.has(id), office: buildOfficeSnapshot(store, orchestrator, id) };
    const engine = orchestrator.engine(id, goalId), detail = engine.store.detail(id);
    return { ...detail, historical: detail.status === 'completed' && detail.active_goal_id !== store.project(id).active_goal_id, delivery: delivery.snapshot(id, detail.active_goal_id), paths: engine.git.paths(id), active: orchestrator.isGoalActive(id, detail.active_goal_id), projectActive: orchestrator.controls.has(id), queue: orchestrator.state(id), office: buildOfficeSnapshot(store, orchestrator, id) };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    // 仅办公室卡片允许同源嵌入，其余页面继续禁止嵌套。
    const frameAncestor = request.url?.split('?')[0] === '/office-card.html' ? "'self'" : "'none'";
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${frameAncestor}; base-uri 'none'; form-action 'self'`);
    try {
      const expectedPort = request.socket.localPort;
      const allowed = [`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`];
      if (!allowed.includes(request.headers.host) || (request.headers.origin && !allowed.map((host) => `http://${host}`).includes(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        return json(response, 403, { error: '仅允许本机同源请求' });
      }
      const url = new URL(request.url, `http://${request.headers.host}`), path = url.pathname;
      const download = path.match(/^\/api\/deliveries\/([a-f0-9-]{36})\/files\/(\d+)$/);
      if (download && request.method === 'GET') {
        const file = await delivery.download(download[1], Number(download[2]));
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'no-store' });
        await pipeline(file.handle.createReadStream({ start: 0 }), response); return;
      }
      const preview = path.match(/^\/api\/deliveries\/([a-f0-9-]{36})\/preview\/(start|stop)$/);
      if (preview && request.method === 'POST') {
        const value = await body(request), row = delivery.row(preview[1]);
        if (!row || row.status !== 'ready') throw new Error('交付不存在或尚未发布');
        if (preview[2] === 'start') await delivery.startPreview(row.id, value.port ?? JSON.parse(row.config).port);
        else await delivery.stopPreview(row.id);
        return json(response, 200, delivery.snapshot(row.project_id, row.goal_id));
      }
      const deliveryRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/delivery(?:\/(config|build|cancel))?$/);
      if (deliveryRoute) {
        const [, id, operation] = deliveryRoute, project = store.project(id);
        if (!project) throw new Error('项目不存在');
        if (request.method === 'GET') return json(response, 200, delivery.snapshot(id, url.searchParams.get('goal') || undefined));
        if (request.method === 'POST') {
          const value = await body(request);
          if (operation === 'cancel') {
            const job = delivery.jobs.get(id);
            if (orchestrator.controls.has(id)) throw new Error('请通过暂停项目停止自动交付');
            if (job) { job.control.cancelled = true; for (const handle of job.control.handles) handle.stop(); }
          } else {
            if (orchestrator.controls.has(id) || orchestrator.steering.has(id) || delivery.jobs.has(id) || teamBuilder.jobs.has(id)) throw new Error('请等待当前项目操作完成');
            if (operation === 'config') {
              const config = value.useFile ? undefined : validateDelivery(value);
              store.saveDelivery(id, config);
              store.event(id, 'delivery.configured', value.useFile ? '使用仓库交付配置' : JSON.stringify(config));
            } else if (operation === 'build') {
              orchestrator.start(id, { deliveryRepair: true });
            } else throw new Error('不支持的交付操作');
          }
          return json(response, 202, delivery.snapshot(id));
        }
      }
      if (path === '/api/host/prompt-preview' && request.method === 'POST') {
        const value = await body(request);
        const profile = hostSetup.profile();
        if (value.reasoningEffort !== undefined) {
          if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.reasoningEffort)) throw new Error('思考强度无效');
          profile.reasoningEffort = value.reasoningEffort;
        }
        return json(response, 200, { note: '不会调用模型。校验码将在实际测试时随机生成；测试使用保存后的宿主配置。', entries: [{ title: '宿主连通性测试', input: hostSetup.prompt(profile) }] });
      }
      const previewRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/prompt-preview$/);
      if (previewRoute && request.method === 'POST') {
        const value = await body(request), id = previewRoute[1];
        const engine = orchestrator.engine && value.goalId ? orchestrator.engine(id, value.goalId) : orchestrator;
        return json(response, 200, previewPrompts({ store: engine.store || store, orchestrator: engine, teamBuilder }, id, value));
      }
      if (path === '/api/god' && request.method === 'GET') return json(response, 200, teamBuilder.god.snapshot(teamBuilder.jobs.size > 0));
      if (path === '/api/god' && request.method === 'POST') {
        const value = await body(request);
        if (teamBuilder.jobs.size) throw new Error('God 正在搭建团队，请等待生成结束后再修改管理者配置');
        teamBuilder.god.save(value);
        return json(response, 200, teamBuilder.god.snapshot());
      }
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
        if (orchestrator.controls.size || teamBuilder.jobs.size) throw new Error('请先暂停正在运行的项目再修改宿主配置');
        value.model = field(value.model, '模型', 150, true);
        return json(response, 200, await hostSetup.save(value));
      }
      if (path === '/api/host/test' && request.method === 'POST') { await body(request); return json(response, 202, hostSetup.start()); }
      if (path === '/api/host/login' && request.method === 'POST') {
        await body(request);
        if (orchestrator.controls.size || teamBuilder.jobs.size) throw new Error('请先暂停正在运行的项目再登录');
        return json(response, 202, hostSetup.login());
      }
      if (path === '/api/host/login/cancel' && request.method === 'POST') { await body(request); return json(response, 200, hostSetup.auth.cancel()); }
      if (path === '/api/usage' && request.method === 'GET') return json(response, 200, store.usage());
      if (path === '/api/projects/register' && request.method === 'POST') {
        const value = await body(request);
        const name = field(value.name, '项目名称', 100);
        const registration = await git.registration(field(value.path, '项目目录', 2000, true), value.mode === 'new' ? 'new' : 'existing');
        const profile = hostSetup.profile();
        const project = store.create({ name, ...registration, settings: { employees: [], context: field(value.context, '项目上下文', 20000, true), hostType: profile.hostType, model: profile.model, reasoningEffort: profile.reasoningEffort || '', confirmationMode: 'auto', evaluationMinutes: 5, agentTimeoutMinutes: 30, testTimeoutSeconds: 120 } });
        return json(response, 201, store.detail(project.id));
      }
      const generationRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/team-generation(\/cancel)?$/);
      if (generationRoute) {
        const [, id, cancel] = generationRoute;
        if (!store.project(id)) throw new Error('项目不存在');
        if (request.method === 'GET' && !cancel) return json(response, 200, teamBuilder.latest(id));
        if (request.method === 'POST') {
          const value = await body(request);
          return json(response, 202, cancel ? teamBuilder.cancel(id) : teamBuilder.start(id, value));
        }
      }
      // 展示偏好允许在执行期间调整，与团队和交付写入互不干扰。
      const displayRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/display$/);
      if (displayRoute && request.method === 'POST') {
        return json(response, 200, store.setOfficeVisibility(displayRoute[1], (await body(request)).showOfficeOnHome));
      }
      const confirmationRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/confirmation-mode$/);
      if (confirmationRoute && request.method === 'POST') {
        const value = await body(request), id = confirmationRoute[1];
        if (!orchestrator.setConfirmationMode) throw new Error('当前调度器不支持切换确认方式');
        orchestrator.setConfirmationMode(id, value.mode);
        return json(response, 200, projectDetail(id));
      }
      const mutation = path.match(/^\/api\/projects\/([a-f0-9-]{36})\//);
      if (request.method === 'POST' && mutation && !(orchestrator.engine && /\/(goals|pause|start|approve|answer|steer|plan)$/.test(path)) && (teamBuilder.jobs.has(mutation[1]) || delivery.jobs.has(mutation[1]))) throw new Error('项目正在组队或构建交付，请等待或取消当前操作');
      const goalsRoute = path.match(/^\/api\/projects\/([a-f0-9-]{36})\/(goals|sessions-reset|plan)(?:\/([a-f0-9-]{36}))?$/);
      if (goalsRoute) {
        const [, id, operation, goalId] = goalsRoute;
        const project = store.project(id);
        if (!project) return json(response, 404, { error: '项目不存在' });
        if (request.method === 'GET' && operation === 'goals') {
          if (orchestrator.engine && goalId) return json(response, 200, projectDetail(id, goalId));
          let detail = goalId ? store.detail(id, goalId) : store.goals(id);
          if (detail && goalId) detail = { ...detail, delivery: delivery.snapshot(id, goalId), paths: git.paths(id), active: !detail.historical && orchestrator.controls.has(id), ...(!detail.historical ? { office: buildOfficeSnapshot(store, orchestrator, id) } : {}) };
          return json(response, detail ? 200 : 404, detail || { error: '目标不存在' });
        }
        if (request.method === 'POST' && !goalId) {
          const value = await body(request);
          if (!(orchestrator.engine && ['goals', 'plan'].includes(operation)) && (orchestrator.controls.has(id) || teamBuilder.jobs.has(id) || delivery.jobs.has(id))) throw new Error('请等待当前轮次、组队或交付停止后再操作');
          if (operation === 'goals') {
            const profile = hostSetup.verified(value.hostTestId), settings = value.settings || {};
            if (!['manual', 'auto'].includes(settings.confirmationMode || 'auto')) throw new Error('确认方式无效');
            const create = orchestrator.engine ? store.enqueueGoal.bind(store) : store.createGoal.bind(store);
            const created = create(id, { title: field(value.title, '目标标题', 100, true), goal: field(value.goal, '目标', 30000), settings: {
              ...project.settings, hostType: profile.hostType, model: profile.model, reasoningEffort: profile.reasoningEffort || '', hostTestId: value.hostTestId,
              language: validateLanguage(settings.language ?? project.settings.language ?? 'zh-CN'), confirmationMode: settings.confirmationMode || 'auto',
              evaluationMinutes: number(settings.evaluationMinutes, 5, 0.1, 1440, '评估间隔'),
              agentTimeoutMinutes: number(settings.agentTimeoutMinutes, 30, 1, 240, 'Agent 时限'),
              testTimeoutSeconds: number(settings.testTimeoutSeconds, 120, 5, 3600, '测试时限')
            } }, value.autoStart !== false);
            if (orchestrator.engine) { if (value.autoStart !== false) orchestrator.pump(id); return json(response, 200, projectDetail(id, created)); }
            if (value.autoStart !== false) orchestrator.start(id);
          } else if (operation === 'sessions-reset') store.resetSessions(id);
          else {
            const targetStore = orchestrator.engine && value.goalId ? orchestrator.engine(id, value.goalId).store : store;
            if (targetStore.project(id).status !== 'awaiting_approval') throw new Error('仅等待确认的计划可以编辑');
            const plan = validatePlan(JSON.stringify(value));
            if (plan.needsInput) throw new Error('请提交完整计划');
            validateAssignments(project, plan);
            targetStore.plan(id, plan); targetStore.event(id, 'plan.edited', '用户调整计划，等待确认');
          }
          return json(response, 200, store.detail(id));
        }
      }
      if (path === '/api/projects' && request.method === 'GET') return json(response, 200, store.list().map(project => ({ ...project, ...(url.searchParams.has('offices') && project.settings.showOfficeOnHome !== false ? { office: homeOfficeSnapshot(store, orchestrator, project.id) } : {}) })));
      if (path === '/api/projects' && request.method === 'POST') {
        const value = await body(request), settings = value.settings || {};
        const profile = hostSetup.verified(value.hostTestId);
        if (!['manual', 'auto'].includes(settings.confirmationMode || 'auto')) throw new Error('确认方式无效');
        if (!hosts.includes(settings.hostType || 'codex')) throw new Error('不支持的 Agent 宿主');
        const project = store.create({ name: field(value.name, '项目名称', 100), goal: field(value.goal, '目标', 30000), settings: {
          language: validateLanguage(settings.language ?? 'zh-CN'), hostType: profile.hostType, model: profile.model, reasoningEffort: profile.reasoningEffort || '', hostTestId: value.hostTestId, confirmationMode: settings.confirmationMode || 'auto',
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
          if (request.method === 'GET') return json(response, 200, { employees: team(store.project(id)), characterNames, characters, languages, goal: store.project(id).goal, generation: teamBuilder.latest(id), context: store.project(id).settings.context || '', language: store.project(id).settings.language || 'zh-CN' });
          if (request.method === 'POST') {
            const value = await body(request);
            if (orchestrator.controls.has(id) || orchestrator.steering.has(id) || teamBuilder.jobs.has(id)) throw new Error('请先暂停项目，等待当前轮次或团队生成退出后再修改团队');
            store.saveEmployees(id, validateTeam(value.employees), value.language === undefined ? undefined : validateLanguage(value.language), value.context === undefined ? undefined : field(value.context, '项目上下文', 20000, true));
            orchestrator.pump?.(id);
            return json(response, 200, { employees: team(store.project(id)) });
          }
        }
        if (request.method === 'GET' && !action && orchestrator.engine && store.project(id).active_goal_id) return json(response, 200, projectDetail(id));
        if (request.method === 'GET' && !action) return json(response, 200, { ...store.detail(id), delivery: delivery.snapshot(id), paths: git.paths(id), active: orchestrator.controls.has(id), office: buildOfficeSnapshot(store, orchestrator, id) });
        if (request.method === 'GET' && action === 'office') return json(response, 200, buildOfficeSnapshot(store, orchestrator, id));
        if (request.method === 'GET' && action === 'events') return json(response, 200, store.events(id, {
          after: number(url.searchParams.get('after') ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, '游标'),
          before: number(url.searchParams.get('before') ?? undefined, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER, '游标'),
          limit: Math.floor(number(url.searchParams.get('limit') ?? undefined, 100, 1, 500, '记录数量')),
          goalId: url.searchParams.get('goal') || undefined, search: url.searchParams.get('search') || '', kind: url.searchParams.get('kind') || '',
        }));
        if (request.method === 'POST' && action) {
          const value = await body(request);
          if (teamBuilder.jobs.has(id)) throw new Error('请等待或取消团队生成后再操作');
          const targetStore = orchestrator.engine ? orchestrator.engine(id, value.goalId).store : store;
          if (action === 'start') orchestrator.start(id, { goalId: value.goalId });
          else if (action === 'approve') orchestrator.approve(id, value.goalId);
          else if (action === 'pause') await orchestrator.pause(id, value.goalId);
          else if (action === 'evaluate') orchestrator.evaluateNow(id, value.goalId);
          else if (action === 'steer') await orchestrator.steer(id, field(value.content, '补充指令', 10000), value.goalId);
          else if (action === 'answer') {
            if (orchestrator.isGoalActive ? orchestrator.isGoalActive(id, value.goalId) : orchestrator.controls.has(id)) throw new Error('当前轮次尚未退出，请稍后提交');
            const pending = targetStore.questions(id).filter((question) => question.answer === null);
            if (!pending.length || !Array.isArray(value.answers) || value.answers.length !== pending.length) throw new Error('请回答全部待处理问题');
            const answers = pending.map((question) => ({ id: question.id, answer: field(value.answers.find((answer) => answer.id === question.id)?.answer, '回答', 10000) }));
            for (const answer of answers) {
              targetStore.answer(id, answer.id, answer.answer);
              targetStore.event(id, 'input.answer', `${pending.find((question) => question.id === answer.id).prompt}\n回答：${answer.answer}`);
            }
            orchestrator.start(id, { goalId: value.goalId });
          } else return json(response, 405, { error: '不支持此操作' });
          return json(response, 200, orchestrator.engine ? projectDetail(id, value.goalId) : store.detail(id));
        }
      }
      const run = path.match(/^\/api\/runs\/([a-f0-9-]{36})$/);
      if (request.method === 'GET' && run) {
        const value = store.run(run[1]);
        return json(response, value ? 200 : 404, value || { error: '记录不存在' });
      }
      const files = { ...engineFiles, '/fonts/HYQiHei_75S.ttf': ['fonts/HYQiHei_75S.ttf', 'font/ttf'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/prompt-preview.js': ['prompt-preview.js', 'text/javascript'],
        '/role-templates.js': ['role-templates.js', 'text/javascript'], '/model-picker.js': ['model-picker.js', 'text/javascript'], '/employees.js': ['employees.js', 'text/javascript'], '/god.js': ['god.js', 'text/javascript'], '/delivery.js': ['delivery.js', 'text/javascript'],
        '/office-card.html': ['office-card.html', 'text/html'], '/office-card.js': ['office-card.js', 'text/javascript'], '/office-card.css': ['office-card.css', 'text/css'], '/projects.js': ['projects.js', 'text/javascript'], '/projects.css': ['projects.css', 'text/css'], '/setup.js': ['setup.js', 'text/javascript'], '/setup.css': ['setup.css', 'text/css'], '/office-view.js': ['office-view.js', 'text/javascript'], '/office-scene.js': ['office-scene.js', 'text/javascript'], '/office.css': ['office.css', 'text/css'],
        '/vendor/munder-difflin/portrait-art.js': ['vendor/munder-difflin/portrait-art.js', 'text/javascript'],
        '/office-license.txt': ['vendor/munder-difflin/LICENSE.txt', 'text/plain'] };
      // 顶层前端模块按请求读取，新增模块无需重启服务；限定文件名，禁止目录穿越。
      if (!Object.hasOwn(files, path) && /^\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(js|css)$/.test(path)) {
        const name = path.slice(1);
        if (readdirSync(publicDir).includes(name)) files[path] = [name, name.endsWith('.js') ? 'text/javascript' : 'text/css'];
      }
      if (request.method === 'GET' && Object.hasOwn(files, path)) {
        const [name, type] = files[path];
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return response.end(await readFile(join(publicDir, name)));
      }
      json(response, 404, { error: '页面或接口不存在' });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: error.message }); else response.end(); }
  });
  server.hostSetup = hostSetup;
  server.teamBuilder = teamBuilder;
  return server;
}

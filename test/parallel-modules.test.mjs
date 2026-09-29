// 本文件使用真实 Git 工作区和可控员工验证并行、接口集成、取消及恢复边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Store } from '../lib/store.mjs';
import { ProjectGit } from '../lib/git.mjs';
import { GoalScheduler } from '../lib/goal-scheduler.mjs';
import { team } from '../lib/employees.mjs';
import { validatePlan } from '../lib/protocol.mjs';

// waitFor 等待可观察状态，超时输出目标状态帮助定位调度问题。
async function waitFor(predicate, detail, timeout = 90000) {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > until) throw new Error(detail()); await new Promise(resolve => setTimeout(resolve, 25)); }
}

// fixture 让两个模块使用不同接口命名，集成员工依据真实产物完成适配。
function fixture(t, { hold = true, failIntegration = false, conflict = false, failMerge = false, controllerDecision = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goalhub-modules-')), store = new Store(join(root, 'state.sqlite')), git = new ProjectGit(root, store);
  const held = new Map(), active = new Set(), calls = [], testStages = [];
  const runtime = { dataDir: root,
    // host 只有员工输出受控，目录创建、提交、合并和清理均走生产 Git 代码。
    async host(options) {
      const employee = options.input.match(/编号 ([^)）]+)/)[1];
      assert.ok(!active.has(employee), `员工重复占用：${employee}`); active.add(employee);
      const context = JSON.parse(options.input.split('本轮任务：\n')[1].split('\n')[0]);
      const requirements = JSON.parse(options.input.split('当前需求：\n')[1].split('\n')[0]);
      const role = options.input.includes('你是规划 Agent') ? 'planner' : options.input.includes('你是执行 Agent') ? 'developer' : options.input.includes('你是用户指令协调负责人') ? 'controller' : 'review';
      calls.push({ role, task: context.task?.title, cwd: options.cwd, input: options.input });
      let finish;
      const done = new Promise(resolve => { finish = value => { active.delete(employee); resolve(value); }; });
      // reply 为每个模块交付自测文件和真实接口说明。
      const reply = () => {
        let value;
        if (role === 'planner') {
          value = { summary: '模块并行后适配', tasks: [
            { id: 'a', title: '界面模块', description: '实现页面', inputs: '登录凭据', outputs: '界面状态', scope: 'ui.txt', assignee: 'developer', checkIds: ['a'] },
            { id: 'b', title: '服务模块', description: '实现服务', inputs: '凭据数据', outputs: '用户身份', scope: 'backend.txt', assignee: 'evaluator', checkIds: ['b'] },
            { id: 'c', title: '真实接口集成', description: '适配双方接口并验证登录', phase: 'integration', assignee: 'developer', dependsOn: ['a', 'b'], checkIds: ['all'] },
          ], checks: ['a', 'b', 'all'].map(id => ({ id, title: id, command: id, expectation: '真实产物符合预期' })),
          requirements: { summary: '模块并行', included: ['模块并行'], deferred: [], excluded: [], sourceRevision: requirements.revision, sourceIds: requirements.sources.map(item => item.id) } };
        } else if (role === 'developer') {
          const title = context.task.title;
          if (title === '界面模块') {
            writeFileSync(join(options.cwd, 'ui.txt'), 'submitLogin');
            writeFileSync(join(options.cwd, 'goalhub.delivery.json'), JSON.stringify({ kind: 'source', instructions: '示例模块，检查接口适配结果。' }));
          } else if (title === '服务模块') writeFileSync(join(options.cwd, 'backend.txt'), '/sessions');
          else {
            assert.ok(context.tasks.filter(task => task.status === 'done').every(task => task.handoff));
            writeFileSync(join(options.cwd, 'adapter.txt'), `${readFileSync(join(options.cwd, 'ui.txt'), 'utf8')} -> ${readFileSync(join(options.cwd, 'backend.txt'), 'utf8')}`);
          }
          if (conflict && title !== '真实接口集成') writeFileSync(join(options.cwd, 'shared.txt'), options.cwd.includes('integrations') ? '界面与服务均保留' : title);
          options.onEvent('item.completed', JSON.stringify({ item: { type: 'todo_list', items: [{ text: '完成目标', completed: true }, { text: '测试目标', completed: true }] } }));
          value = { status: 'done', summary: title, handoff: `${title}：真实接口见产物；用关联命令验证` };
        } else if (role === 'controller') value = controllerDecision || { action: 'pause', taskIds: [], summary: '用户要求暂停', resume: false };
        else value = { action: 'complete', summary: '通过' };
        finish({ code: 0, finalMessage: JSON.stringify(value) });
      };
      const key = context.task?.title;
      if (hold && role === 'developer' && key !== '真实接口集成') held.set(key, reply); else setTimeout(reply, 1);
      return { done, stop() { held.delete(key); finish({ code: 1, error: '中断' }); } };
    },
    // command 在当前候选目录验证真实文件，最终集成必须连接实际接口。
    async command(command, cwd) {
      const files = { a: 'ui.txt', b: 'backend.txt', all: 'adapter.txt' };
      testStages.push({ command, cwd });
      const passed = !(failMerge && cwd.includes('integrations') && existsSync(join(cwd, 'ui.txt')) && existsSync(join(cwd, 'backend.txt'))) && existsSync(join(cwd, files[command])) && (command !== 'all' || !failIntegration && readFileSync(join(cwd, files[command]), 'utf8') === 'submitLogin -> /sessions');
      return { done: Promise.resolve({ code: passed ? 0 : 1 }), stop() {} };
    },
  };
  const project = store.create({ name: '并行模块', goal: '模块并行', settings: { executionMode: 'parallel', maxParallelTasks: 2, evaluationMinutes: 60, confirmationMode: 'auto' } });
  store.saveEmployees(project.id, team(project).slice(0, 3).map(employee => ({ ...employee, capabilities: employee.isLead ? ['coordination', 'review'] : ['development'] })));
  const scheduler = new GoalScheduler({ store, git, runtime, retryDelayMs: 1 });
  const detail = () => JSON.stringify(store.goals(project.id).map(g => [g.status, g.summary])) + JSON.stringify(store.tasks(project.id).map(x => [x.title, x.status, x.result]));
  t.after(async () => { await scheduler.close(); store.close(); assert.ok(relative(tmpdir(), root).startsWith('goalhub-modules-')); rmSync(root, { recursive: true, force: true }); });
  return { id: project.id, goalId: project.active_goal_id, store, git, scheduler, held, calls, active, detail, testStages };
}

test('同一目标的模块真正并行，实际接口由集成任务适配并验证后合入主分支', async t => {
  const f = fixture(t); f.scheduler.start(f.id);
  await waitFor(() => f.held.size === 2, f.detail);
  const workers = f.calls.filter(call => call.role === 'developer');
  assert.equal(new Set(workers.map(call => call.cwd)).size, 2);
  assert.ok(!f.calls.some(call => call.task === '真实接口集成'));
  f.held.get('服务模块')(); f.held.delete('服务模块');
  f.held.get('界面模块')(); f.held.delete('界面模块');
  await waitFor(() => !f.scheduler.controls.has(f.id), f.detail);
  assert.equal(f.store.project(f.id).status, 'completed', f.detail());
  assert.equal(readFileSync(join(f.git.paths(f.id).repo, 'adapter.txt'), 'utf8'), 'submitLogin -> /sessions');
  assert.ok(f.store.db.prepare("SELECT count(*) n FROM task_verifications WHERE stage='integration' AND status='passed'").get().n >= 3);
  for (const worker of workers) assert.equal(existsSync(worker.cwd), false);
});

test('用户取消运行中模块后不再接纳其成果，其他模块可恢复且依赖不会误判完成', async t => {
  const f = fixture(t); f.scheduler.start(f.id);
  await waitFor(() => f.held.size === 2, f.detail);
  const task = f.store.tasks(f.id).find(task => task.title === '服务模块');
  await f.scheduler.controlTask(f.id, f.goalId, task.id, 'cancel');
  await waitFor(() => f.held.has('界面模块'), f.detail);
  f.held.get('界面模块')(); f.held.delete('界面模块');
  await waitFor(() => !f.scheduler.controls.has(f.id), f.detail);
  assert.equal(f.store.tasks(f.id).find(item => item.id === task.id).status, 'cancelled');
  assert.equal(f.store.project(f.id).status, 'blocked');
  assert.ok(!f.calls.some(call => call.task === '真实接口集成'));
  assert.equal(existsSync(join(f.git.paths(f.id).repo, 'backend.txt')), false);
});

test('暂停自然语言不自动恢复，连续用户输入均持久保存', async t => {
  const f = fixture(t); f.scheduler.start(f.id);
  await waitFor(() => f.held.size === 2, f.detail);
  await Promise.all([f.scheduler.steer(f.id, '暂停', f.goalId), f.scheduler.steer(f.id, '先停一下等我确认', f.goalId)]);
  assert.equal(f.store.project(f.id).status, 'paused');
  assert.equal(f.active.size, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM control_requests WHERE status='applied'").get().n, 2);
});

test('计划增量修订保留编号，任务版本变化使旧成果失效', () => {
  const store = new Store(':memory:');
  try {
    const p = store.create({ name: '版本', goal: '模块', settings: { executionMode: 'parallel' } });
    const plan = validatePlan(JSON.stringify({ summary: '模块', tasks: [{ id: 'a', title: '模块', description: '第一版', assignee: 'developer', checkIds: ['a'] }], checks: [{ id: 'a', title: '验证', command: 'test', expectation: '完成' }] }));
      store.plan(p.id, plan); const before = store.tasks(p.id)[0];
      store.db.prepare('UPDATE tasks SET handoff=?,result=? WHERE id=?').run('旧接口', '旧结果', before.id);
    plan.tasks[0].description = '第二版'; store.plan(p.id, plan);
      const after = store.tasks(p.id)[0]; assert.equal(after.id, before.id); assert.equal(after.version, 2); assert.equal(store.taskCurrent(p.id, before), false);
      assert.doesNotMatch(after.handoff, /旧接口/); assert.match(after.handoff, /尚未提交实现说明/); assert.equal(after.result, '');
  } finally { store.close(); }
});

// 文本冲突交给具有开发权限的员工修复，不能通过强制覆盖掩盖冲突。
test('模块合并冲突由集成员工修改后重新验证，保留双方功能', async t => {
  const f = fixture(t, { hold: false, conflict: true }); f.scheduler.start(f.id);
  await waitFor(() => !f.scheduler.controls.has(f.id), f.detail);
  assert.equal(f.store.project(f.id).status, 'completed', f.detail());
  assert.equal(readFileSync(join(f.git.paths(f.id).repo, 'shared.txt'), 'utf8'), '界面与服务均保留');
  assert.ok(f.calls.some(call => call.role === 'developer' && call.cwd.includes('integrations')));
});

// 组合失败不能改变最后一次通过验证的目标分支，也不能发布到主分支。
test('集成回归失败保留任务成果且不污染已验证分支', async t => {
  const f = fixture(t, { hold: false, failMerge: true }); f.scheduler.start(f.id);
  await waitFor(() => !f.scheduler.controls.has(f.id), f.detail);
  assert.equal(f.store.project(f.id).status, 'blocked', f.detail());
  const work = f.scheduler.engine(f.id, f.goalId).git.paths(f.id).work;
  assert.ok(!(existsSync(join(work, 'ui.txt')) && existsSync(join(work, 'backend.txt'))));
  assert.equal(existsSync(join(f.git.paths(f.id).repo, 'adapter.txt')), false);
  assert.ok(f.store.tasks(f.id).some(task => task.status === 'blocked'));
  assert.ok(f.store.db.prepare("SELECT count(*) n FROM task_verifications WHERE stage='integration' AND status='failed'").get().n > 0);
});

// 用户要求修改但先不继续时，主管修订需求入口，不能偷偷启动旧任务。
test('主管根据用户内容请求重规划且遵守保持暂停', async t => {
  const f = fixture(t, { controllerDecision: { action: 'replan', taskIds: [], summary: '调整服务存储，先暂停待确认', resume: false } });
  f.scheduler.start(f.id); await waitFor(() => f.held.size === 2, f.detail);
  await f.scheduler.steer(f.id, '服务改用本地文件存储，先不要继续执行', f.goalId);
  assert.equal(f.store.project(f.id).status, 'paused');
  assert.equal(f.store.project(f.id).resume_phase, 'plan');
  assert.equal(f.store.instructions(f.id).at(-1).kind, 'requirement');
  assert.match(f.store.instructions(f.id).at(-1).content, /本地文件/);
  assert.equal(f.active.size, 0);
});

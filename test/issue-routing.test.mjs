// 本文件验证主管分流技术问题与需求澄清，防止执行日志直接成为用户待办。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../lib/store.mjs';
import { Orchestrator } from '../lib/orchestrator.mjs';

// fixture 保留真实数据库与问题分流，仅模拟主管回复。
function fixture(t, reply) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = store.create({ name: '问题归属', goal: '交付游戏', settings: {} });
  const engine = new Orchestrator({ store, git: { async ensure() { return { work: '.' }; } }, runtime: {} });
  engine.context = () => JSON.stringify({ goal: project.goal });
  // agent 核实问题交给主管审核，且原始证据进入内部上下文。
  engine.agent = async (control, role, cwd, prompt) => {
    assert.equal(role, 'issue-review');
    assert.match(prompt, /用户只负责项目需求/);
    assert.match(prompt, /game\/main.gd/);
    return JSON.stringify(reply);
  };
  return { engine, store, id: project.id, control: { id: project.id } };
}

test('安装包技术问题被主管退回团队，不创建用户问题或改变需求', async t => {
  const f = fixture(t, { action: 'repair', summary: '安装包过期由团队处理', repair: '重新构建安装包并验证安装和运行' });
  await assert.rejects(f.engine.ask(f.control, ['请用户说明怎么修复'], 'game/main.gd 源码过期'), /重新构建/);
  assert.equal(f.store.questions(f.id).length, 0);
  assert.notEqual(f.store.project(f.id).status, 'waiting_input');
  assert.equal(f.store.instructions(f.id)[0].kind, 'repair');
  assert.equal(f.store.project(f.id).goal, '交付游戏');
});

test('仅主管重新组织的需求问题进入用户问答', async t => {
  const f = fixture(t, { action: 'needs_input', summary: '需要澄清游戏范围', questions: ['本轮需要支持几名玩家？'] });
  await f.engine.ask(f.control, ['技术错误怎么处理？'], 'game/main.gd 同时涉及玩家数量需求');
  assert.equal(f.store.project(f.id).status, 'waiting_input');
  assert.equal(f.store.questions(f.id)[0].prompt, '本轮需要支持几名玩家？');
});

test('主管未能有效分流时不把原始技术问题透传给用户', async t => {
  const f = fixture(t, { action: 'continue', summary: '未判断' });
  await assert.rejects(f.engine.ask(f.control, ['请分析日志'], 'game/main.gd 失败'), /分流必须/);
  assert.equal(f.store.questions(f.id).length, 0);
});

test('团队故障面板没有要求用户处理技术问题的表单', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const panel = html.split('id="blocker-panel"')[1].split('</section>')[0];
  assert.doesNotMatch(panel, /<form|textarea|提交处理意见|按原配置重试/);
  assert.match(panel, /此问题由项目团队负责/);
});

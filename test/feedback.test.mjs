// 本文件验证结构化提问、旧数据兼容、回答提交和阻断说明，避免用户从日志推断问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { validatePlan, validateWork, validateDispatch, validateEvaluation } from '../lib/protocol.mjs';
import { phasePrompt } from '../lib/prompts.mjs';
import { renderQuestionForm, collectQuestionAnswers, blockerFeedback } from '../public/feedback.js';

const question = { question: '缺少的角色数值本轮如何处理？', context: '正在整理基础版角色，目前已确认移动和攻击规则，三个角色缺少可靠数值。', reason: '无法核实原始数值，需要决定是否将这些角色纳入本轮范围。',
  options: [{ label: '本轮延期', impact: '先完成已确认角色，缺少数值的角色登记为待定。' }, { label: '补充资料后实现', impact: '你提供资料后再加入本轮。' }], recommendation: '本轮延期', answerHint: '例如：本轮延期，并在交付说明列出缺项。' };

// makeQuestion 构造存储和界面共同使用的提问记录。
function makeQuestion() { return { id: 'q1', prompt: question.question, details: question, answer: null }; }

test('所有模型阶段接受相同结构化问题，同时兼容历史字符串', () => {
  const cases = [[validatePlan, { needsInput: true }], [validateWork, { status: 'needs_input' }], [validateDispatch, { needsInput: true }], [validateEvaluation, { action: 'needs_input' }]];
  for (const [validate, result] of cases) {
    assert.deepEqual(validate(JSON.stringify({ ...result, summary: '缺少资料', questions: [question] })).questions, [question]);
    assert.deepEqual(validate(JSON.stringify({ ...result, summary: '缺少资料', questions: ['旧问题'] })).questions, ['旧问题']);
  }
});

test('不完整背景、模糊选项、无对应推荐和过长问题不能进入用户界面', () => {
  for (const override of [{ context: '' }, { reason: '' }, { answerHint: '' }, { question: '问'.repeat(201) }, { recommendation: '不存在' }, { options: [{ label: '继续', impact: '' }] }]) {
    assert.throws(() => validateWork(JSON.stringify({ status: 'needs_input', summary: '问题', questions: [{ ...question, ...override }] })));
  }
});

test('SQLite 保存问题结构和回答，旧记录仍读取为原问题', () => {
  const store = new Store(':memory:');
  try {
    const project = store.create({ name: '反馈测试', goal: '制作可玩的游戏', settings: {} });
    store.ask(project.id, [question, '旧问题']);
    const [saved, legacy] = store.questions(project.id);
    assert.deepEqual(saved.details, question); assert.equal(saved.prompt, question.question);
    assert.deepEqual(legacy.details, {}); assert.equal(legacy.prompt, '旧问题');
    store.answer(project.id, saved.id, '本轮延期');
    assert.equal(store.questions(project.id)[0].answer, '本轮延期');
  } finally { store.close(); }
});

test('界面清晰展示上下文与影响、推荐不预选，模型文本被转义', () => {
  const html = renderQuestionForm({ goal: '<script>目标</script>', tasks: [{ title: '整理角色', status: 'blocked' }] }, [makeQuestion()]);
  for (const text of ['当前目标', '正在处理', '问题背景', '为什么需要你', question.question, question.options[0].impact, '其他处理方式', '更新计划并继续']) assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes(' checked')); assert.ok(!html.includes('undefined'));
});

test('旧长问题有简短标题和折叠原文，完整问题不会丢失', () => {
  const old = '旧问题'.repeat(100), html = renderQuestionForm({ goal: '目标', tasks: [] }, [{ id: 'old', prompt: old, answer: null }]);
  assert.ok(html.includes('查看原始问题（完整内容）')); assert.ok(html.includes(old));
  assert.ok(html.includes('未单独记录背景与选项'));
});

test('选项与补充内容一起提交，自定义回答和旧问题不需要选择', () => {
  let extra = '先做可运行版本', choice = '0', focused = false;
  const form = { elements: { namedItem(name) { return name === 'q1' ? { value: extra, focus() { focused = true; } } : { value: choice }; } } };
  assert.deepEqual(collectQuestionAnswers(form, [makeQuestion()]), [{ id: 'q1', answer: `选择：本轮延期\n选项说明：${question.options[0].impact}\n补充：先做可运行版本` }]);
  choice = 'custom'; assert.equal(collectQuestionAnswers(form, [makeQuestion()])[0].answer, extra);
  choice = ''; extra = ''; assert.throws(() => collectQuestionAnswers(form, [makeQuestion()]), /请回答/); assert.equal(focused, true);
});

test('普通资料阻断不提示超时，真实超时和验收失败提供对应处理方向', () => {
  const project = { goal: '游戏', summary: '连续三轮未能推进：JSON 校验通过。缺少原版证据，基准尚未冻结。。自动执行已停止，请查看失败原因。', tasks: [{ title: '冻结基准', done_when: '依据齐全', status: 'pending' }], checks: [] };
  const feedback = blockerFeedback(project);
  assert.equal(feedback.timeout, false); assert.ok(feedback.reason.includes('未通过检查')); assert.ok(feedback.context.includes('冻结基准')); assert.ok(!feedback.reason.includes('JSON 校验通过'));
  assert.equal(blockerFeedback({ ...project, summary: 'Agent 执行超时，已停止进程' }).timeout, true);
  assert.match(blockerFeedback({ ...project, checks: [{ title: '保存后重启恢复', status: 'failed' }] }).reason, /未通过检查/);
});

test('每个阶段的提示词都明确提问结构，例子不再要求字符串问题', () => {
  for (const role of ['planner', 'coordinator', 'developer', 'evaluator', 'final-review']) {
    const input = phasePrompt(role, { context: JSON.stringify({ goal: '目标' }), task: {} });
    assert.ok(input.includes('"questions":[{"question":')); assert.ok(input.includes('选项最多3个')); assert.ok(!input.includes('"questions":["'));
  }
});

// 历史失败摘要末尾的工作边界说明不能遮住真正的审查阻断。
test('审查阻断展示中间原因和任务反馈，不再只取末句', () => {
  const result = '测试通过。最终Review尚未解决：当前计划缺少最终Acceptance之后的独立审查步骤。需负责人安排审查员重新审查。未执行正式构建或改写审查结论。';
  const feedback = blockerFeedback({ status: 'blocked', summary: `连续三轮未能推进：${result}。自动执行已停止`, tasks: [{ title: '修复评估发现的问题', status: 'pending', description: '审查本轮证据', result }] });
  assert.match(feedback.reason, /未通过检查/);
  assert.doesNotMatch(feedback.reason, /Acceptance|Review|审查员/);
  assert.match(feedback.context, /<details/);
  assert.match(feedback.request, /无需分析报错/);
  assert.ok(!feedback.reason.includes('未执行正式构建'));
  assert.match(feedback.context, /执行反馈/); assert.match(feedback.context, /审查本轮证据/);
});

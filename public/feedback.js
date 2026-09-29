// 本文件组织用户反馈的上下文、明确问题和回答选项，不将执行日志作为表单说明。
import { currentBlocker } from './context-state.js';

// escapeFeedback 对模型和用户文本做 HTML 转义，防止反馈内容插入页面代码。
export function escapeFeedback(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }

// compactText 保留简短可读的摘要，完整内容由折叠详情承载。
function compactText(value, max = 180) { const text = String(value || '').trim(); return text.length > max ? text.slice(0, max) + '…' : text; }

// contextRow 为每个背景事实显示稳定标签，长内容仅在用户展开时显示。
function contextRow(label, value) {
  if (!value) return '';
  return `<div class="feedback-fact"><dt>${escapeFeedback(label)}</dt><dd>${escapeFeedback(compactText(value))}${value.length > 180 ? `<details><summary>查看完整${escapeFeedback(label)}</summary><p>${escapeFeedback(value)}</p></details>` : ''}</dd></div>`;
}

// renderQuestionForm 将每个决定独立呈现，旧字符串问题保留原文并补充可确认的任务上下文。
export function renderQuestionForm(project, pending) {
  const task = project.tasks?.find(item => ['running', 'blocked'].includes(item.status)) || project.tasks?.find(item => item.status !== 'done');
  return `<h2>需要你回答 ${pending.length} 个问题</h2><p class="feedback-intro">回答后，负责人会更新计划再继续；已有成果会保留。</p><form id="answer-form">${pending.map((item, index) => {
    const detail = item.details || {}, options = detail.options || [];
    return `<fieldset class="feedback-question" data-question-id="${escapeFeedback(item.id)}"><legend><span class="feedback-number">问题 ${index + 1}</span>${escapeFeedback(detail.question || compactText(item.prompt, 160))}</legend>
      <dl>${contextRow('当前目标', project.goal)}${contextRow('正在处理', task?.title)}${contextRow('问题背景', detail.context)}${contextRow('为什么需要你', detail.reason)}</dl>
      ${!detail.question ? `<details class="feedback-legacy"><summary>查看原始问题${item.prompt.length > 160 ? '（完整内容）' : ''}</summary><p>${escapeFeedback(item.prompt)}</p></details><p class="subtle">此问题来自旧版记录，未单独记录背景与选项。</p>` : ''}
      ${options.length ? `<div class="feedback-options" role="group" aria-label="回答选项">${options.map((option, position) => `<label class="feedback-option"><input type="radio" name="choice-${escapeFeedback(item.id)}" value="${position}"><span><strong>${escapeFeedback(option.label)}</strong>${option.label === detail.recommendation ? '<em>建议选择</em>' : ''}<small>${escapeFeedback(option.impact)}</small></span></label>`).join('')}<label class="feedback-option"><input type="radio" name="choice-${escapeFeedback(item.id)}" value="custom"><span><strong>其他处理方式</strong><small>在下方填写你的决定。</small></span></label></div>` : ''}
      <label class="feedback-answer" for="answer-${escapeFeedback(item.id)}">${options.length ? '补充说明（选择其他方式时必填）' : '你的回答'}<textarea id="answer-${escapeFeedback(item.id)}" name="${escapeFeedback(item.id)}" maxlength="10000" rows="3" placeholder="${escapeFeedback(detail.answerHint || '说明你的决定，或提供所需信息。')}"></textarea></label>
      </fieldset>`;
  }).join('')}<button class="primary" type="submit">提交回答，更新计划并继续</button></form>`;
}

// collectQuestionAnswers 将选项及补充说明合成可追溯答复，不会默认代替用户选择。
export function collectQuestionAnswers(form, pending) {
  return pending.map(item => {
    const field = form.elements.namedItem(item.id), extra = field.value.trim();
    const choice = form.elements.namedItem(`choice-${item.id}`)?.value;
    const option = (item.details?.options || [])[Number(choice)];
    const selected = choice !== undefined && choice !== '' && choice !== 'custom' ? option : null;
    if (!selected && !extra) { field.focus(); throw new Error(`请回答：${compactText(item.details?.question || item.prompt, 80)}`); }
    const answer = selected ? `选择：${selected.label}\n选项说明：${selected.impact}${extra ? `\n补充：${extra}` : ''}` : extra;
    if (answer.length > 10000) { field.focus(); throw new Error('回答过长，请缩短补充说明。'); }
    return { id: item.id, answer };
  });
}

// blockerFeedback 将执行故障与用户决策分开，技术证据只放在折叠详情中。
export function blockerFeedback(project) {
  const blocker = currentBlocker(project);
  const timeout = /执行超时|运行超时|timed?\s*out|timeout/i.test(project.summary || '');
  const reason = blocker?.kind === 'host' ? '执行服务暂时无法连接，任务已暂停，已有成果已保留。'
    : timeout ? '这一步用时超过了本次执行上限，任务已暂停，已有成果已保留。'
    : '当前成果还未通过检查，任务已暂停，已有成果已保留。';
  const task = project.tasks?.find(item => ['running', 'blocked'].includes(item.status)) || project.tasks?.find(item => !['done', 'cancelled'].includes(item.status));
  return { timeout, reason,
    context: '<details class="feedback-diagnostics"><summary>查看技术详情（可跳过）</summary><dl class="feedback-context">' + contextRow('内部任务', task?.title) + contextRow('任务说明', task?.description) + contextRow('执行反馈', task?.result) + contextRow('原完成条件', task?.done_when) + '</dl></details>',
    request: '你无需分析报错或提供技术修复方案。技术问题由主管组织项目员工处理，只有项目需求不明确时才会请你澄清。',
    hint: '选填：你希望最终达到什么效果。无需填写代码、命令或修复步骤。' };
}

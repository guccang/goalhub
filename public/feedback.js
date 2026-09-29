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

// blockerFeedback 依据实际失败类型给出处理方向，原始日志仍可展开核对。
export function blockerFeedback(project) {
  const blocker = currentBlocker(project);
  if (blocker?.kind === 'host') return { timeout: false, reason: `员工宿主未能正常启动或连接：${blocker.message}`, context: `<dl class="feedback-context">${contextRow('当前目标', project.goal)}${contextRow('当前阶段', blocker.phase === 'planner' ? '负责人规划尚未启动成功' : '员工宿主执行')}</dl>`, request: '请先处理宿主程序路径、登录或运行环境，再按原配置重试。无需修改产品需求或重复回答范围问题。', hint: '填写已完成的环境处理；若确实改变产品范围，请选择“修改需求”。' };
  const raw = project.summary || '', timeout = /执行超时|运行超时|timed?\s*out|timeout/i.test(raw);
  const failedCheck = project.checks?.find(check => check.status === 'failed' && (!blocker?.runId || blocker.kind === 'test'));
  const task = project.tasks?.find(item => item.status === 'running' || item.status === 'blocked') || project.tasks?.find(item => !['done', 'cancelled'].includes(item.status));
  const cleaned = raw.replace(/^连续三轮未能推进[：:]/, '').replace(/。自动执行已停止[\s\S]*$/, '').trim();
  const sentences = cleaned.split(/(?<=[。！？\n])/).filter(value => /[\p{L}\p{N}]/u.test(value));
  const problems = sentences.filter(value => /失败|未通过|尚未|缺少|需.*(?:安排|审查|修复)|无法|过期|不一致|阻断/.test(value) && !/^\s*未执行/.test(value));
  const detail = compactText(problems.join('') || cleaned || '当前任务尚未满足完成条件。', 600);
  const reason = timeout ? '当前员工的执行时间已达到配置的上限。' : failedCheck ? `“${failedCheck.title}”未通过验收。${detail}` : detail;
  return { timeout, reason, context: `<dl class="feedback-context">${contextRow('当前目标', project.goal)}${contextRow('卡在哪一步', task?.title || '项目执行')}${contextRow('任务说明', task?.description)}${contextRow('执行反馈', task?.result)}${contextRow('验收输出', failedCheck?.output)}${contextRow('原完成条件', task?.done_when)}</dl>`,
    request: timeout ? '请说明是否调整该员工的超时，或将当前任务拆成更小的步骤。' : failedCheck ? '请说明预期结果或补充复现条件；若验收要求需要调整，请明确调整内容。' : '请针对上方问题说明处理方式：补充缺少的信息，或明确哪些要求需要调整、延期。',
    hint: timeout ? '例如：将当前任务拆分为可独立验证的几个步骤。' : '例如：哪些内容必须保留，哪些可以延期；缺少的信息是什么。' };
}

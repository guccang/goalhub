// 本文件统一展示 Agent 轮次执行人，历史姓名与当前是否在团队中分别表达。
import { escapeFeedback as escape } from './feedback.js';

const membershipLabels = { departed: '已离职', disabled: '已停用', external: '全局管理者', system: '系统执行' };

// runEmployeeText 生成详情与无障碍提示使用的执行人说明。
export function runEmployeeText(run) {
  const employee = run.employee || { name: '员工信息未记录', membership: 'unknown' };
  const state = membershipLabels[employee.membership];
  const renamed = employee.nameSource === 'snapshot' && employee.currentName && employee.currentName !== employee.name;
  return `${employee.name}${state ? `（${state}）` : ''}${employee.position ? ` · 执行时职位：${employee.position}` : ''}${renamed ? ` · 现名：${employee.currentName}` : ''}${employee.nameSource === 'current' ? ' · 历史姓名未记录，显示当前姓名' : ''}${employee.id ? ` · 员工编号：${employee.id}` : ''}`;
}

// renderRunEmployee 显示员工姓名、当时职位与当前成员状态，不将停用误称为离职。
export function renderRunEmployee(run) {
  const employee = run.employee || { name: '员工信息未记录', membership: 'unknown' };
  const label = membershipLabels[employee.membership];
  return `<span class="run-person" title="${escape(runEmployeeText(run))}"><span class="run-person-name"><strong>${escape(employee.name)}</strong>${label ? `<small class="run-membership ${escape(employee.membership)}">${label}</small>` : ''}</span>${employee.position ? `<span class="run-position">${escape(employee.position)}</span>` : ''}${employee.nameSource === 'current' ? '<span class="run-position">历史姓名未记录</span>' : ''}</span>`;
}

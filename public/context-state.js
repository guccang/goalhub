// 本文件依据本轮失败选择阻断原因，供页面和员工上下文共用。
export function currentBlocker(project) {
  if (!['blocked', 'running', 'planning', 'verifying'].includes(project.status)) return null;
  const run = project.latestRun || [...(project.runs || [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const raw = run?.status === 'failed' && run.role !== 'test' && run.output ? run.output : project.summary || '';
  const message = raw.replace(/^连续三轮未能推进[：:]/, '').replace(/。自动执行已停止[\s\S]*$/, '').trim();
  const host = /spawn .*ENOENT|无法加载 agent-runtime|找不到.*(?:宿主|可执行)|登录|认证失败/.test(message);
  const kind = host ? 'host' : /执行超时|运行超时|timed?\s*out|timeout/i.test(message) ? 'timeout' : /验收失败|验收未通过/.test(message) ? 'test' : 'execution';
  if (project.status !== 'blocked' && run?.status !== 'failed') return null;
  return { kind, message, runId: run?.id, phase: run?.role, at: run?.finished_at || run?.created_at || project.updated_at || '' };
}

// 本文件读取员工自行维护的 Markdown 计划，作为宿主原生计划工具的降级入口。
import { mkdirSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

// parseWorkPlan 兼容标准勾选框和用户约定的中文括号勾选，不把说明文字当任务。
export function parseWorkPlan(markdown) {
  const steps = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = line.match(/^\s*-\s+\[([ xX])\]\s*(?:【\s*([xX]?)\s*】\s*)?(.+?)\s*$/);
    if (match) steps.push({ text: match[3], completed: /x/i.test(match[1]) || /x/i.test(match[2] || '') });
  }
  return steps;
}

// prepareWorkPlan 按运行隔离文件；只读阶段仅获准修改此文件，不污染项目交付仓库。
export function prepareWorkPlan(dataDir, runId, onPlan, intervalMs = 1000, planPath = null) {
  const directory = planPath ? dirname(planPath) : resolve(dataDir, 'work-plans', runId);
  mkdirSync(directory, { recursive: true });
  const path = planPath || join(directory, 'plan.md');
  let previous = '';
  // sync 容忍写入期间的临时空文件；最后一次完整有效计划持续保留。
  function sync() {
    let markdown;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 256 * 1024) return;
      markdown = readFileSync(path, 'utf8');
    } catch { return; }
    const steps = parseWorkPlan(markdown), serialized = JSON.stringify(steps);
    if (!steps.length || serialized === previous) return;
    onPlan(steps);
    previous = serialized;
  }
  const timer = setInterval(sync, intervalMs);
  timer.unref?.();
  return {
    path,
    instruction: `\n本轮个人计划文件：${path}\n优先使用已提供的原生计划工具；不可用时自行创建并更新上述 plan.md。每行使用 - [ ] 任务 或 - [x] 任务。本文件已按分工或协调轮次隔离，平台自动读取进度；不要修改其他轮次的计划。即使当前阶段只读，也允许仅写此个人计划文件，此例外不扩大项目文件写入权限。\n`,
    // stop 在成功、失败和中断时都采集最后状态，并释放定时器。
    stop() { clearInterval(timer); sync(); },
  };
}

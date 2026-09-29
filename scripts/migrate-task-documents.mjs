// 本脚本一次性把旧任务正文导出到统一英文文档；再次运行只校验已有文件，不覆盖员工修改。
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const dataDir = resolve(process.argv[2] || process.env.GOALHUB_DATA_DIR || join(repository, 'data'));
const store = new Store(join(dataDir, 'goalhub.sqlite'));
const migrated = [];
try {
  for (const project of store.list()) for (const goal of store.goals(project.id)) {
    const scope = store.forGoal(project.id, goal.id), group = scope.documentGroup(project.id);
    const tasks = scope.tasks(project.id), checks = scope.checks(project.id);
    scope.requirementInput(project.id); scope.requirementSnapshot(project.id);
    migrated.push({ projectId: project.id, taskId: group.task_id, directory: group.directory, assignments: tasks.length, checks: checks.length });
  }
  console.log(JSON.stringify({ migrated, message: '需求、分工及交接已保存为 Markdown；配置、状态和日志继续使用 SQLite。' }, null, 2));
} finally { store.close(); }

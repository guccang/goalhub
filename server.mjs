// 本文件启动 GoalHub 本机服务，并在退出时安全停止 Agent 与数据库连接。
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.mjs';
import { ProjectGit } from './lib/git.mjs';
import { Runtime } from './lib/runtime.mjs';
import { GoalScheduler } from './lib/goal-scheduler.mjs';
import { createApp } from './lib/app.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env.GOALHUB_DATA_DIR || resolve(root, 'data'));
const port = Number(process.env.PORT || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为有效端口');
const store = new Store(resolve(dataDir, 'goalhub.sqlite'));
store.recover();
const git = new ProjectGit(dataDir, store), runtime = new Runtime(dataDir);
const orchestrator = new GoalScheduler({ store, git, runtime });
const server = createApp({ store, git, runtime, orchestrator });
orchestrator.recoverQueues();
server.listen(port, '127.0.0.1', () => console.log(`GoalHub 已启动：http://127.0.0.1:${port}\n数据目录：${dataDir}`));
let closing = false;

// shutdown 先停止业务进程，再关闭连接，保留可恢复的项目状态。
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await orchestrator.close();
  await server.hostSetup.close();
  server.closeAllConnections();
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('error', (error) => { console.error(error.message); store.close(); process.exitCode = 1; });

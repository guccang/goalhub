// 本脚本在员工暂停后迁移分工目录，保留原始身份和所有交接正文。
import { resolve, join } from 'node:path';
import { Store } from '../lib/store.mjs';
const data = resolve(process.argv[2] || 'data');
const store = new Store(join(data, 'goalhub.sqlite'));
try {
  if (store.db.prepare("SELECT 1 FROM runs WHERE status='running' LIMIT 1").get()) throw new Error('请先暂停员工再迁移目录');
  const result = [];
  for (const group of store.db.prepare('SELECT * FROM task_document_groups').all()) {
    const mappings = store.documents.migrateAssignmentDirectories(group);
    result.push({ taskId: group.task_id, directory: group.directory, assignments: mappings });
  }
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }

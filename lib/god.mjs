// 本文件保存 GoalHub 唯一的全局管理者，身份和配置独立于所有项目员工。
import { validateTeam } from './employees.mjs';
export const GOD_ID = 'goalhub-god';
const instructions = '根据项目目标、架构和现有配置搭建适度的团队。定义清晰的职位边界、协作关系、交付物和验收要求，为项目指定一名负责人。生成可供用户调整的配置。';

export class GodManager {
  // constructor 为全局管理者建立独立配置表，项目删除或换人不会影响它。
  constructor(store, hostSetup) {
    this.store = store; this.hostSetup = hostSetup;
    store.db.exec('CREATE TABLE IF NOT EXISTS god_config (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
  }
  // profile 首次访问以全局宿主初始化独立配置，此后宿主默认值变更不会覆盖 God。
  profile() {
    const row = this.store.db.prepare('SELECT value FROM god_config WHERE id=1').get();
    if (row) return JSON.parse(row.value);
    const host = this.hostSetup.profile();
    return this.save({ hostType: host.hostType, model: host.model || '', reasoningEffort: host.reasoningEffort || '', timeoutMinutes: 5, instructions });
  }
  // save 校验执行参数并固定全局身份；不接受项目员工编号、人物或负责人标记。
  save(value) {
    const [config] = validateTeam([{ ...value, id: 'validation', character: 'michael', name: 'God', position: 'GoalHub 管理者', enabled: true, isLead: false, nativeLanguage: '' }]);
    if (!config.instructions.trim()) throw new Error('请填写 God 的工作说明');
    const profile = { id: GOD_ID, name: 'God', scope: 'goalhub', position: 'GoalHub 管理者', hostType: config.hostType, model: config.model, reasoningEffort: config.reasoningEffort, timeoutMinutes: config.timeoutMinutes, instructions: config.instructions };
    this.store.db.prepare('INSERT OR REPLACE INTO god_config(id,value) VALUES(1,?)').run(JSON.stringify(profile));
    return profile;
  }
  // snapshot 汇总 God 为不同项目执行的管理记录，历史项目负责人记录不会混入。
  snapshot(busy = false) {
    return { ...this.profile(), busy, runs: this.store.db.prepare("SELECT r.id,r.status,r.created_at,p.name AS projectName FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.employee_id=? AND r.role='team-builder' ORDER BY r.rowid DESC LIMIT 12").all(GOD_ID) };
  }
}

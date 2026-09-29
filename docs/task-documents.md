# Task documents

任务正文以 Markdown 为权威来源；SQLite 保存配置、目录索引、调度状态、运行日志和历史副本。
不能从旧数据库摘要生成后续员工的交接输入，也不能将员工的完成声明当作验收通过。

## Identity

一个主管总任务对应一个目标，使用该目标的唯一编号作为 `taskId`。
同一总任务拆给不同员工时，共用 `taskId` 和目录。原 `tasks.id` 兼容为 `assignmentId`，用于区分分工、依赖、验收和独立工作区。
目录名为 `<taskId>_YYYYMMDD_HHMMSS`，时间取首次任务创建的本地时间，重新规划、重试、改派和服务重启不改变目录。

```text
data/task-documents/<taskId>_YYYYMMDD_HHMMSS/
  requirements.md
  sources.md
  modules.md
  handoff.md
  checks/<checkId>.md
  assignments/<assignmentId>/
    assignment.md
    plan.md
    handoff.md
    evidence/
    history/v<version>/handoff.md
  coordination/<employeeId>/<runId>/plan.md
```

所有新建文档使用英文文件名，正文默认中文。截图和机器报告可以保留原格式。
既有项目产物中的历史文档路径作为证据保留；统一交流入口始终是这里的 `handoff.md`。

## Ownership

| 内容 | 权威来源 | 更新入口 |
| --- | --- | --- |
| 用户决定 | sources.md | 用户提交要求或答复后，由平台追加 |
| 当前需求和范围例外 | requirements.md | 主管规划通过来源校验后发布 |
| 分工说明、依赖和完成条件 | assignment.md | 主管规划或改派后发布 |
| 验收命令和预期 | checks/*.md | 主管计划或经过校验的 checkUpdates |
| 个人计划 | plan.md | 员工修改，原生计划事件也同步到此文件 |
| 员工交接 | handoff.md | 对应员工维护，平台兼容保存旧宿主返回的摘要 |
| 项目配置、员工配置、执行状态、队列、进程、重试 | SQLite | 平台负责 |
| 真实命令结果、用量、运行记录 | SQLite | 平台采集 |

SQLite 中的正文保留为历史发布副本；运行时需求、分工、验收正文从文件读取。
数据库中的依赖与员工编号作为调度索引，从分工文件同步。身份元数据和文件格式需要保持完整。
业务修改通过主管重新发布，普通员工不得修改需求、其他员工分工和交接。

## Handoff format

保留 `task-metadata` 元数据，包含 taskId、assignmentId、version、employeeId 和 updatedAt。
固定六个二级章节：

1. Identity：当前任务、分工和员工。
2. Requirements：对应需求和分工文档。
3. Implementation：实际实现、接口及文件位置。
4. Verification：运行过的命令、结果和证据路径。区分断言次数与独立测试用例。
5. Remaining：未完成事项、限制和阻断。
6. Next：后续员工的具体接入或验证要求。

员工读取当前需求、自身分工以及直接前置分工的 handoff.md。历史完成摘要不再替代前置交接。
原生计划工具可用时优先使用，平台同步生成 plan.md；否则员工直接编辑该文件。
只读评估阶段可写自己的计划文件，不得借此修改项目代码。

## Recovery

单文件使用同目录临时文件原子替换，多文件发布写入 transaction.md 后重放。
发布标识与调度状态在同一个 SQLite 事务提交；重启时，已提交则完成写入，未提交则恢复旧文档。
文档目录建立后，文件缺失或格式损坏会明确报错；不会静默回退 SQLite 的旧正文。
分工版本变化时保存上个版本的交接，建立新的交接模板。
文件中的验收命令或预期改变后，旧通过结果失效。

部署前暂停运行任务并备份 SQLite 与 task-documents 目录。
执行 `node scripts/migrate-task-documents.mjs <data-directory>` 导出旧目标及分工。
首次导出读取旧数据库正文，重复运行仅校验文件。数据库本身、配置和历史记录保留。
页面提供 requirements.md、sources.md、assignment.md、plan.md 和 handoff.md 的受限查看入口。

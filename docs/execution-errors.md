# Execution errors

SQLite 的 `error` 表保存员工执行中观察到的失败，不参与需求或交接正文读取。

## Fields

| 字段 | 含义 |
| --- | --- |
| project_id | 项目编号 |
| task_id | 主管共享任务编号，与目标编号一致 |
| assignment_id | 员工独立分工编号 |
| run_id / employee_id / role | 当时轮次、员工和执行阶段 |
| kind | command、tool、host、diagnostic、execution、acceptance、coordination 或 assignment |
| message / command / exit_code | 错误信息、命令及已知退出码 |
| context | 当时的完整运行输入、员工快照、项目状态、需求与交接文件快照、最近事件；命令回调同时记录工作目录 |
| event_key | 协议事件去重标识，不用于验收或完成判断 |
| created_at | 归档时间 |

捕获原始 Codex JSON 命令非零退出、工具失败、回合失败、宿主错误诊断、平台验收失败和任务协调失败。
其他宿主的明确结构化错误或终止失败也进入同一入口。宿主未输出的内部错误无法凭空记录。
同一事件重复回调不重复入库，不同轮次分别保存。一个根因可能同时有命令失败和最终轮次失败两条不同层级的记录。
正常完成、普通进展中出现“error”单词，以及主动暂停不会被标为执行失败。
上下文和日志统一脱敏；文档损坏时记录 documentReadError，仍保留错误现场。
该功能启用后的错误自动采集，历史日志不伪装成当时已保存的文档快照。

## Query

`GET /api/projects/<projectId>/errors`

可选参数：`taskId`、`assignmentId`、`employeeId`、`before`、`limit`（1–200）。
默认只返回错误摘要，添加 `context=1` 返回归档的上下文。
按 id 倒序分页，使用最后一项 id 作为下一页 before。
错误分析读取 context 中的历史快照，而不是现在可能已修改的文档。

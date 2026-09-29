# 命令执行与验收修订

GoalHub 不再给 Windows 命令添加 PowerShell 包装或拼接 `$ErrorActionPreference`、`$LASTEXITCODE`。

- 显式 `powershell` / `pwsh`（含 `.exe` 和带空格的完整路径）通过临时启动脚本设置控制台 UTF-8，再以原生进程 API 启动原命令，原样继承输出管道，保留脚本变量、参数和退出码。这样 Windows PowerShell 本地编码输出不会被 UTF-8 采集器误读；启动脚本在结束后清理，停止操作仍终止整个进程树。复杂 PowerShell 验收优先保存 `.ps1`，再用 `-File` 执行。
- 其他 Windows 命令使用 `cmd` 语义，支持 Node、npm 和 `&&`；临时 UTF-8 批处理在系统临时目录创建，执行结束后清理。原来依赖隐式 PowerShell 的命令需要员工明确指定解释器。
- 非 Windows 命令沿用 `/bin/sh`。进程停止、输出采集与真实退出结果继续由公共运行模块处理，超时沿用负责员工配置。

此前已经保存为 `�` 的记录无法通过页面转码恢复原文；修复对新执行生效，历史记录保持原始证据。脚本若自行覆盖输出编码，仍需与 UTF-8 采集约定保持一致。

执行员工、任务分配负责人和评估负责人可在结果 JSON 中提交：

```json
{
  "checkUpdates": [{
    "id": "当前上下文中的验收编号",
    "previousCommand": "原完整命令",
    "command": "powershell -NoProfile -File scripts/verify-scope.ps1",
    "reason": "已将原断言保存到脚本，修复命令引用错误"
  }]
}
```

命令修订必须保持原验收目标及断言；验收预期和任务范围不能通过此字段修改。执行和分配员工只能修改当前任务的验收项；评估修订必须返回 `action: repair`，重新执行后才能完成。纯文字建议不会被当作可执行命令。

平台校验当前目标、任务归属和原命令版本后，原子保存修订，清除旧验收结论，记录 `check.command.updated` 事件（前后命令、原因和来源）。下一次验收重新读取数据库中的命令，历史运行输入与输出继续保留。过期或越界修订全部回滚。

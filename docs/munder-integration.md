# Munder Difflin 办公室接入

## 接入范围

GoalHub 新增默认打开的「像素办公室」视图，保留「任务与记录」工作台。点击画面中的角色或下方角色按钮，即可查看其实际状态、当前任务、会话及输出。暂停项目、继续执行、立即评估和回答问题复用原调度器。

「发送指令并继续」会等待当前 Agent 与测试停止，保存 Git 检查点，将用户要求写入 SQLite 的 `instructions` 表，然后恢复原项目。开发阶段会添加“落实补充执行要求”任务并重新运行验收。补充要求在所有后续 Agent 上下文中保留；已完成项目和等待用户回答的项目不会接受此操作。

## 上游复用与许可

- 仓库：[chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin)
- 固定提交：`91015c0e1316572fe1c771ae3ece162ae0bd92c6`。
- 直接复用 `src/renderer/src/scene/office/portraitArt.ts` 的程序化角色、前后视图和行走帧；去除 TypeScript 类型后供浏览器加载，保留 MIT 许可并补充中文注释。
- Canvas 信封动画改编自上游 `MessageEnvelope.ts` 的距离速度、缓入缓出与弧线公式。
- 场景与家具为 GoalHub 自行绘制，不包含上游独立授权的 LimeZu 贴图、地图或字体。
- 上游 Electron、React、Pixi.js、PTY 和内部 store 没有直接引入。浏览器适配层使用 Canvas 与现有同源 API，执行权仍属于 GoalHub。

来源、原始文件哈希与修改说明保存在 `public/vendor/munder-difflin/UPSTREAM.json`。页面底部显示作者项目与 MIT 许可链接。

重新生成固定版本角色：

```powershell
node scripts/vendor-munder.mjs <固定提交的上游仓库路径>
```

## 角色与真实状态

| 场景角色 | 上游像素角色 | GoalHub 数据 |
| --- | --- | --- |
| 规划员 | Michael | planner 轮次 |
| 开发员 | Jim | developer 轮次、当前任务 |
| 评估员 | Dwight | evaluator 与 final-review 轮次 |
| 测试执行器 | Pam | test 轮次及实际退出状态 |

只有调度器仍持有项目锁且对应轮次为 running 时，角色才显示“工作中”。“本轮结束”表示该角色最近一轮结束，不代表项目已经验收。任务完成度和测试通过数均由 SQLite 计算。角色切换状态时才移动；信封只对应真实的新交接事件。首次打开、切换项目和断线恢复不把历史消息重放成新工作。

页面沿用每两秒的状态刷新。断线会明确显示旧快照、冻结动画并禁用办公室控制。静止场景不持续重绘，隐藏办公室停止帧循环。支持镜头缩放、拖动、全景、减少动态、键盘角色选择和手机布局。

## API 与记录

- `GET /api/projects/:id` 同时返回 `office` 快照。
- `GET /api/projects/:id/office` 单独查询角色、进度、交接、补充指令。
- `POST /api/projects/:id/steer`，请求体 `{ "content": "补充要求" }`。
- 写入继续使用本机来源、JSON 类型与长度校验；不会向上游项目服务器发送目标或记录。
- 所有补充指令保存在 `instructions` 表，同时生成 `control.steer` 步骤记录。旧数据库启动时自动创建新表和索引。

## 验证

自动化测试新增办公室双角色并发、超过 100 轮后仍可见的角色历史、无调度锁时不误报工作、消息对应真实事件、补充指令中断与恢复、跨源写入拒绝及上游角色帧生成。浏览器验证角色选择、轮次详情、视图切换、镜头控制与窄屏布局。

本次验证结果：14 项自动化测试通过；桌面和 390px 手机布局通过检查，浏览器控制台无错误。独立模拟宿主驱动的浏览器验收实际点击暂停、继续、立即评估与发送补充指令，确认新增任务、文件断言和最终验收完成。真实 Codex 接入沿用此前已完成的端到端验收项目。

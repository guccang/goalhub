# 四步执行流程

1. 点击侧栏独立的「宿主配置与测试」窗口。所有目标共用同一份宿主配置与验证结果，配置一次即可复用。选择宿主、模型；可单独保存，也可直接点击「测试连通性」自动保存并测试。Codex 支持沿用本机登录、无头设备码登录、API Key 登录；Claude Code 支持第三方 Anthropic 兼容 URL、API Key 和模型名称，OpenCode 支持供应商 ID。空密钥保留原值，勾选清除才删除。
2. 点击「测试连通性」。使用与开发相同的公共 agent-runtime 环境，在独立探测目录调用真实模型。只有进程成功退出且返回本次随机校验文本才通过，120 秒超时后停止进程。通过后点击「新建目标」直接输入目标，复用已验证配置并生成任务与测试项目预览。目标草稿可以先填写，切换到全局设置再返回不会丢失。
3. 选择人工确认或自动确认。默认人工确认：规划结束进入 `awaiting_approval`，展示任务描述、关联验收项、测试命令和完成标准；点击「确认计划并开始实现」才放行。自动确认会记录确认事件并直接进入实现。缺少必要信息时先提问，回答后继续规划。
4. 开发、定期评估、修复和最终验收沿用原流程。普通继续、补充指令及服务重启均不能绕过未确认的人工计划。

## 持久化与接口

宿主面板平铺 Codex、Claude Code、DeepSeek Harness、OpenCode 四张卡片，点击切换配置。卡片显示各自最近一次真实测试的结果：可用、不可用、正在测试、测试中断、未测试或配置变更待重测，同时标记全局当前宿主。未测试不等同于未安装或不可用。每个宿主独立查询最新记录，不受最近十条历史列表限制；`host_choices` 保存各宿主的公开模型及配置版本。

- SQLite `host_profile`：当前公开配置及版本；不保存密钥正文。
- SQLite `host_tests`：探测配置版本、宿主、模型、输入、脱敏输出、结果与时间。修改配置后旧版本测试不再允许创建目标。
- 凭据调用公共模块 `saveHostSettings`，保存在当前数据目录的 `host-settings`，页面只展示是否存在。未填写凭据时可沿用宿主本机认证。
- 项目保存 `settings.confirmationMode`、`settings.hostTestId` 及 `plan_approved`；确认过程写入 `plan.awaiting_approval` / `plan.approved` 事件。
- `GET/POST /api/host`：读取及保存宿主；有项目运行时拒绝变更。
- `GET /api/host/credentials?type=codex`：读取指定宿主的脱敏连接设置。
- `POST /api/host/test`：发起测试；通过 `GET /api/host` 读取结果和最近十次历史。
- `POST /api/projects` 必须提供当前配置下通过测试的 `hostTestId`；宿主和模型取自服务端配置。
- `POST /api/projects/:id/approve`：确认就绪计划并开始实现。

旧项目保持原有运行行为。新建项目默认人工确认。配置测试结果表示某一次调用成功，后续凭据过期或额度变化仍会作为真实执行错误记录。

## 本次验证

17 项自动化测试通过，确认接口与创建门槛补充断言后，相关 4 项再次通过。浏览器真实 Codex 测试通过，实际提交目标后停在人工预览，仅有规划轮次；点击确认后才产生开发轮次。测试目标随后主动暂停。自动确认及完整执行完成由可控宿主配合真实 Git、SQLite 和文件断言验证。

设置界面统一使用用户提供的汉仪旗黑，表单文字 15px、说明文字 14px，提高对比度并取消背景模糊效果。测试按钮只在读取设置、提交或已有测试运行时暂时禁用，未保存编辑不会阻止点击测试。

## Codex 与 Claude Code 认证

- Codex 沿用本机登录：兼容已有设置，使用公共模块确定本机凭据目录。
- Codex 无头登录：选择设备码方式，点击「获取设备码并登录」，在显示的 OpenAI 官方页面由用户完成授权。服务端无需浏览器。支持取消、15 分钟超时及页面刷新后继续查看；设备码仅驻留内存，结束后清除。账户需启用设备码登录。
- Codex API Key：选择 API Key 登录，填写密钥并保存。通过 `codex login --with-api-key` 的 stdin 交给 CLI，不使用 shell 拼接或命令参数传密钥。保存仅建立本地登录缓存，实际远端授权仍由「测试连通性」验证。
- 两种新增 Codex 登录分别使用数据目录 `codex-auth/device`、`codex-auth/api`；不覆盖桌面现有登录。运行时使用相同目录和认证方式。凭据不要提交到 Git；项目默认忽略整个 `data/`。
- Claude Code：第三方地址映射为 `ANTHROPIC_BASE_URL`，密钥映射为 `ANTHROPIC_API_KEY`；明确提供密钥时移除继承的 OAuth/Auth Token，模型名支持 `vendor/model`，且应用于子任务默认模型。
- `POST /api/host/login` 发起设备码登录，`POST /api/host/login/cancel` 取消；状态、官方链接与设备码包含在 `GET /api/host` 的 `auth` 中。登录期间禁止测试和改配置；登录开始使旧测试失效。
- SQLite `host_auth_events` 保存配置与登录状态，不保存 API Key、OAuth 令牌或设备码。页面可展开「认证与配置记录」查询。

认证参数参考：[OpenAI 官方认证文档](https://learn.chatgpt.com/docs/auth) 与本机 `agent-runtime` 的 `codex-auth.mjs`、`host-settings.mjs`。

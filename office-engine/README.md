# 完整办公室引擎

从 Munder Difflin 提交 `91015c0e1316572fe1c771ae3ece162ae0bd92c6` 移植完整办公室组件与依赖。原始文件 SHA-256 见 `UPSTREAM.json`。`upstream` 保留原版分层地图、碰撞与 BFS 寻路、角色、咖啡循环、休息区对话、浇花等环境活动、工作屏幕、思考气泡、任务纸条、消息信封、相机和 WebGL 恢复逻辑。

## 网页适配

- `store.ts` 替代桌面应用状态；规划员、开发员、评估员和测试执行器对应真实 GoalHub 角色，不额外生成工作 Agent。
- `bridge.ts` 替代 Electron IPC；纸条数量读取真实任务和待答问题，信封只响应真实新增事件。
- `entry.tsx` 保持 GoalHub 的 OfficeScene 接口。项目切换重建场景，首次打开和重连不重放历史交接。
- 日历打开进度评估，看板打开任务，问号板打开用户问答或补充要求，时钟打开项目控制。原版的关闭桌面窗口动作改为网页控制入口。
- 保留原始办公室地图布局与三个图集，文字继续使用用户提供的 `HYQiHei_75S.ttf`。
- 支持角色点击、镜头缩放、拖动、全景、展开与减少动态。精灵帧由场景统一推进，隐藏、断线、减少动态时停止视觉计时。
- 环境对话、散步与咖啡是原版场景表演，不代表 Agent 在执行任务；页面明确标示这一点。

构建：`npm ci` 后执行 `npm run build:office`。输出到 `public/office-engine`，已纳入 Git，正常启动服务不要求现场构建或连接 CDN。

## 许可与署名

源码遵循上游 MIT 许可，见 `LICENSE`。原地图与家具图集来自上游内置资产：**Modern Interiors — LimeZu**，素材许可独立于代码 MIT，见 `LICENSE-ASSETS`、`upstream/assets/ATTRIBUTION.md` 和 `upstream/assets/tilesets/LIMEZUASSETS-LICENSE.txt`。素材许可明确限制单独转售或分发素材，不应将图集作为独立素材包发布。

作者：[Munder Difflin / Chaitanya Giri](https://github.com/chaitanyagiri/munder-difflin)。像素素材：[LimeZu](https://limezu.itch.io/)。页面底部保留作者、素材作者及许可链接。

## 验证结果

17 项业务测试与 3 项场景测试通过；资源 HTTP 接口及路径越界检查通过。浏览器验证了完整地图、四个真实角色、原角色点击、看板导航、展开、减少动态与相机控制，无控制台错误。

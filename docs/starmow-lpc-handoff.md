# 星球割草：本地 Universal-LPC 角色接入交接

## 用户本轮要求

使用已经优化好的本地 Universal-LPC 衣柜资源创建像素角色，提高星球割草的视觉品质。主管负责更新当前计划、分派设计与开发接入、安排验证；保留既有玩法、角色属性、存档和已授权范围。这里的 8 个名称是外观样例，不要求新增 8 个玩法职业。将 LPC 美术替换如实记录为用户最新授权，不再以“不是原版美术”阻断，也不宣称是原版素材。

## 已准备的稳定路径

| 内容 | 路径 |
| --- | --- |
| 已优化的本地项目 | `F:\Documents\ChatGPT\Universal-LPC` |
| 换装工作台 | `http://127.0.0.1:5173/wardrobe.html` |
| 导入 ZIP 的播放器 | `http://127.0.0.1:5173/demo.html` |
| 本次资源包根目录 | `F:\Documents\ChatGPT\goalhub\data\assets\universal-lpc\starmow-20260929` |
| 角色索引 | 上述目录的 `asset-index.json` |
| 角色总览 | 上述目录的 `preview.png`、`preview.html` |
| 原始图层与定义 | LPC 项目下的 `spritesheets`、`sheet_definitions`、`palette_definitions` |
| 衣柜配置、渲染与打包接口 | LPC 项目下的 `sources/wardrobe/model.ts`、`render.ts`、`bundle.ts`、`manifest.ts` |

导出源版本：`b17a262bd9359c55e76ccd9217b6b244078de8ae`。本次直接调用本地衣柜的 CatalogReader、渲染器和 exportBundle/readBundle；没有另外下载一套上游素材，也没有修改本地衣柜源码。生成器完整授权说明见该项目 `README.md`；实际选用素材的作者、来源与许可证随每个角色包导出。

## 可直接取用的角色资产

| 目录 / ZIP 名 | 外观名称 | 体型 | 持武器展示版 |
| --- | --- | --- | --- |
| `scout` | 星蓝侦察兵 | male | 弩 |
| `vanguard` | 赤铜先锋 | male | 长矛、皮甲 |
| `engineer` | 琥珀工程师 | male | 弹弓 |
| `sentinel` | 银甲守卫 | male | 匕首、板甲 |
| `arcanist` | 紫晶术士 | female | 法杖 |
| `ranger` | 翠羽游侠 | female | 弩 |
| `raider` | 绯红突击手 | female | 匕首 |
| `medic` | 霜白支援者 | female | 法杖 |

每个目录含：

- `outfits/outfit-1.png`：穿好服装的无武器整图，优先用于游戏战斗，现有自动攻击、环绕武器独立表现。
- `outfits/outfit-2.png`：相同角色的持武器整图，适合角色选择和展示；如用于战斗，不要重复叠加另一把相同武器。
- `layers/*.png`：完整透明图层，按 manifest 的 zPos 顺序组合。每个 outfit.layers 已包含身体，不要再叠一次 base.layers。
- `manifest.json`：尺寸、图层、动作行号、帧循环和每套装束实际支持的动作。
- `project.json`：可重新导入衣柜编辑的角色配置。
- `CREDITS.txt`、`credits.json`：本角色实际用到的素材署名、来源和许可。游戏内应有可发现的署名入口，交付包保留这些文件。
- `demo.html`：解压后可直接离线查看的独立播放器，不依赖 5173 服务。
- 同名 ZIP 位于资源根目录，保留完整导出内容。

`base.png` 仅为未装备身体，不是游戏角色最终成品；游戏请使用 outfits 中的已着装版本。

## Godot 接入约定

1. 将所选 PNG、manifest 和署名复制进星球割草当前工作目录，例如 `assets/characters/lpc/`。正式游戏不可依赖本机 F 盘绝对路径、5173 服务或外部资源目录；安装包必须包含实际资源。
2. 整图为 **832×3456**，单帧 **64×64**，即 13 列、54 行。朝向索引严格为 `up, left, down, right`，不是常见的下左上右。
3. 行号与列循环以 manifest 为准：walk 起始行 8，循环列 `[1,2,3,4,5,6,7,8]`；idle 起始行 22，循环列 `[0,0,1]`。帧区域是 `(column*64, (row+direction)*64, 64, 64)`；单方向动作不额外加 direction。
4. 使用 nearest 像素采样，统一显示比例与脚底锚点，避免线性采样模糊、走路漂移、武器裁切。碰撞和玩法坐标沿用当前逻辑，不把 64×64 透明边距当成实际碰撞范围。
5. 只播放 `outfits[].animations` 列出的动作；顶层 animations 是格式总表，不代表每套装束全部支持。持武器装束的动作交集明显较少，例如弩装束没有声明 shoot，不能据此编造攻击动画。
6. 本批 8 个角色的两套装束均具备 idle/walk。无武器版同时有 run 及多种攻击动作；实际清单详见索引。**本批没有声明 hurt/climb**，受击、死亡使用现有效果或由美术选择兼容素材补足；禁止强行播放空行。
7. 当前游戏可视入口是工作目录的 `game/main.gd`。主管按真实代码安排绘制、角色选择卡和多人区分标记的接入；对高密度敌群注意纹理复用，避免每帧创建纹理或切图。

## 主管执行与验收要求

- 更新当前目标剩余计划，由设计确认外观与原角色的映射，开发完成角色选择界面与实际战斗中的资源替换；不是仅把 PNG 放进仓库或只做展示页。
- 保留当前修复成果和需求范围，处理已有验收失败后再执行本轮视觉与游戏回归。已修复的渲染清理问题不应因接入新角色再次出现。
- 实际检查角色选择、四方向移动、待机、攻击/武器、受击/死亡及多人辨识；截取选择界面和真实战斗的前后对比图，确认角色可见、没有空帧、没有错行或截断。
- 重新检查标准局、存档/重启恢复和多人基础操作，不因换素材修改原玩法规则。测试应验证动作切换和真实像素内容，而非仅断言文件存在。
- 源码和证据变化后按平台“构建/安装验证/Acceptance → 审查员审查 → Review 校验”完成交付；不要只手改哈希或绕过独立审查。

## 本次准备工作的边界和复用

已导出并校验资源包协议、PNG 尺寸、动作边界、署名和 idle/walk 支持；浏览器验证脚本从现有 Demo 重新导入全部 8 个 ZIP，16 套装束、64 个方向组合及动画播放均通过，并已人工式目视核对角色总览。资源准备不等于已经完成 Godot 接入，实际游戏效果由主管安排员工验证。

GoalHub 仓库内的复用脚本：

```powershell
# 在已打开本地衣柜的独立 Playwright CLI 会话里导出，不改用户原会话。
npx --offline --package @playwright/cli playwright-cli -s=lpc-handoff open http://127.0.0.1:5173/wardrobe.html
npx --offline --package @playwright/cli playwright-cli -s=lpc-handoff run-code --filename scripts/export-lpc-handoff.playwright.cjs
node scripts/prepare-lpc-handoff.mjs output/playwright/lpc-pack data/assets/universal-lpc/starmow-20260929
npx --offline --package @playwright/cli playwright-cli -s=lpc-handoff goto http://127.0.0.1:5173/demo.html
npx --offline --package @playwright/cli playwright-cli -s=lpc-handoff run-code --filename scripts/verify-lpc-handoff.playwright.cjs
```

最后一个脚本的资源根目录是本机固定交接路径，迁移到其他机器时先修改该配置。素材导出仅复用现有 Node 依赖，不需要重装本地 Universal-LPC。

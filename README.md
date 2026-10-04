# F1race

像素风 2D 俯视单机赛车。封闭环型赛道跑 3 圈，WASD 驾驶，按整场总时间刷新最佳成绩。
**当前阶段：M5**（M1 可驾驶原型 → M2 精确计时 → M3 漂移 → M4 幽灵车 → M5 AI 与结算）。

---

## 快速开始

```bash
# 安装依赖（只能用 pnpm）
pnpm install
# npm.cmd install        # Windows 上 PowerShell 会拦住 npm.ps1，所以要用 npm.cmd

# 开发服务器（http://127.0.0.1:5180/）
pnpm dev

# 构建 + 本地预览（http://127.0.0.1:5181/）
pnpm build
pnpm preview

# 验收一条龙：类型检查 + 单元测试 + 构建 + 浏览器 e2e
pnpm verify
```

> 构建产物是纯静态站点：`dist/` 可以直接丢到任意静态服务器或子目录下（`vite.config.ts` 里 `base: './'`）。

### 调试开关

在 `http://127.0.0.1:5180/?debug=1` 打开物理碰撞体与中心线可视化。
`?lottery=test` 把**抽奖**中奖率提到 99%，方便验收"中奖 → 解锁皮肤"这条链路
（默认中奖率 0.35，见 M6 小节与 CR-08）。

---

## 操作

| 按键 | 功能 |
| --- | --- |
| `W` / `↑` | 油门 |
| `S` / `↓` | 刹车；静止时按住为倒车 |
| `A` `D` / `←` `→` | 转向 |
| `Space` | **漂移**（抓地力下降、侧滑角增大，松开后恢复） |
| `G` | **车库**（皮肤选择；打开时会暂停比赛） |
| `R` | 重新比赛 |
| `Esc` / `P` | 暂停 / 继续 |

起跑为 `3 - 2 - 1 - GO!` 倒计时，归零瞬间玩家与 3 台 AI 同时解锁。
难度（简单 / 普通 / 困难 / **炼狱**）在屏幕底部中间切换，只能在发车前改（改难度会重开比赛）。
车库入口在这条栏的最右侧（也能按 `G`）。

---

## M6 已实现的内容（车辆皮肤 CR-15 · 单程赛道 CR-16）

皮肤是纯外观：**零数值、零成绩影响**。它是本作唯一的可累积收集品，由抽奖产出。

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **6 款皮肤** | `default` 原厂 / `red` 烈焰红 / `blue` 深海蓝 / `carbon` 碳纤维 / `ghost` 幽灵白 / `gold` 黄金 | `src/game/Skins.ts` |
| **皮肤即调色板** | 皮肤不是新画的素材，而是**同一套程序化生成流程换配色**（`buildCar()`，8 个部件 × 42 条描边参数） | `tools/gen-assets.mjs` 里的 `SKIN_PALETTES` |
| **抽奖产出** | **刷新本赛道最佳总时间 或 拿到冠军** → 老虎机中奖 → 按 `TUNING.skins.dropTable` 权重抽一款并解锁 | `RaceScene.handleLotterySettled()` |
| **中奖即提示** | 中奖后立刻在结算面板上说明"解锁了哪一款"，不用玩家自己去车库翻 | `Skins.unlockSkin()` + `Hud.showLotterySkin()` |
| **车库** | 6 张卡片；未拥有的一眼看出（灰掉 + 锁）；点已拥有的立刻换装，不用重开比赛 | `src/game/Garage.ts` + `index.html#garage` |
| **独立存储键** | `f1race.skins.v1`，与成绩存档（`f1race.save.v3`）完全解耦 —— 操控规则升版会清空纪录，但外观解锁不该跟着丢 | `src/game/SkinStore.ts` |
| **抽奖开关** | `TUNING.lottery.enabled` **发布默认开启**（抽奖是皮肤的唯一产出通道）；`winRate` 0.35、**不得是 0.99**（CR-08 硬要求）；`?lottery=test` 把中奖率提到 99% 供验收 | `TUNING.lottery` |

> **抽奖什么时候出现**：`RaceResult.lotteryEligible = beatPersonalBest || wonRace`。
> 两个条件是独立的 —— "跑出个人第二好成绩但拿了第一"也该有奖励，
> 而"赢了却没有反馈"比没有奖励更伤。判据在场景里算好带出来，不让结算界面自己推一遍。

> **抽奖动画不许剧透**：转动期间只有一句恒定的「转动中…」，
> 结论（文案 / 颜色 / 庆祝类）一律在三条转轮都停稳之后才出现。
> 这条有 e2e 守着 —— 只断言"停稳后的结论正确"是抓不到剧透的。

**CR-16 单程赛道（点对点）**：赛道不必首尾相接。

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **开放路径** | meta 里 `open: true` 时弧长在两端**夹住**而不是绕回；`pointAtArc` / `normalizeArc` 都遵守 | `Track.ts` / `LapTimer.ts` |
| **一趟即完赛** | `laps: 1`；冲过终点即结算，进度钉在 100% | `LapTimer.completeLap()` |
| **圈数跟赛道走** | `RaceScene` 里 8 处 `TUNING.race.laps` 全改成读 `track.lapCount` / `track.isOpen` | `Track.lapCount` |
| **进度语义** | 单程不显示"第 N 圈"，HUD 与排名改用「进度 / 本趟用时」；未完赛的车显示「进行中」 | `RaceStandings.progressLabelFor()` / `Hud.setLapMode()` |
| **画赛道的新流程** | 手绘草图 → 灰度图 → 骨架化 + Dijkstra 取路径 → RDP 抽稀 → 生成 Tiled JSON，全程可复现 | `tools/sketch-open-path.mjs` 等 8 个脚本 |

> ⚠️ **连续性查询**：每帧推进计时读的是 `Track.arcNear()`（只看上一帧位置附近，
> 并拒绝"物理上不可能"的读数），不是"全图最近点"。
> 全局最近点在发夹弯里会把"冲出赛道压草地"算成一次巨大的进度跳跃，整圈被误判切弯。
> 详见 `tests/track-geometry.test.ts` 与 known-issues 第 22 / 26 条。

---

## M5 已实现的内容（AI 对手 · 难度 · 碰撞 · 结算）

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **3 台 AI 同场** | 各自独立的前视点纯追踪 + 曲率限速，发车格错开排在玩家后面 | `src/game/AIDriver.ts` |
| **脱困状态机** | `blocked` 或连续 900ms 低速 → 倒车 + 反向打舵 → 对线期 → 复位，不会长期卡墙 | 同上 |
| **四档难度** | 简单 / 普通 / 困难 / **炼狱**（2026-10-04 追加）。只用速度上限 / 转向精度 / 失误率区分，**不做橡皮筋、不瞬移** | `src/game/Difficulty.ts` + `TUNING.difficulty` |
| **炼狱档** | 速度上限用满 1.0、走线偏移 0、反应 30ms、整场几乎不失误。实测比困难快 1.0~2.1 秒，四档在三张图上都是**零贴墙** | 同上 |
| **确定性失误** | 带 seed 的随机数驱动"偶发走神"，同 seed 完全可复现 | `AIDriver` |
| **实时排名** | 按「完赛优先 → 完赛时间 → 总进度」排序，HUD 常驻 4 行榜单 | `src/game/Ranking.ts` |
| **结算排名** | 结算界面给出最终名次表（含未完赛者的圈数） | `Hud.showResult()` |
| **车与车碰撞** | 玩家-AI、AI-AI 均减速 + 弹开（REQ-014，M5 才真正被触发） | `RaceScene.onVehicleCollision()` |

---

## M4 已实现的内容（幽灵车）

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **录制** | 刷新最佳总时间且成绩有效时，把整场驾驶过程**按严格等距的 50ms 网格**重采样存进存档 | `src/game/Ghost.ts` |
| **同场回放** | 半透明幽灵车与玩家同时起跑（不是分屏），位置/朝向按时间插值 | 同上 |
| **同速保证** | 录制时把位姿插值到网格整点（而不是"发现超时就记一笔"），回放才与录像同速 | `GhostRecorder.capture()` |
| **无碰撞** | 幽灵车没有物理体，玩家与 AI 都不会被它影响（REQ-018） | `RaceScene.installGhost()` |
| **时间差** | HUD 显示与幽灵车的领先/落后 | `Hud.setGhostStatus()` |

---

## M3 已实现的内容（漂移）

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **漂移状态机** | 抓地/侧滑两套纵向模型 + 侧滑角积分 + 回正 + 打滑惩罚 | `src/game/VehicleDynamics.ts` |
| **手感开关** | 按住 `Space` 打方向：车尾甩出去、侧滑角可见（HUD 左下角），松开回正 | 同上 + `TUNING.vehicle.drift` |
| **不破坏基础手感** | 不按 `Space` 时物理与 M1 逐位一致，漂移只是"多一层状态" | 同上 |
| **与 M1 的逐位回归** | 用 `Object.is` 钉住 M1 的数值输出（4 组场景 × 600 帧） | `tests/drift.test.ts` |

---

## M2 已实现的内容（精确计时与存档）

M2 的核心不是"显示一个时间"，而是**过线时刻必须准**，且成绩可信。

| 能力 | 说明 | 实现位置 |
| --- | --- | --- |
| **帧内插值过线** | 用一帧内的插值算出真正的过线时刻，而不是记帧边界（60FPS 下一帧 16.7ms 的抖动就够毁掉成绩） | `src/game/LapTimer.ts` |
| **进度跳跃判定** | 每帧比对弧长增量，超出物理可能就判本圈"切弯"无效 | `LapTimer.update()` |
| **实时 delta** | 与最佳圈的分段对比（共 24 个检查点），HUD 显示领先/落后 | `LapTimer` + `Hud.setDelta()` |
| **分段计时** | S1/S2/S3，各自与最佳对比 | 同上 |
| **成绩历史** | 每赛道保留最近 10 条（含无效场次与原因） | `src/game/SaveStore.ts` |
| **存档 v2 → v3 迁移** | 旧档能读、能升版；操控规则升版会清纪录 | `SaveStore.read()/migrate()` |
| **暂停** | Esc / P 暂停，暂停期间计时零增长 | `RaceScene.pauseRace()` |
| **结算面板** | 领奖台（冠军跳动）+ 本场自我表现 + 是否超越自己 + 无效原因 | `Hud.showResult()` |

---

## M1 已实现的内容（可驾驶原型）

| 验收项 | 实现位置 |
| --- | --- |
| 1. 像素风渲染 | `src/main.ts`（`pixelArt` / `antialias: false` / `roundPixels`）+ `src/style.css`（`image-rendering: pixelated`） |
| 2. 程序化生成赛道 | `tools/gen-track.mjs` 产出 `public/assets/maps/track1.json`（ground / track / decor / walls） |
| 3. 车辆与驾驶 | `src/game/Vehicle.ts` + `VehicleDynamics.ts`：油门/刹车/倒车、速度相关转向、越速惩罚 |
| 4. 镜头跟随 | `src/game/scenes/RaceScene.ts`：平滑跟随 + `setRoundPixels(true)` |
| 5. 草地减速 40% | `VehicleDynamics.step()` 按表面系数缩放 + 进出草地的恢复时间 |
| 6. 撞墙与碰撞 | `Vehicle.handleContacts()`，车与车在 `RaceScene.onVehicleCollision()`（M5 起有 3 台 AI） |
| 7. HUD | `src/game/Hud.ts` + `index.html`：车速 / 挡位 / 圈数 / 圈速 / 最佳圈 / 分段 / 最佳总时间 / 排名 / 难度 / 漂移 / FPS / 无效标记 |
| 8. 3-2-1-GO 发车 | `RaceScene.tickCountdown()` |
| 9. 成绩落盘 | `src/game/SaveStore.ts`（`localStorage`，M5 起为 `f1race.save.v3`） |
| 10. 占位素材生成 | `tools/gen-assets.mjs` + `docs/placeholder-assets.md` |

---

## 目录结构

```
F1race/
├─ index.html                     画布 + HUD / 车库 / 抽奖 DOM
├─ vite.config.ts                 端口 5180(dev) / 5181(preview)，base './'
├─ tools/
│  ├─ png.mjs                     最小 PNG 编码器（只用 node:zlib，无依赖）
│  ├─ gen-assets.mjs              程序化生成车辆与瓦片素材
│  ├─ gen-track.mjs               生成 Tiled JSON 与赛道元数据
│  ├─ preview-assets.mjs          把占位素材放大拼图，便于人工检查
│  ├─ e2e-check.mjs               浏览器端自动验收（Playwright）
│  ├─ public/assets/
│  │  ├─ tiles/tileset_placeholder.png
│  │  ├─ cars/car_{player,ai,ghost}_placeholder.png
│  │  ├─ cars/player_{default,red,blue,carbon,ghost,gold}.png   CR-15 的 6 款皮肤贴图
│  │  └─ maps/track1.json, track1.meta.json
├─ src/
│  ├─ main.ts                     Phaser 启动与场景注册
│  ├─ style.css                   像素风 HUD 样式
│  └─ game/
│     ├─ constants.ts             全部可调参数（手感、镜头、圈数、存档键、皮肤掉落表、抽奖开关）
│     ├─ types.ts                 赛道元数据 / 存档 / 结算类型
│     ├─ Track.ts                 中心线几何 + 进度查询
│     ├─ TrackGeometry.ts         中心线几何（纯逻辑，不 import Phaser）
│     ├─ Vehicle.ts               车辆实体与接触处理
│     ├─ LapTimer.ts              M2 的计时核心（帧内插值 / 分段 / 无效判定 / delta），不 import Phaser
│     ├─ SaveStore.ts             localStorage 存档（v2 迁移 + v1 兼容）
│     ├─ Skins.ts                 CR-15 皮肤定义 + 白名单校验（不 import Phaser）
│     ├─ SkinStore.ts             CR-15 皮肤解锁存储（`f1race.skins.v1`）
│     ├─ Garage.ts                CR-15 车库面板（纯 DOM，不 import Phaser）
│     ├─ SlotMachine.ts           抽奖老虎机演出（onSettled 回调交给场景）
│     ├─ Minimap.ts               小地图（独立 canvas，不参与主渲染）
│     ├─ Podium.ts                结算领奖台
│     ├─ format.ts                时间/差值格式化
│     ├─ InputController.ts       键盘输入
│     ├─ AutoPilot.ts             自动驾驶（验收用；M5 的 AI 是另一套）
│     ├─ Hud.ts                   HUD / 结算 / 抽奖 / 车库的 DOM 层
│     └─ scenes/{BootScene,RaceScene}.ts
└─ tests/                         单元测试（Node 自带 test runner）
```

---

## 赛道

赛道由脚本生成，不要手改 `public/assets/maps/*`。`node tools/gen-track.mjs` 会重生成。

| id | 名称 | 圈数 | 长度 | 最急弯 | 世界尺寸 | 特点 |
| --- | --- | --- | --- | --- | --- | --- |
| `track1` | 环城赛道 | 3 圈 | 7532px | 124px | 120×80 | 入门；长直道 + 若干中速弯 |
| `track3` | 峡谷技术环 | 3 圈 | 10261px | 137px | 168×88 | 连续弯、落差大 |
| `track4` | **漂移龙** | **1 趟** | 20660px | 67px | 186×118 | 单程；长距离复合弯 + 发夹 + 窄 S |

`track4` 是**单程（点对点）**赛道：起点与终点不重合，跑一趟即完赛，不累计圈数。
它也是第一条 `meta.open: true` 的赛道：

- 弧长在两端**夹住**（不取 `% total`）；
- 元数据 `laps: 1`，跑完即结算；
- 未完赛的车显示「进行中」而不是「第 N 圈」。

走廊宽度固定为 **147px**（±5 格）：`ground` 是底、`track` 是路面、`decor` 是装饰、`walls` 是护栏。

**新增赛道的流程**：

1. 生成 Tiled 地图 `public/assets/maps/<id>.json`（瓦片层同上）；
2. 生成 `public/assets/maps/<id>.meta.json` 里的 `centerline.points`（中心线，AI 的路线依据）、
   `start`、`surface.trackGids`（哪些 gid 算路面）、`laps`、`open`；
3. 把 id 接进 `Track.ts` 的赛道清单与 `index.html` 的按钮。

改完一定要跑 `node tools/gen-track.mjs`，再检查一遍几何。
**自检**：`node tools/preview-track.mjs <id>` 看渲染，`node tools/check-tracks.mjs` 看几何硬指标。

**从手绘草图做一条新赛道**：`track4` 就是这么来的 ——
`tools/rasterize-sketch.mjs` 把手绘 PNG 转成灰度图，
`tools/sketch-open-path.mjs` 走骨架化 + Dijkstra + RDP 得到中心线，`sketch-centerline.mjs` 做可视化。
`tools/apply-dragon.mjs` 负责落地，落完再用 `preview-track.mjs` 与 `check-tracks.mjs` 验，
`probe-open-ai.mjs` 验 AI 在单程图上的实际表现。全过程见 `docs/cr16-drift-dragon-handoff.md`。

---

## 调参

车辆手感集中在 `src/game/constants.ts` 的 `TUNING.vehicle`：

| 参数 | 作用 |
| --- | --- |
| `maxSpeed` | 极速（px/s） |
| `engineAccel` / `dragK` | 发动机推力与空气阻力（两者一起决定加速曲线） |
| `brakeDecel` / `reverseRatio` | 刹车减速度与倒车速度比例 |
| `maxSteerRate` / `steerSpeedRef` / `highSpeedSteerLoss` | 转向速率、高速转向衰减；**这条同时决定 AI 的过弯速度上限** |
| `overspeedDecel` | 超过极速后的额外减速度（防止漂移/下坡越速） |
| `collisionSpeedKeep` / `knockSpeed` / `collisionScrub` | 碰撞后的保速比例、弹开速度、擦墙减速 |
| `bodyRadius` | 碰撞半径 |

草地参数不在 constants 里，而在赛道元数据中：`public/assets/maps/track1.meta.json` 的
`surface.grassSpeedFactor`（0.6）与 `grassRecoverSeconds`（1.6）。

计时与判定参数在 `TUNING.race` / `TUNING.save`：

| 参数 | 作用 |
| --- | --- |
| `sectorCount` / `checkpointsPerSector` | 分段时间数与检查点密度（总检查点 = 3 × 8 = 24）；delta 与分段都基于它 |
| `progressJumpTolerance` / `progressJumpSlackPx` | 无效圈判定阈值（**切弯**判定）。想让判定更宽松就调大 |
| `TUNING.save.historyLimit` | 本地保留的成绩条数（默认 10） |

> 「切弯」判定读的是**每帧的弧长增量**，而这个增量来自 `Track.arcNear()`（连续进度查询），
> 不是全图最近点。这条不是调参问题而是正确性问题：全图最近点会让"过弯冲出赛道压了草地"
> 被算成一次巨大的进度跳跃（known-issues 第 22 / 26 条）。

**圈数不在 `TUNING.race.laps` 里**（那个字段只剩测试与 measure-ai 在用）：它跟着赛道走 ——
`public/assets/maps/<id>.meta.json` 的 `laps`（闭环 3、单程 1），运行时由
`Track.lapCount` 透出，场景与排名全读它。单程赛道另看 `meta.open`。

AI 难度在 `TUNING.difficulty.<easy|normal|hard|inferno>`。**调这一块必须真跑**，别靠推理：

| 命令 | 作用 |
| --- | --- |
| `node --import ./tools/ts-register.mjs tools/tune-ai.mjs` | 全部赛道 × 四档，输出完赛时间 / 贴墙 / 脱困 / 漂移帧数 |
| `node --import ./tools/ts-register.mjs tools/tune-ai.mjs track4 --sweep` | 扫参数组合，找"更快"的那一档 |
| `node --import ./tools/ts-register.mjs tools/probe-open-ai.mjs track4` | 单程赛道专项（**不要**用 measure-ai 跑单程图，它按闭环算，会给出假数据） |

⚠️ 两个已经量过的结论，别再重复试：

- **`corneringGrip` 在高速档上基本是空的**：过弯速度由 `steerAuthorityLimit()`（转向机能力）
  决定，把 grip 从 1550 提到 8000 圈速只动 0.1~0.2s。真正有效的是 `speedCapRatio`（直线速度）。
- **让 AI 漂移是负收益**：三张图上打开后分别慢 0.13 / ±0 / 0.40 秒。
  漂移有额外纵向阻力，而 AI 的过弯本来就不是抓地力不够。`useDrift` 四档全关。

赛道的几何硬指标在 `tools/gen-track.mjs` / `tools/check-layout.mjs` 顶部：

| 参数 | 作用 |
| --- | --- |
| `MIN_RADIUS_PX`（45） | 中心线最小转弯半径；低于它车根本拐不过来，AI 会反复撞墙 |
| `MIN_SEPARATION_TILES`（4.5） | 非相邻路段的最小间距（格）；防止走廊自交 |
| `MIN_SEPARATION_ARC_SKIP_TILES`（12） | **与上一条配套的排除窗口**：沿路间隔小于它的两点不算"两段路"。它必须大于走廊宽度，否则同一个弯的两侧会被误判成自交（known-issues 第 19 条） |

漂移手感在 `TUNING.vehicle.drift`：

| 参数 | 作用 |
| --- | --- |
| `gripRate` / `driftGripRate` | 抓地与漂移两种状态下的横向抓地速率，比值决定"能滑多远" |
| `driftSteerBoost` | 漂移时的转向倍率。**调大 → 车头转得更快**，容易甩过头 |
| `driftLateralPush` | 侧滑推力。**调大 → 侧滑角更大**，观感更猛但更难控 |
| `driftSpeedScrub` | 漂移的额外纵向阻力（这是"漂移更慢"的来源） |

AI 参数在 `TUNING.difficulty.easy / normal / hard / inferno`，AI 通用参数在 `TUNING.ai`，
幽灵车在 `TUNING.ghost`，存档版本号在 `TUNING.save.rulesetVersion`
（**改了操控规则就 +1**，旧纪录会被清掉，防止不同规则下的成绩混在一起比）。

皮肤与抽奖在 `TUNING.skins` / `TUNING.lottery`：

| 参数 | 作用 |
| --- | --- |
| `TUNING.skins.dropTable` | 掉落权重表。`default` **必须权重为 0**（它本来就是初始皮肤，抽到等于没中）；真正的白名单是 `SKINS` / `SKIN_PALETTES` / `SKIN_ASSET_SUFFIXES` 三张表 |
| `TUNING.skins.duplicateReward` | 重复抽到同一款时的处理。当前是 `'notice'`，即明确告诉玩家"你已经有这款了"（静默吞掉是最容易被记恨的做法） |
| `TUNING.lottery.enabled` | 抽奖总开关，**发布默认开启**（CR-08 只硬性要求"默认中奖率不得是 0.99"，那条仍然成立） |
| `TUNING.lottery.winRate` | 发布默认中奖率 0.35，**不得是 0.99** |
| `TUNING.lottery.testWinRate` | `?lottery=test` 时用 0.99，供自动化验收"中奖 / 未中奖"两条路径 |

---

## 开发与验收

```bash
pnpm verify      # typecheck + 单元测试 + 构建 + e2e，一条命令跑完
```

也可以单独跑：

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | TypeScript 严格模式检查 |
| `pnpm test` | 单元测试（Node 自带 test runner，无需浏览器） |
| `pnpm e2e` | Playwright 浏览器验收（**需要先 `pnpm build`**） |
| `pnpm doc:stats` | 重新统计覆盖率与测试数（`--write` 才会写回文档） |

<!-- doc-stats:start -->
<!-- 这一段由 `npm run doc:stats` 生成，请勿手改。生成时间 2026-10-04。 -->

| 项目 | 数值 |
| --- | --- |
| 版本 | `0.6.0` |
| 单元测试 | **330/330 通过**（72 个 suite） |
| 单元测试分项 | skins 36 / save 35 / race-standings 32 / ai 30 / drift 27 / car-contact 24 / ghost 23 / timer 15 / race-director 14 / race-hud-sync 14 / ranking 14 / ghost-runner 13 / format 10 / open-track 8 / track-geometry 8 / track-save 6 / ghost-timebase 5 / minimap 5 / version 5 |
<!-- 分项是"每个文件写了几个 `it(`"，所以和总数**不等**：timer.test.ts 用 15 个 `it(` 循环生成 39 个用例，静态计数必然偏小。总数以 TAP 的 `# tests` 为准，分项只用来看"哪个模块测得多"。 -->
| 浏览器 e2e | **146/146 通过** |

<!-- doc-stats:end -->

e2e 覆盖：启动、操作、视角、草地、漂移、三圈计时、分段/delta/暂停、无效圈（抄近道）、
AI 难度、幽灵车、结算、抽奖（含"转动期间不剧透结果"）、车库、皮肤、单程赛道、
以及"压草地不误判切弯"。截图产物在 `tools/screenshots/`。

> 单元测试直接跑 TypeScript 源码（Node 22 的原生类型剥离 + `tools/ts-resolve-hook.mjs`），
> 不需要 `.ts` 编译步骤，所以纯逻辑模块（计时 / 存档 / 几何 / AI / 皮肤）都能直接测，
> 且这些模块**不允许 import Phaser**。

调试接口（浏览器控制台 / e2e 用）：

```js
window.__F1RACE__.getState()              // 当前状态：圈数 / delta / 进度 / 名次 / AI / 抽奖配置
window.__F1RACE__.setAutopilot(true)      // 自动驾驶
window.__F1RACE__.setAiEnabled(false)     // 关掉 AI 对手
window.__F1RACE__.setDifficulty('hard')   // 切难度（会重开比赛）
window.__F1RACE__.skipCountdown()         // 跳过倒计时
window.__F1RACE__.setInput(1, 0)          // 直接注入输入：油门 / 转向
window.__F1RACE__.setDrift(true)          // 强制漂移
window.__F1RACE__.pause() / resume()      // 暂停 / 继续
window.__F1RACE__.teleportToProgress(0.5) // 瞬移到 50% 处（会重新对齐进度基准）
window.__F1RACE__.cheatTeleport(0.5)      // 瞬移但**故意制造进度跳跃**（测切弯判定用）
window.__F1RACE__.place(x, y, heading, speed)
window.__F1RACE__.restart()               // 重开
window.__F1RACE__.clearSave()             // 清空成绩
window.__F1RACE__.openGarage()            // 打开车库（CR-15，会暂停比赛）
window.__F1RACE__.closeGarage()           // 关掉车库
window.__F1RACE__.equipSkin('gold')       // 换皮肤（未拥有会返回 false）
window.__F1RACE__.getSkins()              // 皮肤状态：owned / equipped / isPersistent
window.__F1RACE__.getPlayerPhysics()      // 玩家物理快照 + 贴图键（"皮肤不影响成绩"靠它做深比较）
```

---

## 重新生成素材

占位素材与赛道都是脚本生成的；生成规则与命名见
[`docs/placeholder-assets.md`](docs/placeholder-assets.md)。
不要手改 `public/assets/` 下的 PNG —— 会被下次生成覆盖。

```bash
node tools/gen-assets.mjs     # 瓦片 + 3 种车 + 6 款皮肤（CR-15）
node tools/gen-track.mjs      # 瓦片地图 + 中心线元数据
node tools/preview-assets.mjs # 放大拼图到 tools/out/preview.png，人工检查
```

---

## 相关文档

已知问题、踩坑与设计取舍见 [`docs/known-issues.md`](docs/known-issues.md)。

## 变更记录

2026-10-03 起按里程碑整理（P0→P3），含需求 / 验收 / 设计取舍，见
[`docs/change-requests.md`](docs/change-requests.md)。

## 备注

- 验收命令：`pnpm verify`（类型检查 + 单元测试 + 构建 + 浏览器 e2e）。
  提交前请确保它全绿；单程赛道（漂移龙）与三张闭环图的 AI 表现都在 e2e 里有断言。
- 版本号唯一来源是 `package.json`，由 `tests/version.test.ts` 守住。
- 需求条目的完整清单与人工试玩清单见 [`docs/acceptance.md`](docs/acceptance.md)。
- M3/M4/M5 的接口契约与设计取舍见 [`docs/m3m5-interfaces.md`](docs/m3m5-interfaces.md)。
- 截图产物在 `tools/screenshots/`：
  `01-countdown` / `02-go` / `03-grass` / `04-wall` / `05-result` / `06-delta` / `07-pause`
  / `08-invalid` / `09-drift` / `10-ai` / `11-ghost` / `12-lottery` / `13-garage` / `14-lottery-skin`。

# CR-16「漂移龙」单程赛道 — 交接文档

> **状态：本文件里 §6 的三块（间距、引擎支持单程、接进游戏）已于 2026-10-04 完成。**
> 接手记录（与本文档不同的做法都写在这里，其余照旧）：
>
> - **§6.1 那个 4.28 格不是"两条路贴在一起"**，而是判定器自己的缺陷：
>   "沿路间隔多少以内算同一段路"的窗口（`4.5×32×1.02 ≈ 147px`）**比走廊宽度
>   （`2×2.3×32 = 147.2px`）还短**，于是同一个弯的两侧被当成两条路。
>   窗口改成 12 瓦片后，三张图的最近间距分别是 10.80 / 12.09 / **10.23** 瓦片，
>   全部远高于下限；**下限 4.5 没有动**。详见 `docs/known-issues.md` 第 19 条。
>   顺带把右侧那个回折改成了**显式半圆**（圆心 (171.0, 98.4)、R=6.35 瓦片）——
>   正圆半圆回折的中心线最近间距恒等于 2R，几何上不可能再触发这条检查。
> - **§6.2 引擎**：`LapTimer` 的 `open` 分支只做两件事（弧长不归一、跨过 total 即完赛），
>   闭环路径未改动；`RaceScene` 的 7 处（不是 8 处）`TUNING.race.laps` 全部改读
>   `track.lapCount`，另有 1 处在 `progressLabel` 里改成了回调
>   （`RaceStandings.progressLabelFor`，单程显示"进行中"）。
> - **§6.3 接入**：`TRACK_ORDER` / `TRACK_LABELS` / `TRACK_SHORT_LABELS` / `index.html`
>   按钮都已加；`render-maps.mjs` / `shot-tracks.mjs` 改成从生成器读**全部**赛道，
>   不再手写列表。
> - **§6.4 验收**：`package.json` 新增 `check:tracks`，`verify` 现在包含它。
>   新增 `tests/open-track.test.ts`（8 条）与 4 条 e2e。当前全量：**319 单测 / 140 e2e / typecheck / build / check-tracks 全绿**。
> - **遗留**：§七的那两条经验仍然有效；`measure-ai.mjs` 依旧只适用于闭环赛道。

> **给新对话用。** 这份文档交代「漂移龙」这条**单程（点对点）赛道**做到哪一步、
> 引擎还差什么、以及一堆已经踩过的坑。读完应当能直接接手。
>
> 生成时间：2026-10-04
> 对应 `docs/change-requests.md` 的 **CR-16**（超级 S 弯道）
> 相关文档：`docs/cr15-skins-handoff.md`（皮肤系统，已完成）

---

## 一、一句话背景

玩家手绘了一条赛道草图（「漂移龙」），要求做成游戏里的第三张图。
它**不是闭环**：一条路从左上角出发，绕一整圈，到左下角结束 ——
玩家明确说了「这是单行道，胜利目标不是三圈，跑完就行」。

这带来一个**超出"加一张图"范围的改动**：现有引擎整个建立在闭环上。

---

## 二、当前状态（务必先看）

| 部分 | 状态 |
|---|---|
| 草图 → 赛道提取流水线 | ✅ 完成（8 个工具，见 §5） |
| 生成器认 `open: true`（单程） | ✅ 完成 |
| 校验器认 `open: true` | ✅ 完成 |
| `MIN_RADIUS_PX` 100 → 65 | ✅ 完成（理由见 §4） |
| 控制点表（84 点，来自 v4 草图） | ✅ 在 `tools/gen-track.mjs` 里 |
| **最近间距 4.28 格（要求 4.5）** | ❌ **未达标，卡在这里** |
| 引擎支持单程（`LapTimer` / `RaceScene`） | ❌ **一行没改** |
| `TRACK_ORDER` 加入 track4 | ❌ 未加（**游戏里没有第三张图**） |
| e2e / 单元测试覆盖 | ❌ 未做 |

**当前干净状态**（不要弄坏）：
- `node tools/check-tracks.mjs` → track1 / track3 **通过**，track4 未通过
- `node node_modules/typescript/bin/tsc --noEmit` → 通过
- `TRACK_ORDER = ['track1', 'track3']` —— **游戏里只有两张图**
- `public/assets/maps/` 下**只有** track1 / track3（track4 的 json 已删除）

---

## 三、四条必须遵守的项目铁律

1. **`Skins.ts` / `RaceDirector.ts` 这类纯逻辑模块不许 import Phaser**
   （测试要在 Node 原生类型剥离下跑）。`LapTimer.ts` / `Track.ts` 也属于此类。
2. **不用 TypeScript 参数属性**（`constructor(private x: number)`）——
   Node 的 strip-only 模式会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
   写显式字段 + 构造函数赋值。
3. **绝对不要用 PowerShell 改文本文件**（`Get-Content` / `Set-Content` / 内联 `node -e` 带 `$1`）——
   会把 UTF-8 中文弄坏，还会把正则里的 `$1` 当变量展开。
   用 read / edit / write 工具，或把脚本落成文件再跑。
   **这个坑在本项目已经踩过 6 次以上。**
4. **覆盖已有文件前先 read**（本仓库的 fs 策略强制）。

---

## 四、已经做完的部分

### 4.1 `MIN_RADIUS_PX` 从 100 放宽到 65

文件：`tools/gen-track.mjs`（`MIN_RADIUS_PX`）、`tools/check-layout.mjs`（`report()` 里的 `ok`）

**为什么这不是"为了让某张图过关而放水"** —— 有实测支撑：

```
用真物理让 AI 单程跑完「漂移龙」：
  简单档  完赛 60.2s   贴墙 0 帧     脱困 0 次     ← 完美通过
  普通档  完赛 59~63s  贴墙 352~515 帧  脱困 20~29 次
  困难档  完赛 67~69s  贴墙 968~1037 帧 脱困 54~58 次
```

"速度越快撞得越狠（0 → 352 → 968）"是**入弯速度太高**的特征，
不是"弯不可通过" —— 慢速能干净通过，说明几何成立。
而 100px 是**按几何赛道定的经验值**（track1 = 124px、track3 = 137px），
手绘图的弯天然更紧。

**间距那条（4.5 格）没有放宽**，因为性质不同：它管的是"两条路会不会贴到一起"。

### 4.2 生成器与校验器支持开放路径

| 文件 | 改动 |
|---|---|
| `tools/gen-track.mjs` | `resolveCenterline()` 认 `track.open`：两端用端点作虚拟邻居、**不补闭合点**；meta 里输出 `open: true` |
| `tools/gen-track.mjs` | 加了 `--force` 开关：带几何缺陷也能生成，**专供"AI 到底能不能跑"的实测** |
| `tools/check-layout.mjs` | `buildCenterline()` 认 `open`；`analyse()` 里"沿路距离"与"切线取样"都按开放处理 |

**⚠️ 这两个改动缺一不可，否则会得到假数据**：
不加的话，生成器/校验器会把终点硬连回起点，凭空多出一条斜穿全图的路 ——
于是报出「最急弯 22px」「间距 0.03 格」这种**在游戏里根本不存在**的错误。

### 4.3 控制点表

`tools/gen-track.mjs` 里的 `TRACK4_CONTROL_POINTS`，84 个点，
来自 **v4 草图**（`tools/sketch-dragon4.png`），用下面这条命令生成：

```bash
node tools/apply-dragon.mjs tools/sketch-dragon4.png 8 8 --open
```

含义：`8px = 1 瓦片`、控制点间距 `8 瓦片`、`--open` = 开放路径。

grid `186×118`，起点 = 控制点 #0（草图左下角红点），`startIndex: 0`，`laps: 1`。

---

## 五、草图 → 赛道的工具链（这轮真正的产出）

以后玩家画任何草图，都能直接转成赛道，**不用再手描点**。
手描点我试过两轮，误差 ±20px 就足以毁掉形状，而且**笔画交叉处肉眼分不清**。

| 工具 | 作用 |
|---|---|
| `tools/rasterize-sketch.mjs` | 任意格式（**WebP** / JPEG / PNG）→ PNG。玩家发来的常是 WebP，`png.mjs` 的解码器只吃 PNG |
| `tools/probe-sketch-neck.mjs` | **自交检查**：逐条扫描线数"这里有几种路"。一条不自交的闭环任意水平线最多穿 2 次；出现 4~6 次说明图是 8 字形 |
| `tools/sketch-open-path.mjs` | **开放路径**中心线提取（单程赛道用这个） |
| `tools/sketch-centerline.mjs` | **闭环**中心线提取（用"最远点对切两半 + 双向最短路"拼环） |
| `tools/apply-dragon.mjs` | 把提取结果写进 `gen-track.mjs`（换控制点 + grid + startIndex） |
| `tools/preview-track.mjs` | 把控制点渲染成预览 PNG（**不需要先通过自检**）。开放路径会正确画出终点、不画假的闭合线 |
| `tools/measure-open-shape.mjs` | 量开放路径：曲率半径分布（多窗口）、自交、长度 |
| `tools/probe-open-ai.mjs` | **单程 AI 实测**：跑一趟，报完赛时间 / 贴墙帧 / 脱困次数 / **撞墙位置的弧长百分比** |

### 提取流水线的原理

1. 二值化（Otsu 自动定阈值）→ 深色像素 = 道路；
2. **距离变换**（chamfer 3-4）：每个像素到最近背景的距离 → 笔画中心线上取最大值；
3. 在**整个道路掩膜**上跑加权 Dijkstra，`cost = 1 + K/(1+到边界距离)`
   → 路径自然贴中心线走，且能跨过脊线的小缺口；
   （纯脊线搜索会失败：笔画粗细起伏让"局部极大"断成一段段，BFS 走不过去）
4. RDP 简化（容差 = 笔画半宽的 0.2 倍）→ 按弧长等距重采样。

### 关键洞察（两次失败的教训）

- **开放路径必须两端"重复端点"当虚拟邻居**，不能补闭合点。
- **闭环的严格 H/V 交替控制点必须有奇数个**（偶数会让首尾两条边同向，
  那个点就成了"共线三点"，Catmull-Rom 折出尖角）。这个我试了两轮才发现。
- **必须先用 `preview-track.mjs` 看图，再看检查器的数字**。
  我前 7 轮盲调控制点，从没看过生成的形状 —— 而"路径原地折返"这种问题一眼就能看出来。

---

## 六、还差什么（按建议顺序）

### 6.1 【卡住】最近间距 4.28 格 < 4.5 格

位置：**右下角那个回折**，弧长 ~15363px 处。

```
  #60 弧长 14833  [164.8, 92.1]
  #61 弧长 15088  [172.6, 93.7]
  #62 弧长 15327  [175.7, 100.5]   ← 回折顶端
  #63 弧长 15548  [170.2, 104.7]
  #64 弧长 15804  [162.2, 104.7]
```

它与右侧那个 U 形弯是**同一类问题**：顶端横向出头只有 ~3 格，却要转 180°。

**选项**：
- **A.** 放宽间距阈值到 4.2（与半径同理，但**性质不同**，要谨慎 ——
  4.28 格中心距意味着净空只剩约 10px，两条路几乎贴在一起）
- **B.** 请玩家把右下角那个回折画圆一点（他最擅长这个，v4 就是这么修的）
- **C.** 用 `tools/round-turn.mjs` 的思路把它替换成显式半圆 ——
  但注意：**该工具目前会找错"顶端"**（它取全局最大 x，会抓到右下角而不是目标弯）。
  要用得先把"按路径顺序 + 区域"选点写对，见文件里的注释。

**注意**：这个位置**没有**导致 AI 撞墙（AI 的撞墙全在 95% 弧长处）。
可能只是 AI 的走线恰好避开了。但这不代表没问题 —— 玩家贴内线走会很难受。

### 6.2 引擎支持单程（**这是最大的一块**）

现在引擎整个假设"闭环、3 圈"。必须改的地方：

| 文件 | 现状 | 要改成 |
|---|---|---|
| `src/game/LapTimer.ts` `normalizeArc()` | `arc % total`（第 141 行）—— 到终点绕回 0 | 开放路径不做归一 |
| `src/game/LapTimer.ts` `update()` | `delta > total/2` 时减一圈（第 177-178 行） | 开放路径不做半圈归一 |
| `src/game/LapTimer.ts` | 跨检查点边界时 `nextIndex >= checkpointCount` → `completeLap()` | 最后一圈跨过 `total` 即"完赛"，不再重置 |
| `src/game/scenes/RaceScene.ts` | **8 处**读 `TUNING.race.laps`（第 333/591/715/989/1195/1216/1364 行） | 改读 `track.laps`（meta 里已有，track4 = 1） |
| `src/game/types.ts` `TrackMeta` | 没有 `open` 字段 | 加 `open?: boolean` |
| `src/game/Track.ts` | 读 meta | 把 `open` 透出来 |

**建议做法**：给 `LapTimer` 加一个 `open: boolean` 构造参数，
在里面 `if (this.open) { ... }` 分支，**不要**去动闭环路径的代码 ——
闭环那两条赛道正在正常跑，别为了新功能把它们改坏。

**验收要点**（改完必须验）：
- track1 / track3 **跑起来和以前完全一样**（3 圈、计时、排名、幽灵车都正常）
- track4 跑完一趟就结算，HUD 不显示"第 N 圈"
- 8 处 `TUNING.race.laps` 都要跟着赛道走

### 6.3 把 track4 接进游戏

1. `src/game/constants.ts` 的 `TRACK_ORDER` 加 `'track4'`，`TRACK_LABELS` 加名字；
2. `index.html` 加赛道按钮（现有按钮是 环城 / 峡谷技术）；
3. `node tools/gen-track.mjs` 生成地图资源；
4. 跑 `node tools/render-maps.mjs`、`tools/shot-tracks.mjs` 重生成截图。

### 6.4 验收与回归

固定流程（每阶段都跑）：

```bash
node node_modules/typescript/bin/tsc --noEmit
node --import ./tools/ts-register.mjs --test "tests/**/*.test.ts"
node node_modules/vite/bin/vite.js build
node tools/e2e-check.mjs
node tools/doc-stats.mjs --write
```

**当前基线**（改动前请记下）：
- typecheck 通过
- 单元测试 **310 项通过**
- e2e **119 项通过**
- `check-tracks`：track1 / track3 通过

⚠️ **单程赛制需要新增 e2e**：至少要有一条"track4 跑完一趟就出结算"的断言。
参考 `tools/e2e-check.mjs` 里 `finishRaceByTeleport()` 的写法。

---

## 七、已踩过的坑（直接照抄结论）

### 7.1 用闭环工具跑开放赛道 → 假数据

`measure-ai.mjs` 是按闭环绕圈写的。把 track4 喂进去，它报

```
hard  贴墙 17013 帧 / 脱困 952 次
```

**这是假的** —— 它在"绕圈绕了 3 遍"。真相是单程一趟、简单档零碰撞。
**用 `tools/probe-open-ai.mjs`，不要用 `measure-ai.mjs`。**

### 7.2 盲调控制点（最贵的教训）

前 7 轮我在调 `gen-track.mjs` 里的控制点数组，**从没渲染出来看过**。
第 8 轮我开始用 `tools/preview-track.mjs` 看图，一次就看出了
"路径原地折返""闭合线斜穿全图"这些凭数字猜不到的问题。

**规则：改完控制点，先 `node tools/preview-track.mjs <id>` 看图，再看检查器数字。**

### 7.3 闭合弧会与路本身交叉

「漂移龙」起点（左上）与终点（左下）之间**没有空地** ——
路的左边缘恰好从两个端点之间穿过。所以**不能**用一段圆弧把首尾连起来凑闭环。
单程就是单程，必须让引擎支持开放路径。

### 7.4 `restart()` 会清掉 AI 进度

验"依赖累计进度"的功能时（例如预计完赛时间），不要 `restart()`，
直接 `skipCountdown()` 继续跑。

### 7.5 调试接口的 context 必须用 getter

`RaceDebugApi.ts` 的 context 只在 `create()` 构造一次。
写成 `difficulty: this.difficulty` 会把值**固化成快照** ——
之后改难度，读到的是老值，表现为"切难度后所有车停在原地"。
**会变的值一律用 `() => this.x`。**

### 7.6 PowerShell 内联 `node -e` 带 `$1` 会被展开

正则替换 `'\$1...'` 会被 PowerShell 当变量。**把脚本落成文件再跑**
（这也是为什么有 `apply-dragon.mjs` 而不是一行命令）。

---

## 八、参考文件

| 文件 | 作用 |
|---|---|
| `tools/gen-track.mjs` | 赛道生成器。`TRACK4_CONTROL_POINTS`、`MIN_RADIUS_PX`、`resolveCenterline()`、`--force` |
| `tools/check-tracks.mjs` / `check-layout.mjs` | 几何自检（长度 / 最急弯 / 最近间距 / 边界 / 发车角） |
| `tools/measure-open-shape.mjs` | 开放路径几何测量 |
| `tools/probe-open-ai.mjs` | 单程 AI 实测（**唯一可信的"能不能跑"判据**） |
| `tools/sketch-dragon4.png` | 玩家最终版草图（v4） |
| `tools/sketch-open-path.mjs` 等 | 提取流水线，见 §5 |
| `src/game/LapTimer.ts` | **要改**：`normalizeArc()` / `update()` |
| `src/game/scenes/RaceScene.ts` | **要改**：8 处 `TUNING.race.laps` |
| `src/game/types.ts` | **要改**：`TrackMeta` 加 `open` |
| `src/game/Track.ts` | **要改**：透出 `open` |

---

## 九、一句话总结给接手的人

**提取流水线做好了、控制点表在了、阈值放宽了；你要做的是"让引擎支持单程"
（§6.2）和"把 track4 接进游戏"（§6.3），顺带决定 §6.1 那个 4.28 格间距
是放宽还是请玩家改图。**

**四条铁律**：纯逻辑模块不 import Phaser、不用参数属性、
不用 PowerShell 改文本、覆盖前先 read。

**最贵的一条经验**：改完控制点**先渲染出来看**，别靠检查器的数字猜形状。

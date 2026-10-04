```markdown
# 修改意见（F1race 评审）

评审时间：**2026-10-03 20:26–21:50**
评审对象：工作区当前状态（`tools/screenshots/` 与 `report.json` 生成于 20:18–20:21，即评审前几分钟）
文档性质：**待办清单**，不是总结。每条都给出「证据 → 问题 → 改法 → 验收标准 → 工作量」。
版本：**v2**（在 v1 基础上并入 CR-15 / CR-16 内容扩展两条）

---

## 〇、评审基线（先说清这份意见的可靠性边界）

**看过的东西**

| 类别 | 具体 |
| --- | --- |
| 源码 | `src/` 全部 22 个 `.ts` + `style.css`（23 个文件）、`index.html` |
| 测试与工具 | `tests/` 10 个文件、`tools/` 主要脚本、`tools/screenshots/report.json` |
| 文档 | `README.md`、`docs/known-issues.md` |
| 截图 | `tools/screenshots/` 全部 26 张 PNG（含放大后的局部裁剪） |
| 实测命令 | `node tools/track-stats.mjs`、静态计数 `it(` 用例数、全文编码检查、`grep` 若干 |

**没能验证的两件事（本文所有"手感"判断都建立在这两条之上）**

1. **没有真上手驾驶。** 手感类结论来自代码、调参表、测试数据与截图推断，不是玩出来的。
2. **单元测试没能在本机执行。** `node --test` 需要 `spawn` 子进程，被当前沙箱以 `EPERM` 拦截（环境限制，非项目问题）。
   单元测试结论取自 `README` / `known-issues` 的记载，e2e 结论取自 `tools/screenshots/report.json`：**112 项通过、0 失败**。

**一个附带结论**：`src/`、`tests/`、`tools/`、`docs/` 共 57 个文本文件**全部是合法 UTF-8**，没有编码残留问题——这条不用修，列出来是为了避免下次重复排查。

---

## 一、总览

| 编号 | 事项 | 优先级 | 工作量 | 主要影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| CR-01 | 顶部 HUD 三个元素抢同一位置（delta / 本圈无效 / 状态面板） | **P0** | S | 一眼可见的显示错误 | 已修 |
| CR-02 | 版本号四处不一致 + 文档里的测试数字互相矛盾 | **P0** | S | 项目可信度、验收可追溯性 | 已修 |
| CR-03 | 完全没有音频 | **P1** | M | 最大的"手感"缺口 | 未做 |
| CR-04 | 漂移没有任何视觉反馈（无胎痕、无轮烟） | **P1** | M | 核心玩法没有回报感 | 未做 |
| CR-05 | 镜头零演出，速度感偏弱 | **P1** | S | 廉价的速度感提升 | 未做 |
| CR-15 | 车辆皮肤系统（获取 / 切换 / 持久化 / 抽奖产出） | **P1** | M | 给抽奖一个实质落点，给玩家"再跑一圈"的理由 | **已完成** |
| CR-16 | 新增「超级 S 弯道」图（连续反向弯，漂移节奏） | **P1** | M | 与现有两图形成机制差异，刷图动力 | **已完成**（落地为单程「漂移龙」） |
| CR-06 | AI 不会漂移、无尾流、车车碰撞只弹开 | **P2** | L | 对抗性上限 | 部分 |
| CR-07 | `RaceScene.ts` 1225 行，历史 bug 集中地 | **P2** | L | 可维护性 | 部分 |
| CR-08 | 老虎机中奖率 99% 且不接任何效果 | **P2** | S–M | 奖励语义被稀释 | **已完成** |
| CR-09 | 「霓虹都市」幽灵功能：只有注释和截图，没有赛道 | **P2** | S | 文档/资产噪音 | 未做 |
| CR-10 | HUD 用系统字体，与像素画面割裂 | P3 | S | 观感统一 | 未做 |
| CR-11 | 树与轮胎堆可穿过 | P3 | S | 廉价感 | 未做 |
| CR-12 | 路肩与沥青抓地力相同 | P3 | S | 赛道深度 | 未做 |
| CR-13 | 非整数倍缩放 | P3 | M | 像素干净度 | 未做 |
| CR-14 | 进度查询每次全量扫描 | P3（暂不动） | M | 性能余量 | 未做 |

优先级定义：**P0** = 影响可信度或一眼可见的错，本轮就该修；**P1** = 性价比最高的体验缺口；**P1.5** = 内容型任务，不是修 bug，但属于"让核心循环有吸引力"的必要投入；**P2** = 对抗性与结构；**P3** = 打磨，可延后。

---

## 二、P0：立即修

### CR-01 顶部 HUD 三个元素抢同一块位置

**证据**

| 元素 | 位置声明 |
| --- | --- |
| `.hud-top-center`（赛道 / 最佳总时间 / 难度 / FPS / 排名） | `src/style.css:87-93` → `top: 14px; left: 50%; transform: translateX(-50%)` |
| `#hud-delta`（实时 delta） | `src/style.css:344-346` → `top: 16px; left: 50%; transform: translateX(-50%)`，`.delta-value` 字号 38px（`src/style.css:355-362`） |
| `#hud-lap-flag`（本圈无效） | `src/style.css:380-382` → `top: 84px; left: 50%; transform: translateX(-50%)` |

三者都锚在**顶部正中**，于是在有历史纪录时，delta 的大号数字直接压在上面板文字上——`tools/screenshots/06-delta.png` 里可以肉眼确认「环城赛道」「最佳总时间」两行被 `+x.xxx` 和「对比 本场最佳圈」盖住；`10-ai.png` 同样。根因写在 `src/style.css:81-86` 的注释里：该面板原本钉在右上角，为了给小地图让位挪到了顶部居中，而 delta 早就在那儿了。`#hud-lap-flag` 是同一列的第三个占位者（`top:84px` 落在面板高度范围内），属于同一个问题的未爆分支。

> 注：`.toast`（`src/style.css:330-340`）锚在 `top:50%; left:50%`，会盖住画面正中的车。顺带一起收。

**改法（二选一，建议 B）**

**A. 最小改动**——把顶部三件收进同一个纵向容器，从"绝对定位互不知道"变成"流式排布"：

```html
<div class="hud-top-stack">
  <div class="hud-panel hud-top-center">…赛道 / 最佳总时间 / 难度 / FPS / 排名…</div>
  <div id="hud-delta" class="delta hidden">…</div>
  <div id="hud-lap-flag" class="lap-flag hidden">本圈无效</div>
</div>
```

```css
.hud-top-stack { position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
                 display: flex; flex-direction: column; align-items: center; gap: 6px; }
.hud-top-center, .delta, .lap-flag { position: static; transform: none; }
```

**B. 推荐：按赛车游戏惯例重新分配信息位。** delta 和「当前圈速 / 最佳圈」是同一组信息，应放同一处——把 delta 移进左上角计时面板（`当前圈速` 下方一行），顶部中央只留赛道与排名。这样视线不用在屏幕上跳，顶部也空出来。同时把 delta 字号从 38px 降到 20–24px（面板内不需要那么大）。

**验收标准**

- 1280×720 与 2560×1440 两个分辨率下，`hud-delta` / `hud-lap-flag` / `hud-top-center` 的包围盒**两两不相交**（可在 e2e 里用 `getBoundingClientRect()` 断言，加一条检查即可）。
- 重跑 `pnpm e2e` 并重新生成 `06-delta.png` / `08-invalid.png`，确认截图里没有文字重叠。

---

### CR-02 版本号与文档数字全部对不上

**证据（四处四个说法）**

| 位置 | 内容 |
| --- | --- |
| `src/game/constants.ts:5-6` | `GAME_VERSION = '0.1.0'`、`MILESTONE = 'M1'` |
| `package.json:4-5` | `"version": "0.2.0"`、描述写着「M2 计时与成绩体系」 |
| `README.md:5` | 「当前阶段：**M5**」 |
| `docs/known-issues.md:3` | 「M3 / M4 / M5 一次交付（`0.3.0 (M5)`）」 |
| `tools/screenshots/report.json:4` | `"version": "0.1.0 (M1)"`（页面版本标记的原样回读） |

**文档里的测试数字也互相矛盾**

| 位置 | 数字 |
| --- | --- |
| `README.md:226-227` | 单元测试 **155** 项、e2e **84** 项 |
| `docs/known-issues.md:138` | 「**155/155**」，但同一行分项相加是 39+27+23+11+35+20+14+9 = **178** |
| `tools/screenshots/report.json:8` | e2e **112** 项通过、0 失败 |
| 本次静态计数（`it(` 出现次数） | **163** 个（`ai` 23 / `drift` 27 / `format` 10 / `ghost-timebase` 5 / `ghost` 23 / `minimap` 5 / `ranking` 14 / `save` 35 / `timer` 15 / `track-save` 6）。其中 `timer.test.ts` 明显用循环批量生成用例（15 个 `it(` 对应文档记的 39 项），所以**真实用例数高于 163**，按同一比例外推约 **187** |

另外 `minimap.test.ts`、`track-save.test.ts` 根本没进 `known-issues.md` 的分项表。

**问题**：现在无法从任何单一位置判断"手上这个 `dist/` 是哪个版本、验收覆盖了多少"。这类腐烂会让所有其他文档的可信度打折——包括这份修改意见。

**改法**

1. **版本号单一来源。** 建议以 `package.json` 的 `version` 为准，在 `vite.config.ts` 里注入：
   `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`；
   `constants.ts` 只保留 `MILESTONE`（或反过来，但**只能有一个来源**）。
2. **加一条守卫测试**：`__F1RACE_VERSION__` 必须等于 `package.json.version + MILESTONE`，让版本漂移在 CI 阶段就失败，而不是靠人肉对齐。
3. **文档数字改成生成物**：加 `tools/doc-stats.mjs` 统计用例数并输出一段 Markdown 片段（或让 README 直接引用 `report.json` 的字段），避免手写数字再次腐烂。
4. `known-issues.md:138` 的分项与总数必须自洽；`report.json` 的 `version` 字段在步骤 1 完成后会自动正确。

**验收标准**

- 全仓库 `grep` 版本号，只在一处定义；`report.json.version` 与 `package.json.version` 一致。
- README 中不再出现手写的测试数量。

**工作量**：S（1–2 小时）

---

## 三、P1：手感补齐（性价比最高的一段）

### CR-03 加音频：现在是完全静音

**证据**：在 `src/` 与 `index.html` 中搜索 `sound|audio|volume|music|sfx` —— **零命中**（唯一命中的 `this.lottery.play()`（`src/game/Hud.ts:137`）是老虎机 DOM 演出，不是声音）。

**问题**：赛车游戏的引擎音随转速变化，是"单位代码量换来的爽感"最高的东西。现在按下油门，除了速度数字跳动没有任何反馈；漂移时听不到胎叫，撞墙时听不到撞击，倒计时没有 beep。

**改法（保持"零第三方素材"的项目哲学：程序化合成，不加音频文件）**

新增 `src/game/AudioEngine.ts`，要求**不 import Phaser**（延续现有架构约束，让它可被单测）：

```ts
export interface AudioEngine {
  setEngine(rpm01: number, throttle01: number): void; // 0..1
  setSlip(slip01: number): void;                      // 侧滑强度 → 胎叫
  impact(strength01: number): void;                   // 撞击
  beep(kind: 'count' | 'go'): void;                   // 倒计时
  setMuted(muted: boolean): void;
}
```

Web Audio 合成要点：

- **引擎**：2 个锯齿振荡器（略失谐，制造机械感）+ 低通；`freq = 70 + 380 * rpm01^1.2`，增益随 `throttle01`。转速建议由 `VehicleDynamics` 的纵向速度 + 漂移时的额外转速合成（不要直接用速度，漂移时才有"转速上去、速度不高"的真实听感）。
- **胎叫**：一段白噪声 buffer 循环 + bandpass（约 1.2 kHz），增益 = `slip01` 曲线（阈值以下为 0，避免正常过弯一直响）。
- **撞击**：短噪声 burst + 快速衰减包络，强度取碰撞前后速度差。
- **倒计时**：三声短方波 + 一声长音。

必须处理的三件事：

1. **自动播放策略**：`AudioContext` 必须在首次用户手势（keydown / click）后创建或 `resume()`，否则浏览器静音。
2. **静音开关 + 持久化**：HUD 加一个静音按钮，状态存 `localStorage`（**用独立键**，不要塞进 `SaveStore` 的存档对象——那个对象会被 `rulesetVersion` 变更清空，静音偏好不该跟着丢）。
3. **可测性**：`rpm01 → 频率`、`slip01 → 增益` 写成纯函数放进可单测模块；音频节点创建用薄封装，测试里注入 mock。

**验收标准**

- 静音状态下**不创建** `AudioContext`（可单测 / 可 e2e 断言）。
- 映射函数有单元测试；`?debug=1` 下 HUD 显示当前 rpm01 / slip01，便于验收。
- 三档难度下各跑一圈，主观确认：直线加速音高连续上升、入弯收油下降、漂移有胎叫、撞墙有撞击声。

**工作量**：M（半天到 1 天）

---

### CR-04 漂移要有视觉反馈（胎痕 + 轮烟）

**证据**：`src/` 内搜索 `particle|skid|tire|tyre|smoke|dirt` —— **零命中**。漂移目前是"物理状态 + HUD 一行字"：`Hud.setDrift()`（`src/game/Hud.ts:297-301`）显示 `漂移 0.13 rad`，`09-drift.png` 里能看到的唯一痕迹就是这行文字。

**问题**：漂移是这个游戏的招牌玩法，却是**反馈最少**的系统。而且 `docs/known-issues.md:14` 自己记着「全速满舵漂移约 3 rad/s，0.8 秒左右就会滑出赛道」——玩家要在没有任何视觉线索的情况下掌握一个 0.8 秒容错的机制。**没有胎痕，连"我滑到哪了"都看不见，调参只能靠猜。**

**改法**

1. `TUNING` 增加 `fx` 段（集中调参，符合现有约定）：

```ts
fx: {
  skid: { minSlipAngle: 0.10, alpha: 0.5, width: 4, fadeSeconds: 12, maxMarks: 1200 },
  smoke: { rate: 40, lifespanMs: 500, tint: 0xdddddd },
}
```

2. **胎痕**：在车辆图层**之下**、赛道之上放一个 `RenderTexture`（或带环形缓冲的 `Graphics`）。每帧若 `slipAngle > minSlipAngle`，就取左右后轮的世界坐标各画一笔；按时间戳淡出，超过 `maxMarks` 复用最旧的一笔。
   像素风注意：笔刷宽度取**整数像素**、`roundPixels` 已开启，不要用半透明渐变模糊边缘。
3. **轮烟**：Phaser 粒子发射器，挂在两后轮，`smoke.rate` 随 `slip01` 缩放；像素风用方形小粒子、低分辨率贴图。
4. **顺手加撞击反馈**：撞墙时播一轮火花粒子 + 镜头轻抖（与 CR-05 合并做）。

**验收标准**

- 漂移过弯后赛道上留下可见双轨迹，`fadeSeconds` 后自动消失；连续 3 圈不出现掉帧（维持 60 FPS，与 `report.json` 的 60.4 基线对比）。
- 静止 / 抓地过弯时**不产生**胎痕（避免满屏噪音）。
- 加一条 e2e：注入 `setDrift(true) + setInput(1, 1)` 若干秒后，断言胎痕层有绘制记录。

**工作量**：M（半天）

---

### CR-05 镜头零演出，速度感偏弱

**证据**：`src/game/constants.ts:10-17`，`camera: { zoom: 2, lerp: 1 }`。`docs/known-issues.md:117` 记录 `lerp` 从 0.18 改成刚性跟随（这个决定是对的，不要回退）。但除了刚性跟随之外，镜头没有任何动态。

**问题**：俯视视角下速度感主要靠"地图滚动 + 参照物密度"，现在 32px 瓦片 + 2 倍固定缩放，极速时画面信息量变化很小。加上无音频（CR-03），"快"的感觉基本只靠左下角的数字。

**改法**（都是小改动，别做过火）

- **速度缩放**：`zoom = 2 - 0.12 * speed01`（极速时略拉远），配合 `roundPixels` 用整数档位切换（如 2 / 1.875）以免像素抖动。
- **撞击抖动**：`camera.shake(80, 0.004 * strength01)`，与 CR-04 的火花同一处触发。
- **路肩震动**：压路肩时给一个极小的周期性偏移（可作为 CR-12 的配对反馈）。
- 全部参数进 `TUNING.camera`，保持"手感集中调参"的约定。

**验收标准**

- 极速直线与低速弯道的画面缩放差异肉眼可辨；像素不发生非整数缩放抖动。
- `docs/known-issues.md:21`（非整数倍缩放那条）若与 CR-13 一起做，需同步更新。

**工作量**：S（1–2 小时）

---

## 四、P2：对抗性与结构

### CR-06 AI 不会漂移、没有尾流、车车碰撞只会弹开

**证据**

- `docs/known-issues.md:16`：AI 的 `drive()` 输出的 `drift` **恒为 false**，「困难 AI 是抓地跑法，不会像玩家那样甩尾过弯」。
- `docs/known-issues.md:36`：车与车碰撞只做了「减速 + 弹开」，「没有并排摩擦、互相推挤、顶翻」。
- `README.md:57`：三档难度**不做橡皮筋、不瞬移**（这个立场见"不建议改"）。

**问题**：玩家和 AI 都用抓地跑法、且 AI 不会甩尾，意味着**路线上不会产生分歧**——永远是"谁更贴线谁赢"。加上没有尾流、没有并排摩擦，超车只能靠对手失误或硬撞。玩家冲线即结算（`docs/known-issues.md:31`）又会提前结束这场本就不激烈的对抗。综合结果是：第 1 圈之后大概率变成一个人在开车。

**改法（按性价比排序）**

1. **给困难 AI 开漂移**：`AIDriver.drive()` 的返回结构里 `drift` 字段**已经预留**，只需在 `TUNING.difficulty.hard` 加 `useDrift: true`，并在曲率超过阈值时输出 `drift`。限制在困难档，避免简单/普通档 AI 失控（对应 `known-issues.md:16` 的顾虑）。
2. **尾流（draft）**：车头前方 X px 内有车且航向差小于阈值时，阻力乘 0.85。**建议对玩家和 AI 同时生效**——这样它是"物理规则"而不是"AI 特权"，也不违反"不作弊"的承诺。
3. **并排摩擦**：把 `RaceScene.onVehicleCollision()`（`src/game/scenes/RaceScene.ts`，见 `README.md:61`）的"减速 + 弹开"改为**沿法线分离 + 切向摩擦传递**，让两车可以贴着跑而不是互相弹飞。这是"能对抗"的最低门槛。
4. **可选**：结算时给未完赛 AI 一个"预计完赛时间"（基于当前进度外推），缓解 `known-issues.md:31` 的"第 2 名是个圈数而不是时间"。

**验收标准**

- 困难 AI 在测速数据中**出现漂移状态**，且三圈总时间仍优于普通档（参考基线：简单 68.13s / 普通 56.03s / 困难 49.02s，见 `docs/known-issues.md:152`）。
- 卡墙回归：沿用现有 `6 个 seed × 三档共 18 次真实模拟` 的验收方式（`docs/known-issues.md:153`），改完必须仍是**零卡墙**。
- 尾流/并排都有数值断言（例如两车相距 40px 时的阻力差、碰撞后两车不再反向弹飞）。

**工作量**：L（1–2 天）

---

### CR-07 `RaceScene.ts` 拆分（历史 bug 的集中地）

**证据**：`src/game/scenes/RaceScene.ts` 共 **1225 行**，约 40 个私有方法，同时承担：赛道切换（`changeTrack` / `gridSlot` / `buildRacers` / `trackLabel`）、幽灵车（`installGhost` / `updateGhost` / `ghostGapMs` / `syncGhostHud` / `installGhostAfterRace`）、排名（`updateRanking` / `standingRows` / `pushStandingsToHud` / `buildStandings` / `syncProgressBaseline`）、小地图（`getMinimapDots` / `drawMinimap`）、状态机（`tickCountdown` / `beginRacing` / `pauseRace` / `resumeRace` / `finishRace`）、结算与抽奖（`scheduleLottery`）、调试 API（`installDebugApi` / `installDebugHelpers`）。

而 `docs/known-issues.md` 记录的两个最隐蔽的 bug，恰好都出在这两处：

- 第 9 条：`updateRanking()` 没进每帧循环 → 排名整场是发车瞬间的快照。
- 第 10 条：`syncProgressBaseline()` 原本遍历全部 racer → 瞬移调试把 AI 基准一起改了。

**问题**：这不是"代码丑"，是**这两块逻辑没有单元测试**导致的——它们被埋在 Phaser 场景里，而项目最有价值的资产恰恰是"纯逻辑可测"。历史 bug 名单已经证明了这个代价。

**改法（按顺序抽取，每步都可独立验收）**

| 抽取模块 | 吸收的方法 | 是否纯逻辑（可单测） |
| --- | --- | --- |
| `RaceDirector` | `tickCountdown` / `beginRacing` / `pauseRace` / `resumeRace` / `finishRace`，把 `raceState` 收敛到一处 | ✅ |
| `RaceStandings` | `updateRanking` / `standingRows` / `buildStandings` / `syncProgressBaseline` | ✅ |
| `GhostRunner` | `installGhost` / `updateGhost` / `ghostGapMs` / `syncGhostHud` / `installGhostAfterRace` | 部分（插值可纯化） |
| `TrackSwitcher` | `changeTrack` / `gridSlot` / `buildRacers` / `trackLabel` | 部分 |
| `ResultFlow` | `finishRace` 后半段 / `scheduleLottery` / 领奖台 | ❌（DOM/演出） |
| `DebugApi` | `installDebugApi` / `installDebugHelpers` | ❌ |

**验收标准**

- `RaceScene.ts` ≤ 500 行，只做装配与每帧调度。
- 新增 `RaceDirector` 与 `RaceStandings` 的单元测试（至少覆盖：倒计时期间车辆不可动、暂停不推进计时、排名每帧更新、进度基准只对齐玩家）。这四条正是历史 bug 的直接回归测试。
- `pnpm e2e` 全绿，截图无回归。

**工作量**：L（1–2 天，可与 CR-06 并行）

---

### CR-08 老虎机：要么接上效果，要么砍掉

> **状态：已完成（2026-10-04，与 CR-15 同批）。**
> 采纳**方案 A**（接最小效果：中奖产出车辆皮肤）。两条必须做的事都落地了：
> 1. `TUNING.lottery.enabled` 默认 **`false`**，`winRate` 从 0.99 收到 **0.35**；
>    99% 挪进 `?lottery=test` 的调试覆盖（`TUNING.lottery.testWinRate`）。
>    `tests/skins.test.ts` 有一条断言专门守着"发布默认不得是 0.99"，
>    e2e 会从 `constants.ts` 源码里读出发布默认值再与运行时生效值对比。
> 2. README 的功能表已登记抽奖 / `Minimap.ts` / `Podium.ts` / `SlotMachine.ts` / `DriveInput.ts` / `Garage.ts`。
> 验收：CR-15 的验收标准全部通过（含"皮肤不影响成绩"）。
>
> **后续调整（玩家要求）**：抽奖的触发条件从"只在中奖动画"→"刷新本赛道最佳总时间"，
> 现在扩成 **`beatPersonalBest || wonRace`** ——「只要拿了冠军就能抽奖」。
> 理由是"跑出个人第二好成绩但拿了第一"什么都没有，而"赢了却没有反馈"比没有奖励更伤。
> e2e 用三场比赛把这条钉死：夺冠+刷纪录要弹、夺冠但不刷纪录**也要**弹、
> 既没夺冠也没刷纪录**不能**弹（只测前两条的话，判据被写成恒真也会通过）。

**证据**

- `src/game/constants.ts:238-249`：`lottery.winRate = 0.99`，注释写着「**测试阶段**按需求设成 99%」。
- `src/game/SlotMachine.ts:1-13` 头部注释：「目前中奖道具**不接任何实际效果**，只决定放不放中奖动画」。
- 20:19–20:21 的截图里已经有完整演出（`12-lottery.png` / `21-lottery-spinning.png` / `22-lottery-result.png`）。

**问题**：两个风险。①99% 是"测试阶段"的默认值，**没有任何开关阻止它发布**；②一个"没有效果的奖励"比没有奖励更伤——刷新纪录的成就感会被"又转了个盘子"替换掉。在一个纯技术刷时间的游戏里，随机奖励本身就和"纪录=实力证明"的语义冲突。

**改法（三选一，必须选一个并写进文档）**

- **A. 接上最小效果**：中奖解锁车身配色 / 贴花 / 称号。存档里加 `unlockedCosmetics`——**注意不要塞进会被 `rulesetVersion` 清空的那部分**（见 `docs/known-issues.md:95-99`，纪录会因规则变更被清空，外观解锁不该跟着丢）。
  > 方案 A 的具体落地规格见 **CR-15 车辆皮肤系统**。CR-15 落地后，CR-08 只剩"`winRate` 发布默认值不得为 0.99"这一条必须做。
- **B. 换成技术性奖励**（更契合本作）：中奖 = 解锁一个挑战目标，例如「无漂移跑进 50s」「S1 进 18s」。把 RNG 换成"能不能做到"，和现有的 delta / 分段系统天然衔接。
- **C. 砍掉**，演出预算留给领奖台。

**无论选哪个都必须做的两件事**：

1. `winRate` 的发布默认值**不得是 0.99**；加 `TUNING.lottery.enabled`（默认 `false`）或把 99% 挪到 `?lottery=test` 的调试覆盖里。
2. 在 `README.md` 的 HUD/功能表里登记"抽奖"这一条（现在 README 完全没提它）。同理需要补登记的是 `Minimap.ts` / `Podium.ts` / `SlotMachine.ts` / `DriveInput.ts`（`README.md:138-154` 的目录结构里都没有）。

**验收标准**

- 存在"关闭抽奖"的开关，且发布配置下为关闭或默认中奖率合理。
- 奖励（若保留）有可观察效果，且在存档里的生命周期与"纪录"解耦。
- 若采纳方案 A，验收标准追加：CR-15 的验收标准全部通过。

**工作量**：S（砍）/ M（接效果）

---

### CR-09 「霓虹都市」幽灵功能：二选一，别留着

**证据**

- 三条残迹：`tools/check-layout.mjs:138`（注释提到「霓虹都市是街道赛道，转角刻意做得紧」）、`tools/preview-assets.mjs:60`（注释提到瓦片集含「霓虹都市 9」张瓦片）。
- `tools/screenshots/20-result-podium.png` / `22-lottery-result.png` 的赛选栏里**有**「霓虹都市」按钮。
- 但当前 `src/game/constants.ts:265` 是 `TRACK_ORDER = ['track1', 'track3']`，`index.html:91-92` 只有两个按钮，`public/assets/maps/` 只有 `track1` 与 `track3`。

**问题**：一个已经做了一部分（瓦片 + 布点设计 + 截图）、但没有正式接入的赛道。留着会让文档、截图、资产三者继续互相矛盾：新来的读者会以为有三条赛道。

**改法**

- **若砍**：删掉 `check-layout.mjs` / `preview-assets.mjs` 中的霓虹引用，重新生成瓦片集（去掉多余的 9 张），重跑 `tools/check-tracks.mjs` 确认无孤儿资产；更新截图。
- **若留**：补齐 `public/assets/maps/track4.*`，加入 `TRACK_ORDER`（`src/game/constants.ts:265`）、`TRACK_LABELS` / `TRACK_SHORT_LABELS`（`:275-284`）、`index.html` 按钮，并在 README 登记。
  > 若选择"留"，与 **CR-16 超级 S 弯道图** 的赛道总数决策必须同批拍板：是收敛为 3 条（track1 / track3 / super-s），还是扩为 4 条（+ 霓虹都市）。不允许截图 / 文档 / 代码三方继续不一致。

**验收标准**：`TRACK_ORDER`、`index.html` 按钮、`public/assets/maps/*`、截图四者完全一致。

**工作量**：S

---

## 四·五、P1.5：内容扩展（本次新增）

> 定位：这一节不是"修 bug"，是**给玩家一个再跑一圈的理由**。
> 当前状态：两张图 + 冠军动画 + 抽奖（无实质产出）+ 小地图 + M5 AI 已交付，但"再跑"缺少动机。CR-15 / CR-16 是这次内容扩展的两个最小抓手。

### CR-15 车辆皮肤系统

> **状态：已完成（2026-10-04）。** 与本节规格的差异只有两处，都记在这里：
> - 贴图目录用 `public/assets/cars/player_<suffix>.png`（跟既有的三张车贴图放在一起），
>   不是本节写的 `assets/vehicles/`；键名统一由 `constants.skinAssetKey()` 推导。
> - 皮肤选择做成了**覆盖层车库（`G` 键 / 难度条按钮）**而不是主菜单 ——
>   这个项目没有主菜单，车库挂在 HUD 上更贴近现有结构，且打开时会暂停比赛。
>
> 落地清单：`src/game/Skins.ts`（数据层）、`src/game/SkinStore.ts`（持久化，独立键
> `f1race.skins.v1`）、`src/game/Garage.ts`（车库 UI）、`BootScene` 预载 6 张贴图、
> `RaceScene.buildRacers()` 按装备皮肤选贴图、抽奖 `onSettled` → 解锁 → 落盘 → 面板文案。
> e2e 新增 7 条（含"皮肤不影响成绩"的两层验证），单元测试 34 条。

**证据**

- 用户明确需求：「增加车辆皮肤系统」。
- CR-08 证据：`src/game/constants.ts:238-249` 的 `lottery.winRate = 0.99`，注释写着「测试阶段」。
- CR-08 改法 A 已点出方向：中奖解锁车身配色 / 贴花 / 称号——但**没有具体落地规格**，本条即为此补上。
- `grep` 现状：`src/` 无 `skin` / `cosmetic` / `livery` 命中，皮肤系统完全不存在。

**问题**

抽奖现在只决定放不放中奖动画，中奖道具不接任何实际效果。在一个以"刷时间 = 实力证明"为核心的游戏里，一个没有产出的随机奖励比没有奖励更伤——它稀释了刷新纪录本身的成就感。

皮肤是最轻的"可累积产出"：不影响任何数值、不破坏公平、有收集欲、成本低。

**改法**

1. **数据层**
   - 新增 `src/game/Skins.ts`，**不 import Phaser**（延续项目铁律，保证可单测）。
   - 结构：
     ```ts
     export interface SkinState { owned: string[]; equipped: string }
     export const SKINS: Record<string, { label: string; textureKey: string }> = { … }
     ```
2. **皮肤范围（首版 6 款）**
   ```text
   default   默认车（初始拥有）
   red       红漆
   blue      蓝漆
   carbon    碳纤维黑
   ghost     幽灵白（半透明感）
   gold      金漆（稀有）
   ```
3. **获取**：抽奖产出，产出走 `TUNING.skins.dropTable`；重复抽到已拥有皮肤时按 `TUNING.skins.duplicateReward` 处理（转抽奖券 / 提示"已拥有"）。
4. **切换**：主菜单新增「车库 / 皮肤」入口，像素风选择界面，显示已拥有 / 未拥有，选中即时生效，下一场比赛使用。
5. **存储**
   - 独立 key：`f1race.skins.v1`。
   - **不要塞进 `SaveStore` 那套 `rulesetVersion` 升版会清空的存档对象**——外观解锁不该因为规则变更被清掉（这一点与 `docs/known-issues.md:95-99` 的纪录清空策略解耦）。
   - 版本变化时丢弃旧数据，不报错。
6. **占位素材**
   - `assets/vehicles/player_<skinId>.png`，沿用程序化像素 PNG 生成器（无第三方依赖）。
   - 幽灵车皮肤单独走 ghost 占位，不与玩家皮肤混用。
7. **调参入口**（沿用集中调参约定）
   ```ts
   TUNING.skins.dropTable
   TUNING.skins.duplicateReward
   ```
8. **与 CR-08 的关系**：CR-15 落地后，CR-08 的「方案 A 接最小效果」即视为已选；CR-08 剩余事项只剩"`winRate` 不得是 0.99 的发布默认值"这一条。

**验收标准**

- 抽到皮肤后车库可见；装备后下一场比赛外观变化。
- 刷新页面后已拥有与装备状态保留。
- **皮肤不影响速度、漂移、碰撞、成绩、排名、计时**（可加一条 e2e：装备非默认皮肤跑 3 圈，成绩曲线与默认皮肤一致）。
- 重复抽奖有明确处理，不静默吞掉。
- e2e 新增：抽奖获得皮肤 → 装备生效 → 刷新后保留 → 不影响成绩。
- 单测新增：`Skins` 模块的增 / 查 / 装备 / 版本迁移。

**工作量**：M（半天到 1 天）

---

### CR-16 「超级 S 弯道」图

> **状态：已完成（2026-10-04），落地形态与本节规格有一处重要差异。**
>
> 玩家后来给了一张**手绘草图**（`tools/sketch-dragon4.png`，「漂移龙」），
> 它**不是闭环**：一条路从左下出发、绕一整圈、到左上结束，玩家明确说
> 「这是单行道，胜利目标不是三圈，跑完就行」。所以最终交付的是：
> **单程（点对点）赛道，1 趟计时**，而不是本节写的"封闭环形 3 圈全参数"。
>
> 其余差异：
> - 地图 186×118（不是 120×80）；长度 20660px（是 track3 的两倍）；
> - 生成方式**不是手摆控制点**，而是从草图自动提取中心线
>   （`tools/sketch-open-path.mjs` 等 8 个工具，见 `docs/cr16-drift-dragon-handoff.md`）；
> - 最急弯 67px（低于本节的"参考值 120px"，但 `MIN_RADIUS_PX` 已按实测放宽到 65px：
>   简单档 AI 零碰撞跑完，快档撞墙集中在同一处，属于"入弯太快"而不是"弯不可通过"）；
> - 困难 AI 漂移（§4）**未打开**，仍等 `TUNING.difficulty.hard.useDrift`
>   —— 这张图的弯太紧，AI 漂移会失控，见 `docs/known-issues.md`；
> - 发夹弯有了（右侧那个半圆回折），连续小 S 也有（上边波浪段 + 下边连 S）。
>
> 落地的验收：单程跑完一趟即结算（e2e 真跑），track1/track3 三圈语义零回归，
> 单测新增 `tests/open-track.test.ts`（8 条）覆盖单程计时与闭环回归。

**证据**

- 用户明确需求：「加一张超级 S 弯道图」。
- CR-09 证据：`TRACK_ORDER = ['track1', 'track3']`（`src/game/constants.ts:265`），`index.html:91-92` 只有两个按钮，`public/assets/maps/` 只有 `track1` 与 `track3`；「霓虹都市」处于"半做未接"状态。
- `node tools/track-stats.mjs` 实测：`track1` 最急弯半径 124px、`track3` 137px，**半径 < 120px 占比 0.00%**——两张图都偏"好跑"，缺少弯道节奏差异。

**问题**

两张图没有机制标签，玩家跑完不会说"图 A 和图 B 手感不一样"。加上没有 S 弯密度，漂移系统（招牌玩法）缺少用武之地。

**改法**

1. **机制标签**：**连续 S 弯 + 漂移节奏**。与现有两图形成明确差异：
   - `track1`：高速环道，考验极速与漂移衔接
   - `track3`：中等弯道，考验走线
   - `super-s`：连续 5–7 个反向弯，弯间距短，**必须用漂移衔接**才跑得顺
2. **生成方式**：沿用 `tools/gen-track.mjs` 的 `CONTROL_POINTS` 脚本生成，不手工 Tiled（保持项目"改脚本就能重做赛道"的资产一致性）。
3. **赛道规格**
   - 封闭环形，3 圈，规则沿用全局（草地减速 / 撞墙 / 计时 / 幽灵）。
   - 瓦片尺寸沿用 120×80（或按需微调），保留 `ground / track / decor / walls` 四层。
   - 赛道宽度**先保持 147px**，试玩后再决定是否收窄——CR-16 完成后应触发一次试玩会，专门判断宽度与弯间距。
   - 至少 1 个发夹弯作为难点。
4. **AI 适配**
   - 困难 AI **必须会漂移**才有竞争力——这依赖 **CR-06 第 1 项（困难 AI 开漂移）**，CR-16 应在 CR-06 之后做，或与之并行。
   - 卡墙回归必须沿用现有 `6 个 seed × 三档共 18 次真实模拟` 的验收方式（`docs/known-issues.md:153`），新图零卡墙。
5. **占位素材**：沿用现有瓦片集，不新增美术类型；只新增地图数据 `public/assets/maps/track4.*`（若保留 CR-09 的霓虹都市，则编号顺延）。
6. **登记**：加入 `TRACK_ORDER`（`src/game/constants.ts:265`）、`TRACK_LABELS` / `TRACK_SHORT_LABELS`（`:275-284`）、`index.html` 按钮，并在 README 的功能 / 目录表登记。
7. **与 CR-09 的关系**：CR-16 落地后，CR-09「霓虹都市」的决策必须同步拍板——**要么和 super-s 一起把赛道总数收敛为 3 条，要么把霓虹正式接进来变成 4 条**。不允许出现"截图里有第三条、代码里没有"的状态。

**验收标准**

- 地图能加载，能跑完 3 圈；小地图正常显示。
- 草地、撞墙、计时、幽灵规则与现有两图一致。
- 该图能记录最佳成绩与幽灵。
- AI 三档均能完赛、零卡墙；困难 AI 出现漂移状态。
- e2e 新增：超级 S 弯道图 3 圈完赛（沿用真实驾驶，不伪造数据）。
- 试玩主观判定：**玩家能说出"这张图和另外两张不一样"**——这是本条的核心验收，不靠数字。

**工作量**：M（半天到 1 天，含试玩调参）

---

## 五、P3：打磨（择机）

| 编号 | 事项 | 说明 | 参考 |
| --- | --- | --- | --- |
| CR-10 | 像素位图字体 | HUD 是 DOM + 系统字体，与像素画面割裂（截图中很明显：赛道是硬边像素，UI 文字是抗锯齿的）。这是**观感统一**里最便宜的一步，我建议它从 M6 提前到这里 | `docs/known-issues.md:51` |
| CR-11 | 树与轮胎堆不可穿过 | 装饰物可以直接开过去，是"廉价感"最直接的来源。改成带碰撞的瓦片即可 | `docs/known-issues.md:46` |
| CR-12 | 路肩抓地力差异 | 压路肩目前零风险零收益。给一点"滑但不致命"的差异，配合 CR-05 的震动，能显著提升走线深度 | `docs/known-issues.md:45` |
| CR-13 | 整数倍缩放 | 非整数倍时像素大小不均匀（不模糊，但会有像素块不等宽） | `docs/known-issues.md:48` |
| CR-14 | 进度查询全量扫描 | 当前 561 点 × 5 车 × 60fps ≈ 17 万次投影/秒，实测 60 FPS 无压力。**现在别动**。但 CR-04 的粒子/胎痕与 CR-06 的更多车辆会加大压力，届时再上空间哈希；现在就加一条注释说明"为什么故意保持无状态" | `docs/known-issues.md:44`、`:75-81` |

---

## 六、明确**不**建议改的（保护现有优点）

1. **不要加橡皮筋。** `REQ-008`「不作弊到瞬移」的立场是对的。将来若要做动态难度，应基于 **AI 自己的节奏**（例如让它的限速在自己的圈速分布内收敛），而不是跟随玩家的位置。
2. **不要把纯逻辑模块改成 `import Phaser`。** 那批单元测试能跑起来，全靠 `LapTimer` / `VehicleDynamics` / `Ghost` / `AIDriver` / `Ranking` / `SaveStore` 不依赖 Phaser。CR-06 的 AI 漂移、CR-07 的拆分、CR-15 的皮肤模块都必须守住这条线（场景持有纯逻辑，纯逻辑不认识场景）。
3. **不要为了过测试而放宽无效圈判定。** 弧长增量的合理性检查（`LapTimer.update()`）是这个游戏"纪录可信"的根，抄近道不能污染成绩。调 `progressJumpTolerance` 之前先想清楚。
4. **不要删 `dataVersion` / `rulesetVersion` 的升版机制。** 幽灵车那个"每帧判超时被吸附到整数帧"的 bug 就是这个机制兜住的（`docs/known-issues.md:60-73`）。皮肤存储要走独立键，正是因为这条机制会清空纪录——但外观解锁不该跟着丢。
5. **不要让 e2e 退化成假数据。** 现在「跑完 3 圈」「AI 跑 25 秒」「难度对比」都是真跑出来的（`README.md:229`），这是这个项目可信度的来源。新增的断言（CR-01 的包围盒、CR-03 的音频、CR-04 的胎痕、CR-15 的皮肤、CR-16 的 S 弯完赛）也要真操作真断言。

---

## 七、落地顺序建议（M6 切分）

| 阶段 | 内容 | 产出 | 预估 |
| --- | --- | --- | --- |
| **M6-A 止血** | CR-01、CR-02、CR-09 决策 | 顶部 HUD 无重叠；版本单一来源；赛道数量三方一致 | 半天 |
| **M6-B 手感** | CR-03、CR-04、CR-05 | 有声音、有胎痕、镜头有演出。**做完必须再试玩一次**，然后回头调 `driftSteerBoost` / `driftLateralPush`（`docs/known-issues.md:181-183` 已经点出漂移转得太快是当前最需要试玩的部分——有了胎痕，这次调参会看得见结果） | 1–2 天 |
| **M6-C 对抗与结构** | CR-06、CR-07 | 困难 AI 会漂移、能并排跑；`RaceScene` ≤ 500 行且关键路径有测试 | 2–3 天 |
| **M6-D 内容扩展**（本次新增） | **CR-15、CR-16**；CR-08 收口 | 皮肤系统上线 + 超级 S 弯道图上线 + 抽奖接上皮肤产出；**做完组织一次试玩会，专门判断 S 弯宽度与弯间距** | 1–2 天 |
| **收尾** | CR-08 剩余项 + P3 择机 | 抽奖 `winRate` 收口；观感打磨 | 视情况 |

**顺序约束**（写明原因，避免被随意重排）：

- CR-16 **建议排在 CR-06 之后**：困难 AI 不会漂移，S 弯图就没人能和玩家对抗。
- CR-15 **建议排在 CR-08 之前或同批**：皮肤的产出通道就是抽奖，两者是同一件事的两面。
- CR-16 **必须触发一次真人试玩**：弯间距与赛道宽度无法靠数字验收，只能玩出来——这也是本项目一贯的验收原则（手感相关改动的最终判定标准是人玩，不是数字）。

**验收方式沿用现有约定**：`pnpm verify`（typecheck + 单元测试 + build + e2e），外加：

- 重新生成 `tools/screenshots/` 全量截图，人工过一遍 26 张。
- `report.json` 的 `version` 字段必须与本轮里程碑一致（这是 CR-02 的天然回归）。
- 手感相关改动的最终判定标准是**人玩**，不是数字。数值只用于确认"没有变差"（AI 三圈用时、零卡墙、60 FPS）。

---

## 附录：本次评审用到的事实与命令

```bash
# 赛道几何（本文引用的半径 / 弯速上限来自这里）
node tools/track-stats.mjs
#   track1: 长度 7532px、最急弯半径 124px @ arc 7032、该弯上限 294px/s、半径<120px 占比 0.00%
#   track3: 长度 10261px、最急弯半径 137px @ arc 2904、该弯上限 317px/s
#   对照：车辆极速 maxSpeed = 520px/s（src/game/constants.ts:22）

# 单元测试用例数（静态计数 it( 出现次数，不含循环生成）
#   ai 23 / drift 27 / format 10 / ghost-timebase 5 / ghost 23 / minimap 5
#   ranking 14 / save 35 / timer 15 / track-save 6   →  合计 163 个 it(
#   注意 timer.test.ts 用循环批量生成（15 个 it( 对应文档记的 39 项），真实用例数更高

# 音频与特效覆盖
#   grep -rE 'sound|audio|volume|music|sfx' src/ index.html      → 0 命中
#   grep -rE 'particle|skid|tire|tyre|smoke' src/               → 0 命中
#   （全仓唯一与"播放"有关的命中是 src/game/Hud.ts:137 的 this.lottery.play()，老虎机 DOM 演出）

# 皮肤与赛道现状（本次评审新增）
#   grep -rE 'skin|cosmetic|livery' src/            → 0 命中
#   ls public/assets/maps/                          → track1.* track3.*（无 track4 / 无 super-s）
#   grep -n "TRACK_ORDER" src/game/constants.ts     → ['track1', 'track3']

# 编码体检（57 个文本文件全部合法 UTF-8）
python -c "…逐个 decode('utf-8')…"   → UTF-8 OK: 57  非 UTF-8: 0
```

**未能执行**：`pnpm test`（`node --test` 需 spawn 子进程，被沙箱以 `EPERM` 拦截）。
**e2e 基线**：`tools/screenshots/report.json` — 112 项通过 / 0 失败 / 60.42 FPS / renderer=WebGL(2)。
```

已合并完成。相对 v1 的改动清单：

- 头部加 `版本：v2` 标记
- 总览表插入 CR-15、CR-16 两行，优先级定义补 `P1.5`
- 新增 **四·五、P1.5：内容扩展** 一整节（CR-15 / CR-16 全文）
- CR-08 改法 A 后加 CR-15 交叉引用；验收标准加“若采纳方案 A → CR-15 验收通过”
- CR-09 若留分支后加 CR-16 赛道总数决策引用
- 第六节“不建议改”第 2 条补入 CR-15 皮肤模块；第 4 条补入皮肤存储解耦的理由
- 第七节表新增 **M6-D 内容扩展** 行；补“顺序约束”三条
- 附录加“皮肤与赛道现状”一段

需要我再出一版 **纯 txt** 的 CR-15 / CR-16 单页（只这两条，方便单独发 DH），还是保持当前 v2 全文即可？
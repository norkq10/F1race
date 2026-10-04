# M3 / M4 / M5 接口与实现契约（冻结版）

本文档是三个里程碑实现的**唯一依据**。接口已经冻结，三个模块必须严格按此实现，
因为它们的集成（`RaceScene` / `Hud` / `index.html`）由另一条工作线负责，不会为迁就实现而改动。

---

## 0. 项目背景与约束

**F1race** —— 像素风 2D 俯视单机赛车，Phaser 3.90 + TypeScript 5.9 + Vite 7。

已完成：
- **M1** 可驾驶原型（瓦片赛道、镜头刚性跟随、WASD 街机物理、草地减速、撞墙减速弹开、3-2-1-GO、本地保存）
- **M2** 计时与成绩体系（帧内插值精确过线、无效圈判定、实时 delta、分段、成绩历史、暂停）

现有模块：`Track`（瓦片地图 + 中心线进度）、`Vehicle`（街机运动学 + 碰撞响应）、
`LapTimer`（计时引擎）、`SaveStore`（localStorage v2）、`AutoPilot`（验收用纯追踪）、
`Hud`、`RaceScene`、`InputController`、`constants.ts`、`types.ts`。

### 硬性约束

1. **不许新增第三方依赖**（`package.json` 的 dependencies / devDependencies 都不能加）。
2. **严格模式**：`strict`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitOverride` 全开，
   `tsc --noEmit` 必须零错误。
3. **注释用简体中文**，风格与现有代码一致（解释"为什么"，不是复述代码）。
4. **纯逻辑模块不能 import Phaser**。类型可以用 `import type`（会被类型剥离抹掉），
   但只要 import 了 Phaser 的**值**，单元测试就跑不起来。
5. **不许改动这些文件**：`src/game/scenes/RaceScene.ts`、`src/game/Hud.ts`、
   `src/game/LapTimer.ts`、`src/game/Track.ts`、`index.html`、`src/style.css`、
   `src/game/constants.ts`、`src/game/types.ts`、`tools/e2e-check.mjs`。
   唯一例外：如果你改的接口导致上述文件里某个**调用点**编译不过，
   可以做**最小改动**让它编译通过，并在汇报里逐条写明改了什么。
6. **不许运行** `pnpm build`、`pnpm e2e`、`pnpm dev`（会占用端口，与并行工作线冲突）。
   只允许跑 `tsc --noEmit` 和**你自己的**测试文件。

### 可用命令

```bash
# 类型检查（全项目）
node node_modules/typescript/bin/tsc --noEmit

# 只跑你自己的测试文件（不要跑整个 tests/ 目录，别的工作线可能正在写）
node --import ./tools/ts-register.mjs --test tests/drift.test.ts
```

测试用 Node 内置 runner + 原生类型剥离，**无需编译**。写法和 `tests/timer.test.ts` 一致：
`import { describe, it } from 'node:test'` + `import assert from 'node:assert/strict'`，
导入源码时省略扩展名（有解析钩子会补 `.ts`）。

### 已冻结的类型（在 `src/game/types.ts`，直接用，不要改）

```ts
export interface CenterlineSample { x: number; y: number; tangent: number }

export interface TrackQuery {
  readonly totalLength: number;
  progressAt(x: number, y: number): TrackProgress;
  pointAtArc(arc: number): CenterlineSample;
  tangentAtArc(arc: number): number;
}

export interface GhostData {
  version: number; totalMs: number; intervalMs: number;
  frames: number[];              // 每 3 个数一组 [x, y, heading]
}

export type DifficultyId = 'easy' | 'normal' | 'hard';
export interface DifficultyProfile { /* 见 constants.ts 的 TUNING.difficulty */ }

export interface RacerProgress {
  id: string; lapsCompleted: number; lapArc: number;
  finished: boolean; finishMs: number | null; isPlayer: boolean;
}
export interface RankedRacer extends RacerProgress { rank: number; totalProgressPx: number }
```

### 已冻结的配置（在 `src/game/constants.ts`，直接用，不要改）

- `TUNING.vehicle.drift` —— 漂移全部参数（`gripRate` / `driftGripRate` / `driftSteerBoost` /
  `driftLateralPush` / `driftSpeedScrub` / `driftAngleThreshold` / `recoverAngleThreshold` / `maxLateral`）
- `TUNING.ghost` —— `sampleIntervalMs` / `maxSamples` / `alpha` / `dataVersion`
- `TUNING.ai` —— `count` / `tints` / `names` / `gridOffsetPx` / `gridLateralPx` /
  `stuckMs` / `recoveryReverseMs` / `recoveryThrottle` / `stuckSpeedThreshold`
- `TUNING.difficulty` —— `easy` / `normal` / `hard` 三档完整参数
- `TUNING.save` —— `key: 'f1race.save.v3'` / `version: 3` / `historyLimit` / `rulesetVersion: 2`
- `DIFFICULTY_ORDER` / `DEFAULT_DIFFICULTY`

---

## 1. M3 —— 漂移（REQ-004）

> 需求：Space 为漂移键。漂移时侧滑角增加、抓地力下降，松开后恢复。
> 验收：按 Space 后车辆出现侧滑，松开后 0.5–1.5 秒内恢复抓地。

### 1.1 你要交付的文件

| 文件 | 动作 |
| --- | --- |
| `src/game/DriveInput.ts` | **新建**：把 `DriveInput` 接口与 `createDriveInput()` 从 `InputController.ts` 搬过来（不含任何 Phaser 依赖） |
| `src/game/InputController.ts` | **改**：删掉本地定义，改为 `export type { DriveInput } from './DriveInput';` 与 `export { createDriveInput } from './DriveInput';`（保持现有 import 路径可用） |
| `src/game/VehicleDynamics.ts` | **新建**：车辆纵向 + 横向运动学，纯逻辑 |
| `src/game/Vehicle.ts` | **改**：改为薄封装，把运动学委托给 `VehicleDynamics`，自己只管 sprite / Arcade body / 碰撞响应 |
| `tests/drift.test.ts` | **新建**：漂移行为的单元测试 |

### 1.2 `VehicleDynamics` 契约

```ts
import type { DriveInput } from './DriveInput';

export class VehicleDynamics {
  /** 车头朝向（弧度，0 = +x，顺时针为正）。 */
  heading: number;
  /** 沿车头方向的纵向速度（px/s，负值 = 倒车）。 */
  speed: number;
  /** 横向速度（px/s，车体右侧为正）。 */
  lateral: number;
  /** 当前地表速度上限系数（1 = 赛道）。 */
  surfaceFactor: number;
  /** 是否在赛道上。 */
  onTrack: boolean;

  constructor(options: { grassFactor: number; grassRecoverSeconds: number });

  /** 推进一帧。dt 单位为秒。 */
  step(dt: number, input: DriveInput, onTrack: boolean, allowDrive: boolean): void;

  /** 碰撞冲击：减速 + 沿法线弹开（横向也要受影响）。 */
  applyImpact(normalX: number, normalY: number, speedKeep?: number): void;

  /** 世界速度分量（已合成纵向与横向）。 */
  get velocityX(): number;
  get velocityY(): number;

  /** 侧滑角（弧度，atan2(lateral, |speed|)），恒为非负。 */
  get driftAngle(): number;
  /** 是否处于"漂移中"（侧滑角 > TUNING.vehicle.drift.driftAngleThreshold）。 */
  get isDrifting(): boolean;
  get speedKmh(): number;
  /** 重置到指定状态（瞬移 / 重开用）。 */
  reset(heading: number, speed?: number, lateral?: number): void;
}
```

### 1.3 行为契约（必须满足，且会被单元测试逐条验证）

沿用车 M1/M2 的纵向模型（`maxSpeed` / `engineAccel` / `brakeDecel` / `reverseRatio` /
`coastDecel` / `dragK` / `overspeedDecel` / `maxSteerRate` / `steerSpeedRef` /
`highSpeedSteerLoss` / `surfaceDropRate`），在其之上叠加横向维度：

| 编号 | 契约 | 判定方式 |
| --- | --- | --- |
| D1 | **不按 Space 时行为与 M1/M2 数值一致**：正常过弯横向速度几乎为 0 | 满转向跑 2 秒，`|lateral|` 始终 < 5 px/s |
| D2 | **按住 Space + 打方向会明显侧滑** | 车速 ≥ 380px/s 时按住 Space 且 steer=1，0.6 秒内 `driftAngle > 0.25` 弧度 |
| D3 | **松开 Space 后 0.5–1.5 秒内恢复抓地** | 从 D2 的状态松开，记录 `isDrifting` 变为 false 的耗时，落在 [0.5, 1.5] 秒 |
| D4 | **横向速度有硬上限** | `|lateral| <= TUNING.vehicle.drift.maxLateral`，任何情况下都不超过 |
| D5 | **合成速度不超过地表极速** | `hypot(speed, lateral) <= maxSpeed * surfaceFactor * 1.02`（草地上限同样成立） |
| D6 | **漂移不是白嫖**：同样时长同样转向下，漂移会比抓地慢一点 | 漂移 3 秒后的 `speed` 低于抓地 3 秒后的 `speed` |
| D7 | **漂移让车头转得更快** | 同样速度与转向输入下，漂移状态的 `heading` 变化量大于抓地状态 |
| D8 | **草地惩罚仍然生效** | `onTrack=false` 时稳态速度约为赛道的 0.6 倍（沿用 M1 行为） |
| D9 | **倒车 / 刹车行为不变** | 沿用 M1/M2 语义 |

横向演化建议（可自行调参，但必须满足上面 9 条）：
- 抓地：`lateral -= lateral * gripRate * dt`
- 漂移：`lateral -= lateral * driftGripRate * dt`，并叠加
  `lateral += input.steer * driftLateralPush * clamp(|speed| / maxSpeed, 0, 1) * dt * sign(speed)`
- 转向角速度在漂移时乘 `driftSteerBoost`
- 漂移时纵向额外阻力 `speed -= speed * driftSpeedScrub * dt`（配合 D6）

### 1.4 `Vehicle` 的公开 API（向后兼容，M1/M2 的调用点不能改）

必须保留：`sprite`、`body`、`input`、`isPlayer`、`heading`、`speed`、`surfaceFactor`、
`onTrack`、`x`、`y`、`speedKmh`、`applyImpact(nx, ny, keep?)`、
`placeAt(x, y, heading, speed?, lateral?)`、`update(dt, onTrack, allowDrive)`、`makeGhost()`。

新增（供集成层使用）：`lateral`、`driftAngle`、`isDrifting`、`dynamics`（可读的 `VehicleDynamics`）。

`Vehicle` 仍然负责：
- 用 `dynamics.velocityX/Y` 合成 knock 弹开速度后 `body.setVelocity(...)`
- `sprite.setRotation(heading + Math.PI / 2)`
- `handleContacts()`：撞墙时的首次弹开 + 墙面约束（**保持 M1 的实现逻辑**，
  它已经解决过"贴墙引擎空转"的问题；改为调用 `dynamics.applyImpact` 与 `dynamics.speed` 即可）
- 圆形碰撞体（半径 `TUNING.vehicle.bodyRadius`）

---

## 2. M4 —— 幽灵车（REQ-006 / REQ-018）

> 需求：记录最佳成绩的驾驶过程，生成半透明幽灵车，与玩家同赛道同时行驶，不是分屏。
> 幽灵车默认无碰撞、半透明，只作参考。幽灵车回放整场最佳。
> 验收：幽灵车按最佳记录回放，位置/角度与记录基本一致；不会与玩家或 AI 发生碰撞。

### 2.1 你要交付的文件

| 文件 | 动作 |
| --- | --- |
| `src/game/Ghost.ts` | **新建**：`GhostRecorder` + `GhostPlayback`，纯逻辑 |
| `src/game/SaveStore.ts` | **改**：升级到 v3，新增 `bestGhost` 与 `rulesetVersion` |
| `tests/ghost.test.ts` | **新建** |
| `tests/save.test.ts` | **改**：适配 v3 与新的迁移语义 |

### 2.2 `Ghost.ts` 契约

```ts
import type { GhostData } from './types';

/** 录制玩家驾驶轨迹：按固定时间间隔采样位置与朝向。 */
export class GhostRecorder {
  constructor(intervalMs: number, maxSamples: number);
  reset(): void;
  /**
   * 比赛计时推进时调用，内部按 intervalMs 决定是否真正落一个采样点。
   * elapsedMs 是这一帧结束时的比赛时间。
   */
  capture(elapsedMs: number, x: number, y: number, heading: number): void;
  /** 结束录制，产出可存档的数据。 */
  build(totalMs: number): GhostData;
  get sampleCount(): number;
}

/** 回放：按比赛时间查询插值后的位姿。 */
export class GhostPlayback {
  constructor(data: GhostData);
  readonly totalMs: number;
  /** 数据里实际记录到的时长（最后一帧的时间）。 */
  readonly recordedMs: number;
  /** 查询 elapsedMs 时刻的位姿；超出记录范围返回 null。 */
  sampleAt(elapsedMs: number): { x: number; y: number; heading: number } | null;
  /** 记录里是否没有任何有效帧。 */
  get isEmpty(): boolean;
}

/** 校验一份来路不明的幽灵数据是否可用（存档可能被手改过）。 */
export function isValidGhostData(value: unknown): value is GhostData;
```

采样与插值要求：
- `capture` 在 `elapsedMs` 距上次采样不足 `intervalMs` 时**不落点**；达到或超过时落一个点。
- 第一帧（`elapsedMs` 接近 0）必须落点，保证回放从起点开始。
- 超过 `maxSamples` 后停止采样，`build` 仍然返回已有数据。
- `sampleAt` 在相邻采样点之间做**线性插值**（位置线性、朝向用最短弧插值，
  避免 ±π 处翻转）。
- `sampleAt` 对 `elapsedMs < 0` 返回第一帧，对超过 `recordedMs` 返回 `null`。

### 2.3 `SaveStore` v3 契约

结构与新增字段：

```ts
export interface SaveData {
  version: number;                 // 3
  rulesetVersion: number;          // TUNING.save.rulesetVersion
  bestTotalMs: number | null;
  bestLapMs: number | null;
  bestSectorsMs: (number | null)[];
  bestLapCheckpointsMs: number[] | null;
  bestGhost: GhostData | null;     // 新增
  history: RunRecord[];
  updatedAt: string | null;
}
```

迁移规则（**重要**）：
1. 当前键是 `f1race.save.v3`；`LEGACY_KEYS` 必须包含 `'f1race.save.v2'` 与 `'f1race.save.v1'`。
2. 从旧键或旧版本号迁移时，保留 `bestTotalMs` / `bestLapMs` / `bestSectorsMs` /
   `bestLapCheckpointsMs` / `history` / `updatedAt`（能救的都救）。
3. **但如果存档里的 `rulesetVersion` 与当前 `TUNING.save.rulesetVersion` 不一致
   （旧档没有这个字段时视为 1），则清空全部"纪录"**：
   `bestTotalMs` / `bestLapMs` / `bestSectorsMs` / `bestLapCheckpointsMs` / `bestGhost` 置空，
   **`history` 保留**（它是流水账，不是纪录）。
   同时把只读属性 `recordsResetForRuleset` 置为 `true`，供 UI 提示玩家。
   原因：M3 引入漂移后物理规则变了，旧纪录不再可比。
4. 迁移后**先写新键、写成功再删旧键**（M2 踩过这个坑，别写反）。

`submit` 签名扩展为：

```ts
submit(record: RunRecord, bestLapCheckpointsMs: readonly number[] | null, ghost: GhostData | null): SubmitOutcome
```
- `ghost` **只在本次成绩有效且刷新了最佳总时间时**才写入 `bestGhost`。
- 新增只读 getter `bestGhost: GhostData | null`（返回深拷贝）。
- 其余现有 API 全部保留：构造函数选项、`bestTotalMs`、`bestLapMs`、`bestSectorsMs`、
  `bestLapCheckpointsMs`、`history`、`snapshot()`、`isPersistent`、`migratedFromVersion`、
  `submit`、`clear`。

> 注意：`RaceScene` 里现在调用的是 `submit(record, checkpoints)`（两个参数），
> 你可以把那个调用点补上第三个参数 `null` 让它编译通过，并在汇报里写明。

---

## 3. M5 —— AI 对手、难度与排名（REQ-007 / REQ-008 / REQ-016）

> 需求：同场 3 台 AI，能完成赛道不长期卡墙；难度分简单/普通/困难，
> 通过速度上限、转向精度、失误率区分；困难明显快于简单但不作弊到瞬移；
> 按 3 圈总时间排名，结算界面显示玩家与 AI 的排名。

### 3.1 你要交付的文件

| 文件 | 动作 |
| --- | --- |
| `src/game/Difficulty.ts` | **新建**：难度查表与校验 |
| `src/game/AIDriver.ts` | **新建**：AI 驾驶决策（含脱困） |
| `src/game/Ranking.ts` | **新建**：名次计算 |
| `tests/ai.test.ts` | **新建** |
| `tests/ranking.test.ts` | **新建** |

### 3.2 `Difficulty.ts` 契约

```ts
import type { DifficultyId, DifficultyProfile } from './types';

export const DIFFICULTIES: Record<DifficultyId, DifficultyProfile>;
export function getDifficulty(id: DifficultyId | string | null | undefined): DifficultyProfile;
/** 三档难度必须满足的单调性，用于自检与测试。 */
export function assertDifficultyOrdering(): void;
```

### 3.3 `AIDriver.ts` 契约

```ts
import type { DriveInput } from './DriveInput';
import type { DifficultyProfile, TrackQuery } from './types';

/** AI 只依赖车辆这几个量，便于单元测试传入假车。 */
export interface VehicleLike {
  x: number; y: number; heading: number; speed: number;
  /** 本帧是否撞到了东西（由集成层写入）。 */
  blocked?: boolean;
}

export class AIDriver {
  constructor(profile: DifficultyProfile, seed: number);
  /** 发车反应时间（毫秒），集成层据此延迟解锁油门。 */
  readonly reactionMs: number;
  /** 计算本帧输入写入 out（复用对象）。 */
  drive(vehicle: VehicleLike, track: TrackQuery, dtMs: number, out: DriveInput): void;
  /** 是否正在脱困（调试 / 测试用）。 */
  get isRecovering(): boolean;
  /** 当前档位。 */
  readonly profile: DifficultyProfile;
}
```

行为契约：

| 编号 | 契约 |
| --- | --- |
| A1 | 输出恒在合法范围：`throttle ∈ [-1,1]`、`steer ∈ [-1,1]`、`drift` 恒为 `false`（AI 不用漂移） |
| A2 | 目标速度不超过 `TUNING.vehicle.maxSpeed * profile.speedCapRatio`（用 `speed` 判定收油/给油） |
| A3 | 沿中心线能持续前进：在假赛道上模拟 N 秒，累计前进距离随难度单调递增（hard > normal > easy） |
| A4 | **能脱困**：当 `vehicle.blocked === true` 或连续 `TUNING.ai.stuckMs` 毫秒车速低于 `TUNING.ai.stuckSpeedThreshold` 时，进入 `isRecovering`，输出倒车（`throttle = TUNING.ai.recoveryThrottle`）并反向打舵；`TUNING.ai.recoveryReverseMs` 后退出脱困 |
| A5 | **确定性**：同一 seed + 同一输入序列，输出完全一致；不同 seed 会产生不同的失误时机 |
| A6 | **失误率生效**：`mistakeRatePerSecond` 越高，单位时间内出现的转向误差次数越多（用固定 seed 统计） |
| A7 | 走线偏移 `lineOffsetPx` 会让 AI 不贴死中心线 |

### 3.4 `Ranking.ts` 契约

```ts
import type { RacerProgress, RankedRacer } from './types';

/**
 * 排序规则：
 *  1. 已完赛的排在未完赛的前面；都完赛则按 finishMs 升序；
 *  2. 都未完赛则按 totalProgressPx 降序（= lapsCompleted * totalLength + lapArc）；
 *  3. 完全并列时玩家优先，其次按 id 字典序，保证结果稳定。
 */
export function rankRacers(entries: readonly RacerProgress[], totalLength: number): RankedRacer[];
```

### 3.5 测试要求

`tests/ai.test.ts` 必须包含一个**假的环形赛道**（自己实现 `TrackQuery`，例如半径 600px 的圆）
与一个**极简车辆积分器**（用 `AIDriver` 的输出推进 `heading` 与位置），然后验证：
- 三档难度在同一假赛道上跑固定时长，行驶距离严格 hard > normal > easy；
- 任意时刻速度不超过该档的速度上限；
- 构造一个"撞墙不动"的假车，验证 `isRecovering` 会被触发且输出倒车；
- 同 seed 两次运行结果完全一致。

`tests/ranking.test.ts` 覆盖：完赛优先、完赛按时间、未完赛按进度、并列时玩家优先、空数组、
以及 `lapArc` 与 `lapsCompleted` 组合出的进度排序。

---

## 4. 汇报格式

完成后请用中文简要汇报：

1. 新建 / 修改的文件清单（逐个一行）；
2. `tsc --noEmit` 的结果；
3. 你自己的测试文件跑了多少条、全过没有；
4. **你为了保持编译通过而改动的"不许动"的文件**（如果有，逐条写明改了什么、为什么）；
5. 任何你认为集成层需要知道的偏差、坑或未完成的点。

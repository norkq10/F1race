/** F1race 共享类型定义。 */

/** 与 public/assets/maps/<id>.meta.json 一一对应的赛道元数据。 */
export interface TrackMeta {
  version: number;
  /** 赛道 id（与地图文件名一致，多地图切换用）。 */
  id: string;
  /** 赛道显示名，HUD 上展示。 */
  name: string;
  /** 一句话说明赛道性格。 */
  desc: string;
  map: string;
  tileSize: number;
  grid: { width: number; height: number };
  world: { width: number; height: number };
  layers: { ground: string; track: string; decor: string; walls: string };
  /**
   * 瓦片 gid（Tiled 从 1 开始）。Phaser 运行时 `tile.index` 存的就是 gid，
   * 空瓦片为 -1，所以这里不需要再做 gid - firstgid 的换算。
   */
  tiles: Record<string, number>;
  surface: {
    /** 视作赛道（有抓地力）的瓦片 gid。 */
    trackGids: number[];
    /** 草地速度上限系数（0.6 = 下降 40%）。 */
    grassSpeedFactor: number;
    /** 离开草地后速度上限恢复所需秒数。 */
    grassRecoverSeconds: number;
  };
  laps: number;
  /**
   * 是否是**单程**赛道（点对点，不是绕圈）。
   *
   * `open: true` 时中心线的起点与终点**不是同一个地方**：
   *   - 进度到 `centerline.totalLength` 就是完赛，不做 `% total` 归一；
   *   - 没有"下一圈"，通常配 `laps: 1`；
   *   - 曲率 / 进度查询在两端要**夹住**而不是绕回（否则会把"起点切线与终点切线之差"
   *     算成一个根本不存在的尖角）。
   *
   * 生成器（`tools/gen-track.mjs`）与校验器（`tools/check-layout.mjs`）都认这个标记：
   * 不认的话它们会把终点硬连回起点，凭空多出一条斜穿全图的路。
   */
  open?: boolean;
  /** 起跑线位置与发车方向。所有车都并排在这条线上（横向错开由 TUNING.ai.gridLateralPx 决定）。 */
  start: { x: number; y: number; headingRad: number };
  centerline: { totalLength: number; points: [number, number][] };
}

/** 赛道进度查询结果。 */
export interface TrackProgress {
  /** 沿中心线的弧长（像素）。 */
  arc: number;
  /** 归一化进度 0..1。 */
  t: number;
  /** 到中心线的垂直距离（像素）。 */
  lateralDistance: number;
  /** 相对中心线的有符号偏移（左正右负）。 */
  signedLateral: number;
  /** 中心线在该处的切线方向（弧度）。 */
  tangent: number;
}

/** 中心线取点结果。 */
export interface CenterlineSample {
  x: number;
  y: number;
  /** 切线方向（弧度，0 = +x）。 */
  tangent: number;
}

/**
 * 赛道查询接口（Track 实现它）。
 * 只暴露坐标与几何，不暴露 Phaser 类型，这样 AI / 幽灵车等纯逻辑模块
 * 可以在单元测试里用一个假赛道驱动。
 */
export interface TrackQuery {
  readonly totalLength: number;
  progressAt(x: number, y: number): TrackProgress;
  pointAtArc(arc: number): CenterlineSample;
  tangentAtArc(arc: number): number;
}

// ---------------------------------------------------------------- M4 幽灵车

/** 幽灵车录制数据（存进 localStorage，所以用扁平数组省空间）。 */
export interface GhostData {
  version: number;
  /** 该场最佳成绩的总时间。 */
  totalMs: number;
  /** 采样间隔（毫秒）。 */
  intervalMs: number;
  /** 扁平数组：每 3 个数为 [x, y, heading]。 */
  frames: number[];
}

// ---------------------------------------------------------------- M5 AI

export type DifficultyId = 'easy' | 'normal' | 'hard' | 'inferno';

/**
 * 漂移决策的阈值（按难度档给，不再用一组全局常数）。
 *
 * 为什么拆出来：`TUNING.ai.driftCurvature` 是按 **track1/track3 的曲率分布**
 * 标定的（0.0045，"只在场最急的那几个弯触发"）。「漂移龙」的曲率分布完全不同
 * （实测同一套算法在这张图上 p95 就有 0.0059、max 0.0079），拿一个全局阈值去卡两张
 * 分布完全不同的图，必然是一张图不触发、另一张图狂触发。
 */
export interface DriftTuning {
  /** 超过这个曲率才考虑漂移（曲率 ≈ 1/半径）。 */
  curvature: number;
  /** 低于这个速度不漂（横向推力按速度缩放，低速漂只是原地打转）。 */
  minSpeed: number;
  /** 侧滑角超过它就收油停止漂移（漂移是"控制住的滑"）。 */
  maxAngle: number;
}

/** 一档难度的全部可调参数。 */
export interface DifficultyProfile {
  id: DifficultyId;
  /** 中文名，用于 UI。 */
  label: string;
  /** 目标速度上限（相对车辆极速的比例）。 */
  speedCapRatio: number;
  /** 纯追踪转向增益。 */
  steerGain: number;
  /** 过弯允许的横向加速度，越小越保守。 */
  corneringGrip: number;
  /** 前视距离基准（像素）。 */
  lookAheadBase: number;
  /** 前视距离随速度增长的比例。 */
  lookAheadPerSpeed: number;
  /** 每秒发生一次"失误"的概率。 */
  mistakeRatePerSecond: number;
  /** 单次失误持续时长（毫秒）。 */
  mistakeDurationMs: number;
  /** 失误时叠加的转向误差幅值（弧度）。 */
  mistakeSteerError: number;
  /** 常态走线偏移（像素），越大越不贴中心线。 */
  lineOffsetPx: number;
  /** 起步反应时间（毫秒），越大起步越慢。 */
  reactionMs: number;
  /**
   * 是否允许漂移过弯（CR-06）。
   *
   * ⚠️ 实测结论（`tools/tune-ai.mjs`）：**漂移对圈速是负收益**，
   * 三张图上开启后分别慢 0.13s / ±0s / 0.4s。原因见 `AIDriver` 里
   * `driftSpeedScrub` 的说明：漂移有额外纵向阻力，而 AI 的过弯本来就受
   * `steerAuthorityLimit()` 限制、并不是抓地力不够。
   * 所以现在**四档全关**，保留这个开关是为了等"超级 S 弯"那种
   * 必须靠漂移衔接的图做出来之后再打开。
   */
  useDrift?: boolean;
  /** 漂移阈值（按档可调；不填则用 `TUNING.ai` 的全局默认）。 */
  drift?: DriftTuning;
}

/** 一辆车在比赛中的进度快照，用于排名。 */
export interface RacerProgress {
  id: string;
  /** 已完成圈数。 */
  lapsCompleted: number;
  /** 本圈已累计的弧长（像素）。 */
  lapArc: number;
  /** 是否已经跑完规定圈数。 */
  finished: boolean;
  /** 完赛总时间；未完赛为 null。 */
  finishMs: number | null;
  /** 是否为玩家（用于并列时优先显示）。 */
  isPlayer: boolean;
}

/** 排名结果。 */
export interface RankedRacer extends RacerProgress {
  /** 名次，1 基。 */
  rank: number;
  /** 总进度（圈数 × 赛道长度 + 本圈弧长），用于未完赛者的排序。 */
  totalProgressPx: number;
}

// ---------------------------------------------------------------- 成绩记录

/** 单圈成绩。 */
export interface LapResult {
  /** 第几圈（1 基）。 */
  index: number;
  lapMs: number;
  valid: boolean;
  /** 判为无效的原因（valid 为 true 时为 null）。 */
  invalidReason: string | null;
  /** 每个分段用时（长度 = sectorCount）。 */
  sectorsMs: number[];
}

/** 一场比赛的成绩记录（写入本地历史）。 */
export interface RunRecord {
  /** ISO 时间戳。 */
  at: string;
  totalMs: number;
  bestLapMs: number | null;
  lapTimesMs: number[];
  /** 该场最佳圈的分段用时。 */
  sectorsMs: number[];
  /** 整场是否有效（所有圈都有效才算有效）。 */
  valid: boolean;
  invalidReason: string | null;
}

/** localStorage 存档结构（带版本号，便于迁移）。 */
export interface SaveData {
  version: number;
  bestTotalMs: number | null;
  bestLapMs: number | null;
  /** 各分段的历史最佳（长度 = sectorCount）。 */
  bestSectorsMs: (number | null)[];
  /**
   * 历史最佳圈的检查点用时曲线，用于实时 delta。
   * 长度 = checkpoints + 1，第 0 项恒为 0，最后一项等于该圈总时间。
   */
  bestLapCheckpointsMs: number[] | null;
  /** 最近若干场成绩（新的在前）。 */
  history: RunRecord[];
  updatedAt: string | null;
}

/** 结算界面里的一行排名（M5）。 */
export interface StandingEntry {
  /**
   * 参赛者 id（`player` / `ai1` / `ai2` / `ai3`）。
   *
   * 结算要用它去 `finishEstimatesMs` 这类**按 id 索引**的表里查东西。
   * 用 `name` 查是错的：name 是显示文案（"蓝队"），随时可能改成本地化文本，
   * 而 id 是稳定键 —— 这个坑真的踩了：预计完赛时间算出来了却查不到，
   * 界面上一直显示"第 N 圈"。
   */
  id: string;
  rank: number;
  name: string;
  isPlayer: boolean;
  /** 已完赛则为总时间；未完赛为 null。 */
  totalMs: number | null;
  /** 与冠军的差距（毫秒）；冠军为 0；冠军未完赛时为 null。 */
  gapMs: number | null;
  /** 未完赛时显示的进度描述，例如「第 3 圈」。 */
  progressLabel: string | null;
  /** 车手配色（领奖台小人用，与车身 tint 一致）。 */
  color: number;
}

/**
 * 比赛过程中的"超越自己"统计。
 *
 * 结算界面要回答的核心问题是"我比上次快了吗" —— 那件事由 RaceResult 里的
 * `deltaToPreviousBestMs` / `beatPersonalBest` 回答；这里补充的是
 * 只能逐帧采样的**本场自我表现**：最高车速、漂移时长、撞墙次数。
 */
export interface RaceProgressStats {
  /** 全场最高车速（px/s）。 */
  topSpeed: number;
  /** 漂移累计时长（毫秒）。 */
  driftMs: number;
  /** 撞墙累计次数。 */
  wallHits: number;
}

/** 单场比赛结束后的结算数据。 */
export interface RaceResult {
  /** 精确总时间（各圈用时之和）。 */
  totalMs: number;
  bestLapMs: number | null;
  lapResults: LapResult[];
  /** 最佳圈的分段用时；没有有效圈时为空数组。 */
  bestSectorsMs: number[];
  /** 有参考成绩时，本场总时间与历史最佳的差值（正 = 更慢）。 */
  deltaToPreviousBestMs: number | null;
  /** 整场是否有效。 */
  valid: boolean;
  /** 无效原因汇总（去重）。 */
  invalidReasons: string[];
  isNewBestTotal: boolean;
  isNewBestLap: boolean;
  previousBestTotalMs: number | null;
  /** 本场难度（M5）。 */
  difficulty: DifficultyId;
  /** 最终排名（M5），第一名在前，含玩家与 AI。 */
  standings: StandingEntry[];
  /** 玩家最终名次（1 基）。 */
  playerRank: number;
  /** 本场是否刷新/写入了幽灵车记录（M4）。 */
  ghostRecorded: boolean;
  /** 超越自己 / 场上超车等过程数据。 */
  progress: RaceProgressStats;
  /** 赛道信息，结算界面标题用。 */
  trackName: string;
  /** 是否刷新了本赛道最佳总时间 —— 结算里"新纪录"徽章用它。 */
  beatPersonalBest: boolean;
  /**
   * 本场是不是**冠军**（名次第 1）。
   *
   * 与 `beatPersonalBest` 是两个独立条件：跑出个人最佳但对手更快、或者拿了冠军
   * 却没刷新纪录，都很常见。抽奖的触发条件**是这两者的并集**（玩家要求
   * "只要拿了冠军就能抽奖"），所以分开记，别把其中一个当另一个用。
   */
  wonRace: boolean;
  /**
   * 本场结束后要不要放抽奖动画。
   *
   * 判据 = `beatPersonalBest || wonRace`，但**在这里算好并带出来**，而不是让
   * 结算界面 / 场景各自推一遍：抽奖的触发条件被改过两次（先是"只在中奖动画"，
   * 后来是"刷新纪录"，现在是"刷新纪录或夺冠"），散在多处的判据一定会漂移。
   */
  lotteryEligible: boolean;
  /**
   * 未完赛车的**预计完赛时间**（毫秒），key = car id。
   *
   * 为什么需要（known-issues 第 9 条）：玩家冲线即结束比赛，其他车还在跑，
   * 结算里它们只有"第 3 圈"这样的进度描述 —— 名次背后没有时间，
   * 读者没法判断"它到底还差多少"。这张表让结算能给出一个外推时间。
   * 样本不足（跑不到半圈）或已完赛的车不会出现在表里。
   */
  finishEstimatesMs: Map<string, number>;
}

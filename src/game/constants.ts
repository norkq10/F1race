/**
 * 全局可调参数。手感相关的数值集中在这里，方便按 REQ-012「街机爽快」反复调参。
 * 单位：距离 px（世界像素，1 瓦片 = 32px），时间 s。
 */

/**
 * 版本号**唯一来源**：`vite.config.ts` 在构建时把 `package.json` 的 `version`
 * 注入成 `__APP_VERSION__`。
 *
 * 为什么要有 `?? '0.0.0-dev'` 这个兜底：单元测试跑的是**源码**（Node 类型剥离），
 * 不经过 Vite，所以 `__APP_VERSION__` 在测试进程里根本不存在。
 * 直接引用会抛 `ReferenceError`。兜底值刻意写成明显的假版本，
 * 这样万一构建链断了，页面上会立刻显示 `0.0.0-dev` 而不是悄悄用旧号。
 *
 * 版本漂移由 `tests/version.test.ts` 拦住：它会拿这里的值与 `package.json` 对比。
 */
export const GAME_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/**
 * 里程碑标记。与版本号一起组成页面上显示的 `X.Y.Z (M6)`。
 *
 * 它**不是**版本号的一部分（避免又出现"两个地方各说各话"），
 * 只表示"这一版对应哪一段交付"。
 */
export const MILESTONE = 'M6';

export const TUNING = {
  /** 镜头：俯视正上方，主角固定在屏幕中心附近。 */
  camera: {
    zoom: 2,
    /**
     * 跟随插值。1 = 完全刚性跟随：镜头与车严格同步，主角恒定在屏幕正中，
     * 地图以整像素滚动，既没有滞后也不会抖。调小会引入跟随滞后（主角偏离中心）。
     */
    lerp: 1,
  },

  /** 街机赛车运动学（不完全依赖 Arcade 默认物理）。 */
  vehicle: {
    /** 赛道上直线极速。 */
    maxSpeed: 520,
    /** 满油门加速度。 */
    engineAccel: 640,
    /** 刹车减速度。 */
    brakeDecel: 1100,
    /** 倒车极速相对 maxSpeed 的比例。 */
    reverseRatio: 0.38,
    /** 松开油门后的自然减速。 */
    coastDecel: 210,
    /** 空气阻力系数，使极速收敛到 maxSpeed（= engineAccel / maxSpeed）。 */
    dragK: 640 / 520,

    /** 最大转向角速度。 */
    maxSteerRate: 3.1,
    /** 达到满转向能力所需速度。 */
    steerSpeedRef: 90,
    /** 高速时损失的转向能力比例。 */
    highSpeedSteerLoss: 0.42,

    /** 超过当地速度上限时向上限收敛的速率（草地减速的关键）。 */
    overspeedDecel: 3.2,
    /** 速度上限系数掉落到草地值所需速率（每秒变化量）。 */
    surfaceDropRate: 6.0,

    /** 碰撞后保留的速度比例。 */
    collisionSpeedKeep: 0.5,
    /** 贴墙摩擦（每秒比例）。 */
    collisionScrub: 1.4,
    /** 弹开初速。 */
    knockSpeed: 200,
    /** 弹开持续时间。 */
    knockSeconds: 0.16,
    /** 两次碰撞响应之间的最小间隔，避免贴墙时每帧掉速。 */
    contactCooldown: 0.25,

    /** 碰撞体半径（圆形，保证贴墙顺滑、不卡死）。 */
    bodyRadius: 12,
    /** 显示速度换算（px/s -> km/h）。 */
    speedToKmh: 0.46,

    /**
     * M3 漂移（REQ-004）。横向速度以"车体右侧为正"记在 VehicleDynamics 里。
     * 目标手感：
     *  - 不按漂移键时横向速度几乎为 0（正常过弯与 M1/M2 完全一致）；
     *  - 按住 Space + 打方向，侧滑角在 0.5 秒内涨到 0.25 弧度以上；
     *  - 松开 Space 后 0.5～1.5 秒内回到抓地状态（侧滑角 < recoverAngleThreshold）。
     */
    drift: {
      /** 正常抓地力：横向速度按此速率衰减（每秒比例）。 */
      gripRate: 16,
      /** 漂移时的抓地力，明显更低才有侧滑。 */
      driftGripRate: 1.9,
      /** 漂移时转向角速度的倍率，让车头甩得更快。 */
      driftSteerBoost: 1.6,
      /** 漂移时每个单位转向输入产生的横向推力（px/s²），再按速度比例缩放。 */
      driftLateralPush: 340,
      /** 漂移时的额外纵向阻力（每秒比例），保证漂移不是无脑更快。 */
      driftSpeedScrub: 0.5,
      /** 判定"正在漂移"的侧滑角阈值（弧度）。 */
      driftAngleThreshold: 0.12,
      /** 判定"恢复抓地"的侧滑角阈值（弧度）。 */
      recoverAngleThreshold: 0.06,
      /** 横向速度硬上限（px/s）。 */
      maxLateral: 300,
    },
  },

  /** M4 幽灵车（REQ-006 / REQ-018）。 */
  ghost: {
    /** 采样间隔（毫秒）。20Hz 足够平滑，一整场约 1000 个采样点。 */
    sampleIntervalMs: 50,
    /** 单场录制的采样点上限，防止异常长跑把 localStorage 撑爆。 */
    maxSamples: 4000,
    /** 幽灵车透明度（REQ-018：半透明）。 */
    alpha: 0.45,
    /**
     * 幽灵车在小地图上的光点颜色。
     *
     * 用一个中性偏冷的青色，和四个车手的红/蓝/黄/绿都拉得开 ——
     * 幽灵车不是"对手"，不该和真车抢颜色识别。
     */
    tint: 0x9fe8ff,
    /** 幽灵车贴图（与玩家同款造型，不同配色）。 */
    dataVersion: 2,
  },

  /**
   * 车与车的接触（CR-06 第 2 / 3 项）。
   *
   * 尾流（draft）与并排摩擦都是**物理规则**，对玩家与 AI 同时生效 ——
   * 不是 AI 特权，所以不违反项目"AI 不作弊"的立场。
   */
  contact: {
    /**
     * 尾流区长度（像素）：车头前方这个距离内有同向车时，空气阻力变小。
     *
     * 140px 大约是 2.3 个车身长 —— 够近才有意义，太远就成了"隔着半条直道也吃尾流"。
     */
    draftRangePx: 140,
    /** 尾流允许的最大航向差（弧度，约 20°）：差太多就是横向交错，不是跟车。 */
    draftMaxHeadingRad: 0.35,
    /**
     * 尾流区内的发动机输出倍率。
     *
     * 0.85 = 多 15% 推力。这个量级够形成"跟车能追上"的战术，
     * 又不至于让落后车白嫖到直接超车。
     */
    draftFactor: 0.85,
    /** 判定"在前方"时，投影到车头方向的最小长度（像素）。 */
    draftMinForwardPx: 8,

    /** 接触时的切向摩擦系数（0..1）。 */
    friction: 0.35,
    /** 接触时的弹性回弹系数（0..1）。刻意小，大了就是"一碰就弹飞"。 */
    bounce: 0.18,
    /**
     * 单次接触的速度传递上限（px/s）。
     *
     * 并排贴着跑时两车会**每帧**接触，没有上限会逐帧累积、几帧内把速度吸干。
     */
    maxSpeedTransfer: 90,
  },

  /** M5 AI 对手（REQ-007 / REQ-008 / REQ-016）。 */
  ai: {
    /** 同场 AI 数量（REQ-007：3 台）。 */
    count: 3,
    /** 三台 AI 的显示颜色（同一张贴图 + tint）。 */
    tints: [0x3ba7ff, 0xffc63b, 0x54e06a],
    /** 名字，用于排名显示。 */
    names: ['蓝队', '黄队', '绿队'],    /**
     * 发车线横向间隔（像素）：所有车并排在同一条起跑线上，只做左右错开。
     *
     * 30px 是按"既在赛道内、又不重叠"定的：
     *   - 车道顺序 0 / −1 / +1 / −2 摊开成 0 / −30 / +30 / −60，最外侧离中心线 60px，
     *     仍在赛道半宽 73.6px 以内（再大就压到路肩上了）；
     *   - 相邻车中心距 30px > 车身直径 24px，一开赛不会先互相撞一下。
     */
    gridLateralPx: 30,
    /** 撞墙后持续多久判定为"卡住"（毫秒）。 */
    stuckMs: 900,
    /** 脱困时倒车持续时长（毫秒）。 */
    recoveryReverseMs: 900,
    /** 脱困时倒车油门。 */
    recoveryThrottle: -1,
    /** 卡住判定速度阈值（px/s）。 */
    stuckSpeedThreshold: 45,

    /**
     * 漂移决策（CR-06 第 1 项）：只有 `useDrift: true` 的档位才会用到这几个数。
     *
     * ⚠️ `driftCurvature` 必须按 **AI 自己测到的曲率** 来定，不能拿赛道几何曲率。
     * 两者差得很远：`AIDriver` 用前视点（`look = 70 + speed × 0.9`）估算曲率，
     * 那段弦会把急弯削平。实测（`node --import ./tools/ts-register.mjs tools/probe-curvature.mjs`）：
     *   - track1 几何最急弯 124px → 几何曲率 0.0081，但 AI 测到的 **max 只有 0.0051**
     *   - track3 几何最急弯 137px → 几何曲率 0.0073，AI 测到的 **max 只有 0.0037**
     *   - 两图的中位曲率都在 0.0008 以下（大部分路段是直道）
     * 所以阈值取 0.0045：落在 track1 的 p99 与 max 之间 ——
     * **只会在全场最急的那几个弯触发**，中速弯仍然走抓地跑法。
     *
     * 第一版误按几何曲率定成 0.0065，结果漂移帧数恒为 0：条件永远不成立，
     * 而圈速看起来完全正常，是个非常隐蔽的失效。所以加了 `probe-curvature.mjs`
     * 与 `AIDriver.driftFrames` 这两件工具，让"没触发"能被直接看见。
     *
     * `driftMinSpeed`: 速度太低时漂移只会让它原地打转（横向推力按速度缩放）。
     * `driftMaxAngle`: 侧滑角超过它就收油 —— 漂移是"控制住的滑"，不是失控。
     */
    driftCurvature: 0.0045,
    driftMinSpeed: 260,
    driftMaxAngle: 0.5,
  },

  /**
   * 三档难度（REQ-008）。
   * 只用「速度上限 / 转向精度 / 失误率」区分，不做瞬移之类的作弊。
   *
   * speedCapRatio 是按**实测圈速**定的，标尺是 track1（单圈 7532px，3 圈）：
   * 玩家正常水平约 45 秒（≈502px/s，几乎贴着 520px/s 的车辆极速），
   * 所以困难档定在 48～50 秒 —— AI 全程不能有明显失误才有机会赢过玩家，
   * 但玩家偶尔一次小失误也还追得回来。
   *   简单 0.74 ≈ 60 秒   普通 0.86 ≈ 54 秒   困难 0.97 ≈ 49 秒
   *
   * 改完这几个数必须重跑实测核对圈速：
   *   node --import ./tools/ts-register.mjs tools/measure-ai.mjs
   * tests/ai.test.ts 里也有一条"真实赛道圈速单调 + 区间"的断言兜底。
   *
   * 另外：这三张赛道的弯都偏缓，实测曲率限速（corneringGrip / steerAuthorityLimit）
   * 并不生效，圈速基本只由速度上限决定，所以调难度优先动 speedCapRatio。
   */
  difficulty: {
    easy: {
      id: 'easy',
      label: '简单',
      speedCapRatio: 0.74,
      steerGain: 2.0,
      corneringGrip: 900,
      lookAheadBase: 90,
      lookAheadPerSpeed: 0.4,
      mistakeRatePerSecond: 0.05,
      mistakeDurationMs: 520,
      mistakeSteerError: 0.16,
      lineOffsetPx: 55,
      reactionMs: 260,
    },
    normal: {
      id: 'normal',
      label: '普通',
      speedCapRatio: 0.86,
      steerGain: 2.4,
      corneringGrip: 1200,
      lookAheadBase: 110,
      lookAheadPerSpeed: 0.45,
      mistakeRatePerSecond: 0.016,
      mistakeDurationMs: 420,
      mistakeSteerError: 0.1,
      lineOffsetPx: 30,
      reactionMs: 140,
    },
    hard: {
      id: 'hard',
      label: '困难',
      speedCapRatio: 0.97,
      steerGain: 2.9,
      corneringGrip: 1550,
      lookAheadBase: 130,
      lookAheadPerSpeed: 0.5,
      mistakeRatePerSecond: 0.003,
      mistakeDurationMs: 300,
      mistakeSteerError: 0.05,
      lineOffsetPx: 12,
      reactionMs: 60,
      /**
       * 困难档 AI 是否漂移过弯（CR-06 第 1 项）。
       *
       * **仍然刻意关掉**，而且现在有实测支撑（2026-10-04）：
       * 用 `node --import ./tools/ts-register.mjs tools/tune-ai.mjs --sweep` 在
       * 三张图上打开漂移，圈速分别**慢了 0.13s / ±0s / 0.40s**。
       * 原因不是"AI 不会漂"，而是**漂移过弯本来就不快**：
       *   - AI 的过弯速度由 `steerAuthorityLimit()`（转向机能力）决定，
       *     不是抓地力不够 —— 抓地跑法已经能贴住线；
       *   - 漂移有额外纵向阻力（`TUNING.vehicle.drift.driftSpeedScrub`），
       *     稳态速度从 520 掉到约 370px/s，用掉的比赚回来的多。
       * 漂移真正的价值是"**甩出去的线**"—— 那是给"连续 S 弯、必须用漂移衔接"
       * 的图准备的（CR-16 的「漂移龙」虽然弯多，但半径仍然够大，
       * 抓地跑法就是更快）。等那种图做出来再打开，别为了"看起来在漂"白白慢 0.4 秒。
       *
       * 阈值本身已按档可调（`DifficultyProfile.drift`），换图时不必再动全局常数。
       */
      useDrift: false,
    },
    /**
     * 炼狱（P1.5 追加档，2026-10-04）。
     *
     * 定位：**逼近甚至略超玩家的极限**。玩家要求"困难挑战性不够"，
     * 而困难档已经用满了 `speedCapRatio`（0.97）。炼狱把剩下的唯一杠杆拉满：
     *
     * | 参数 | 困难 | 炼狱 | 理由 |
     * | --- | --- | --- | --- |
     * | `speedCapRatio` | 0.97 | **1.00** | 直道上用满车辆极速（520px/s），实测这是主要收益 |
     * | `corneringGrip` | 1550 | **8000** | 解除"曲率限速"这一层，让转向机能力成为唯一约束 |
     * | `reactionMs` | 60 | **30** | 起步更快 |
     * | `steerGain` | 2.9 | **3.2** | 跟线更紧（再大反而略慢，见下面的实测） |
     * | `lineOffsetPx` | 12 | **0** | 不画蛇，走最短线 |
     * | `mistakeRatePerSecond` | 0.003 | **0.001** | 整场几乎不失误 |
     *
     * 实测（3 个 seed 平均，`tools/tune-ai.mjs`）：
     *   环城 3 圈 48.09 → **46.7s**；峡谷 3 圈 64.44 → **62.1s**；
     *   漂移龙 1 趟 45.92 → **44.9s**。三张图都是干净完赛（贴墙 0 帧）。
     *
     * ⚠️ **再往上空间很小**：速度上限已经顶到 1.0，剩下唯一的物理约束是
     * `steerAuthorityLimit()`（车辆转向机能力，`TUNING.vehicle.maxSteerRate`）。
     * 想再快只能改车本身（转向速率 / 极速），那会**同时**影响玩家 —— 不是难度档该干的事。
     */
    inferno: {
      id: 'inferno',
      label: '炼狱',
      speedCapRatio: 1,
      steerGain: 3.2,
      corneringGrip: 8000,
      /**
       * 前视距离。**必须严格大于困难档**（`Difficulty.assertDifficultyOrdering` 会抛错，
       * 这是刻意的摩擦：档位参数必须单调，否则"更难的档"可能在某个维度上更弱）。
       * 实测 110/0.45 与 135/0.52 的圈速差不到 0.1s，所以按单调性取后者。
       */
      lookAheadBase: 135,
      lookAheadPerSpeed: 0.52,
      mistakeRatePerSecond: 0.001,
      mistakeDurationMs: 240,
      mistakeSteerError: 0.04,
      lineOffsetPx: 0,
      reactionMs: 30,
      useDrift: false,
    },
  },

  race: {
    /**
     * 圈数（REQ-011）。
     *
     * ⚠️ **运行时已经不用它了**：圈数跟着赛道走（`public/assets/maps/<id>.meta.json` 的
     * `laps`，运行时由 `Track.lapCount` 透出）—— 「漂移龙」是单程 1 趟，另外两条是 3 圈。
     * 保留它只是因为 `tools/measure-ai.mjs` 与 `tests/ai.test.ts` 拿它当"闭环赛道默认圈数"
     * 使用（那些场景只跑 track1/track3）。**改赛道圈数请改 meta，不要改这里。**
     */
    laps: 3,
    /** 倒计时总时长：3-2-1 各 1 秒，归零瞬间放出 GO! 并解锁操作。 */
    countdownMs: 3000,
    /** 倒计时每个数字停留时长。 */
    countdownStepMs: 1000,
    /** GO! 字样停留时长。 */
    goDisplayMs: 800,

    /** 分段时间数（S1/S2/S3）。 */
    sectorCount: 3,
    /** 每个分段内记录几个检查点；总检查点数 = sectorCount * checkpointsPerSector。 */
    checkpointsPerSector: 8,
    /**
     * 无效圈判定：一帧内沿中心线的弧长增量不应超过 `maxSpeed * dt * 该系数`。
     * 抄近道 / 切弯会让进度瞬间跳跃，超过阈值即判本圈无效。
     */
    progressJumpTolerance: 1.25,
    /** 阈值兜底余量（像素），避免极小 dt 下被浮点误差误判。 */
    progressJumpSlackPx: 40,
  },

  save: {
    key: 'f1race.save.v3',
    version: 3,
    /** 本地保留的最近成绩条数。 */
    historyLimit: 10,
    /**
     * 操控规则版本。M3 引入漂移后物理规则变了，旧纪录不再可比，
     * 读到不同 ruleset 的存档时会清空"纪录"（保留成绩历史），并提示玩家。
     */
    rulesetVersion: 2,
  },

  /**
   * 结算抽奖（老虎机）。
   *
   * 只在**刷新了本赛道最佳总时间**时触发。CR-15 之后中奖**会产出车辆皮肤**
   * （见 `TUNING.skins`），所以它不再是纯演出：
   *   - 中奖 → `pickSkinDrop` 抽一款 → `SkinStore.unlock` 落盘 → 面板上给明确文案
   *   - 重复抽到已有的 → 按 `TUNING.skins.duplicateReward` 提示，**不静默吞掉**
   */
  lottery: {
    /**
     * 抽奖总开关。
     *
     * **发布默认开启**（2026-10-04 由 `false` 改为 `true`）。
     *
     * CR-08 当初要求"发布默认关闭"，理由是那时的抽奖**没有产出**：一个不影响任何数值、
     * 又不给任何东西的随机动画，只会稀释"刷新纪录"的成就感。CR-15 之后它已经有了
     * 真实产出（按 `TUNING.skins.dropTable` 解锁皮肤），而皮肤是这游戏唯一的
     * 可累积收集品 —— 关掉它等于把收集系统整个藏起来。
     *
     * ⚠️ CR-08 真正的硬要求**只是"发布默认值不得是 0.99"**，那条仍然成立（见 `winRate`）。
     * 开关本身留着，是为了需要"纯计时"的场合（回归测试、录像）能一键关掉。
     *
     * 触发条件：**刷新本赛道最佳总时间 或 拿到冠军**（见 `RaceResult.lotteryEligible`）。
     */
    enabled: true,
    /**
     * 中奖概率。
     *
     * 99% 是测试阶段的临时值，**不再是发布默认**（CR-08 明令禁止）。
     * 这里取 35%：足以让"抽到新皮肤"成为一个需要几场比赛的收集目标，
     * 又不至于让玩家觉得永远抽不到（发布配置下抽奖本身默认是关的，
     * 这个值只在 `?lottery=test` 或将来正式开启时才生效）。
     */
    winRate: 0.35,
    /** `?lottery=test` 调试覆盖用的中奖率：接近必中，方便自动化验收走通整条链路。 */
    testWinRate: 0.99,
    /** 三个转轮的转动时长（毫秒），逐轮略有差别看起来更像真机器。 */
    spinMs: [1400, 1750, 2100],
    /**
     * 结算面板弹出后，隔多久再弹抽奖面板。
     *
     * 结算里的领奖台是逐个登台的（每个间隔 120ms，4 个约 500ms），
     * 所以这里留 1100ms 让它站齐、玩家看清排名，再开抽奖。
     */
    openDelayMs: 1100,
  },

  /**
   * 车辆皮肤系统（CR-15）。
   *
   * 皮肤的**存在意义**：给抽奖一个实质产出。抽奖原本只决定放不放中奖动画，
   * 中奖道具不接任何效果 —— 在一个"刷时间 = 实力证明"的游戏里，
   * 没有产出的随机奖励比没有奖励更伤。
   *
   * ⚠️ 皮肤**不影响任何数值**（速度 / 抓地 / 碰撞 / 计时）。
   * `tests/skins.test.ts` 有一条白名单断言专门守这件事。
   */
  skins: {
    /**
     * 抽奖掉落权重表。
     *
     * 稀有的两款（幽灵白 / 黄金）合计 15%，其余的给常见款；
     * `default` **刻意不在表里** —— 那是初始皮肤，抽到它等于空奖。
     */
    dropTable: [
      { id: 'red', weight: 30 },
      { id: 'blue', weight: 30 },
      { id: 'carbon', weight: 25 },
      { id: 'ghost', weight: 8 },
      { id: 'gold', weight: 7 },
    ],
    /**
     * 重复抽到已拥有皮肤时的处理方式。
     *
     * - `'notice'`：只提示"已拥有"（首版采用，最简单也最诚实）
     * - `'currency'`：折算成抽奖券（需要额外的货币系统，暂不做）
     *
     * 无论选哪个，**都不允许静默吞掉** —— 玩家会记恨那种做法。
     */
    duplicateReward: 'notice' as 'notice' | 'currency',
  },
};

/** 难度预设的便捷访问。 */
export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'inferno'] as const;
export const DEFAULT_DIFFICULTY = 'normal';


/**
 * 可选赛道清单（REQ：多地图）。
 *
 * 新增赛道只需要在这里加一条，并保证 public/assets/maps/<id>.json 与
 * <id>.meta.json 存在（用 `node tools/gen-track.mjs` 生成）。
 * 顺序即 HUD 上按钮的显示顺序，第一条是默认赛道。
 *
 * ⚠️ 这里只列**赛道 id**：圈数与拓扑（闭环 / 单程）都写在各自的 meta 里
 * （`laps` / `open`），运行时由 `Track.lapCount` / `Track.isOpen` 透出来。
 * 不要在 constants 里再存一份圈数 —— 那一定会和 meta 漂移。
 */
export const TRACK_ORDER = ['track1', 'track3', 'track4'] as const;
export type TrackId = (typeof TRACK_ORDER)[number];

/** 赛道选择持久化 / URL 参数用的键。 */
export const TRACK_SELECT_STORAGE_KEY = 'f1race.track';

/** 默认赛道（新玩家第一次进来跑的那条）。 */
export const DEFAULT_TRACK_ID: TrackId = 'track1';

/** 赛道名称（HUD 兜底显示用；地图元数据里也有同一份，读取失败时用这个）。 */
export const TRACK_LABELS: Record<TrackId, string> = {
  track1: '环城赛道',
  track3: '峡谷技术环',
  track4: '漂移龙',
};

/** HUD 选图按钮上的短名（比全名短，避免选图栏被挤爆）。 */
export const TRACK_SHORT_LABELS: Record<TrackId, string> = {
  track1: '环城',
  track3: '峡谷技术',
  track4: '漂移龙',
};

/**
 * 车手配色（车身 tint + 结算领奖台小人颜色）。
 *
 * `player` 与 `ai` 的顺序必须和 TUNING.ai.tints 一一对应：
 * 玩家红、蓝队、黄队、绿队。领奖台小人与车用同一套颜色，
 * 玩家一眼就能对上"哪个小人是我"。
 */
export const RACER_COLORS = {
  player: 0xe23c38,
  ai: [0x3ba7ff, 0xffc63b, 0x54e06a],
} as const;

/** 车手名字（玩家 + AI，顺序与车身 tint 一致）。 */
export const RACER_NAMES = ['玩家', '蓝队', '黄队', '绿队'] as const;

/** 资源键名（占位素材，可同名替换正式素材）。 */
export const ASSETS = {
  tilesetKey: 'tiles',
  tilesetUrl: 'assets/tiles/tileset_placeholder.png',
  carPlayerKey: 'car_player',
  carPlayerUrl: 'assets/cars/car_player_placeholder.png',
  carAiKey: 'car_ai',
  carAiUrl: 'assets/cars/car_ai_placeholder.png',
  carGhostKey: 'car_ghost',
  carGhostUrl: 'assets/cars/car_ghost_placeholder.png',
  /**
   * 皮肤贴图的键前缀 / 目录（CR-15）。
   *
   * 玩家皮肤贴图由 `tools/gen-assets.mjs` 的 `SKIN_PALETTES` 生成到
   * `public/assets/cars/player_<suffix>.png`，尺寸与其它车贴图一致（28×42）。
   * 键与 URL 都由下面的 `skinAssetKey` / `skinAssetUrl` 推导，不要在别处硬编码。
   */
  skinKeyPrefix: 'car_skin_',
  skinUrlDir: 'assets/cars',
  skinUrlPrefix: 'player_',
} as const;

/**
 * 皮肤贴图后缀的必填清单（CR-15）。
 *
 * ⚠️ 这三个列表必须**同时**改：
 *   1. `src/game/Skins.ts` 的 `SKINS[*].assetSuffix`
 *   2. `tools/gen-assets.mjs` 的 `SKIN_PALETTES` 键
 *   3. 这里（它决定 `BootScene` 会不会去加载那张图）
 *
 * 之所以在 constants 里再列一份、而不是从 `Skins.ts` 推导：`constants` 是叶子模块，
 * 被 Skins / SkinStore / 场景共同依赖。反过来 import 会绕出循环依赖。
 * `tests/skins.test.ts` 有一条断言把这个列表与 `SKINS` 锁在一起 —— 漏改哪边都会红。
 */
export const SKIN_ASSET_SUFFIXES = ['default', 'red', 'blue', 'carbon', 'ghost', 'gold'] as const;

/** 皮肤贴图后缀。写成联合类型，拼错后缀在 `tsc` 阶段就报错。 */
export type SkinAssetSuffix = (typeof SKIN_ASSET_SUFFIXES)[number];

/** 皮肤贴图的 Phaser 缓存键：`car_skin_<suffix>`。 */
export function skinAssetKey(suffix: SkinAssetSuffix): string {
  return `${ASSETS.skinKeyPrefix}${suffix}`;
}

/** 皮肤贴图的加载路径：`assets/cars/player_<suffix>.png`。 */
export function skinAssetUrl(suffix: SkinAssetSuffix): string {
  return `${ASSETS.skinUrlDir}/${ASSETS.skinUrlPrefix}${suffix}.png`;
}

/** 赛道的资源键名（瓦片地图 + 元数据）。 */
export function trackAssetKeys(id: string): { mapKey: string; metaKey: string; mapUrl: string; metaUrl: string } {
  return {
    mapKey: id,
    metaKey: `${id}_meta`,
    mapUrl: `assets/maps/${id}.json`,
    metaUrl: `assets/maps/${id}.meta.json`,
  };
}

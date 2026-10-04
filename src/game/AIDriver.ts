import { TUNING } from './constants';
import type { DriveInput } from './DriveInput';
import type { DifficultyProfile, TrackQuery } from './types';

/**
 * AI 只依赖车辆这几个量，便于单元测试传入假车。
 * 集成层每帧把 `blocked`（本帧是否撞到东西）写进来即可。
 */
export interface VehicleLike {
  x: number;
  y: number;
  heading: number;
  speed: number;
  /** 本帧是否撞到了东西（由集成层写入）。 */
  blocked?: boolean;
  /** 当前侧滑角（弧度）。漂移决策要用；假车不提供时按 0 处理。 */
  driftAngle?: number;
}

/** 脱困状态机的三个阶段。 */
type RecoveryPhase = 'none' | 'reverse' | 'realign';

/**
 * 走线偏移的安全走廊（像素）：车越偏离中心线，叠加的偏移越小。
 * 少了这道收窄，`lineOffsetPx` 大的简单档会把 AI 主动推向墙。
 */
const OFFSET_CORRIDOR_PX = 60;
/** 走线偏移的波长（像素）：太长等于固定偏移，太短会来回画蛇。 */
const OFFSET_WAVELENGTH_PX = 1500;
/**
 * 脱困倒车结束后、重新起步前的对线时长（毫秒）。
 * 这段时间 `isRecovering` 已经是 false，但"卡住"计时不累计，
 * 否则车刚倒出来、速度还没上来就会被判定二次卡住，来回倒车出不去。
 */
const REALIGN_MS = 320;
/** 对线阶段的油门上限：轻给油重新起步比一脚油门怼墙更容易脱身。 */
const REALIGN_THROTTLE = 0.55;
/** 收油 / 给油的滞环，避免速度贴着目标值时油门每帧抖动。 */
const THROTTLE_ON_RATIO = 0.98;
const THROTTLE_OFF_RATIO = 1.01;
/** 超过目标速度后的刹车力度（小于 1，留一点修正余地）。 */
const OVERSPEED_BRAKE = -0.6;
/** 偏离中心线的收油系数与上限（沿用 AutoPilot 的手感）。 */
const OFF_LINE_SLOWDOWN_K = 1.2;
const OFF_LINE_SLOWDOWN_MAX = 120;
/** 目标速度下限，避免 AI 在急弯里停下来。 */
const MIN_TARGET_SPEED = 150;
/**
 * 开始收短前视距离的曲率（约等于半径 250px 的弯）。
 * 纯追踪的前视点是一段弦，弯越急、弦越长，切进弯心的深度就越大
 * （切深 ≈ L² / 8R）：在只有 2.3 瓦片半宽的赛道上，长前视会直接把 AI 送进内侧墙。
 */
const CORNER_CURVATURE_REF = 0.004;
/** 急弯里前视距离最多收短到这个程度。 */
const CORNER_LOOKAHEAD_SHRINK = 0.55;

/** 角度归一化到 (-π, π]。纯逻辑模块不能 import Phaser 的值，所以自己写。 */
function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * 用"转向能力"反推出的过弯速度上限。
 *
 * 跟着半径 R 的弯走，需要偏航角速度 `v / R = v × curvature`；
 * 车辆能提供的偏航角速度上限是 `maxSteerRate × (1 - highSpeedSteerLoss × v / maxSpeed)`。
 * 两者相等时解出的 v 就是"再怎么打方向也拐不过去"的临界速度 —— 超过它必然冲出赛道，
 * 和抓地力（corneringGrip）无关，纯几何 + 转向机能力。半径 250px 以上的弯才不触发。
 */
function steerAuthorityLimit(curvature: number): number {
  const V = TUNING.vehicle;
  if (curvature <= 1e-6) return Number.POSITIVE_INFINITY;
  const decay = (V.maxSteerRate * V.highSpeedSteerLoss) / V.maxSpeed;
  return V.maxSteerRate / (curvature + decay);
}

/**
 * AI 驾驶决策（M5 / REQ-007 / REQ-008）。
 *
 * 思路沿承 M1 的 `AutoPilot`（前视点纯追踪 + 曲率限速），在此之上加三样东西：
 *  - **难度**：速度上限、转向增益、前视距离、失误率、走线偏移全部来自 `DifficultyProfile`；
 *  - **失误**：由带 seed 的确定性 PRNG 调度，同一 seed 的整场比赛逐帧可复现；
 *  - **脱困**：撞墙或长时间低速时进入倒车状态机（A4），不倒车就一定会长期卡墙。
 *
 * 这里是**纯逻辑**：不 import Phaser 的任何值（只有 `import type`），
 * 所以"困难明显快于简单"可以在 `tests/ai.test.ts` 里用假赛道真正跑出来验证，
 * 而不是靠人肉试玩。
 */
export class AIDriver {
  readonly profile: DifficultyProfile;
  /** 发车反应时间（毫秒），集成层据此延迟解锁油门（本类内部也已生效，见 `drive`）。 */
  readonly reactionMs: number;

  private readonly seed: number;
  /** PRNG 状态（mulberry32），reset 时回到 seed，保证重开比赛结果一致。 */
  private rngState: number;
  /** 走线偏移的初相：由 seed 决定，让同档位的多台 AI 各走各的线。 */
  private readonly linePhase0: number;

  private elapsedMs = 0;

  /**
   * 本档生效的漂移阈值。
   *
   * 档位没配 `drift` 时回落到 `TUNING.ai` 的全局常数（历史值，按 track1/track3 标定），
   * 这样加 `drift` 字段之前的行为完全不变。
   */
  private readonly driftConfig: { curvature: number; minSpeed: number; maxAngle: number };

  /** 是否"真正跑起来过"。倒计时期间车速恒为 0，不能据此判定卡住。 */
  private armed = false;
  /** 连续低速累计时长（毫秒）。 */
  private stuckMs = 0;
  private phase: RecoveryPhase = 'none';
  private phaseLeftMs = 0;

  /** 失误剩余时长（毫秒），> 0 表示正在失误。 */
  private mistakeLeftMs = 0;
  /** 本次失误叠加的转向误差（带符号，弧度）。 */
  private mistakeSteer = 0;
  /** 距离下一次失误的剩余时长（毫秒）。 */
  private nextMistakeMs: number;
  private mistakes = 0;

  /** 本场累计输出过多少帧 `drift: true`（CR-06 验收用）。 */
  private driftFramesCount = 0;
  /** 最近一帧测到的前方曲率（调参用，判断漂移阈值是否可达）。 */
  private lastCurvatureValue = 0;

  constructor(profile: DifficultyProfile, seed: number) {
    this.profile = profile;
    this.reactionMs = profile.reactionMs;
    // 漂移阈值：档位没配就用全局历史值（= 加 `drift` 字段之前的行为）
    this.driftConfig = {
      curvature: profile.drift?.curvature ?? TUNING.ai.driftCurvature,
      minSpeed: profile.drift?.minSpeed ?? TUNING.ai.driftMinSpeed,
      maxAngle: profile.drift?.maxAngle ?? TUNING.ai.driftMaxAngle,
    };
    this.seed = seed >>> 0 || 0x9e3779b9;
    this.rngState = this.seed;
    // 初相用一次乘法散列打散：集成层通常按 1/2/3 给 seed，
    // 直接取模会让三台 AI 的走线几乎同相，看起来像粘在一起。
    const hash = Math.imul(this.seed ^ 0x9e3779b9, 2654435761) >>> 0;
    this.linePhase0 = ((hash % 4096) / 4096) * Math.PI * 2;
    this.nextMistakeMs = Number.POSITIVE_INFINITY;
  }

  /** 是否正在脱困（调试 / 测试用）。注意：倒车结束后的"对线"阶段不算脱困。 */
  get isRecovering(): boolean {
    return this.phase === 'reverse';
  }

  /** 是否正在失误（调试 / 测试用）。 */
  get isMistaking(): boolean {
    return this.mistakeLeftMs > 0;
  }

  /** 本场累计触发的失误次数（调试 / 测试用）。 */
  get mistakeCount(): number {
    return this.mistakes;
  }

  /**
   * 本场累计输出过多少帧 `drift: true`（调试 / 测试用）。
   *
   * 存在的意义：CR-06 的验收标准是"困难 AI 在测速数据中**出现漂移状态**"。
   * 光看圈速无法区分"漂移生效了"和"漂移条件压根没触发"——
   * 这两种情况的圈速可能几乎一样。这个计数器让验收可以直接断言。
   */
  get driftFrames(): number {
    return this.driftFramesCount;
  }

  /** 最近一帧测到的前方曲率（调参用，用来判断漂移阈值是否可达）。 */
  get lastCurvature(): number {
    return this.lastCurvatureValue;
  }

  /** 重开比赛时调用：回到发车状态，PRNG 也回到同一 seed。 */
  reset(): void {
    this.rngState = this.seed;
    this.elapsedMs = 0;
    this.armed = false;
    this.stuckMs = 0;
    this.phase = 'none';
    this.phaseLeftMs = 0;
    this.mistakeLeftMs = 0;
    this.mistakeSteer = 0;
    this.nextMistakeMs = Number.POSITIVE_INFINITY;
    this.mistakes = 0;
    this.driftFramesCount = 0;
    this.lastCurvatureValue = 0;
  }

  /**
   * 计算本帧输入写入 out（复用对象）。
   * @param dtMs 距上一帧的毫秒数
   */
  drive(vehicle: VehicleLike, track: TrackQuery, dtMs: number, out: DriveInput): void {
    const dt = Math.max(0, dtMs);
    this.elapsedMs += dt;

    // 失误推进放在最前面：无论这一帧是正常驾驶还是脱困，PRNG 序列都按同样的节奏走，
    // 否则同一 seed 在"撞墙与否"两条分支上会得到不同的失误时序。
    this.stepMistake(dt);

    const AI = TUNING.ai;
    const speed = Math.abs(vehicle.speed);
    if (speed > AI.stuckSpeedThreshold) {
      this.armed = true;
      this.stuckMs = 0;
    } else {
      this.stuckMs += dt;
    }
    const blocked = vehicle.blocked === true;

    switch (this.phase) {
      case 'reverse': {
        this.phaseLeftMs -= dt;
        if (this.phaseLeftMs <= 0) {
          // 倒车结束 = 脱困结束（A4），之后进入短暂的对线期
          this.phase = 'realign';
          this.phaseLeftMs = REALIGN_MS;
        } else if (blocked) {
          // 倒车时又撞到东西（例如背后的黄色路障）= 倒不动了，提前结束倒车。
          // 少了这一条，AI 会一直踩油门顶在路障上直到 900ms 倒车计时走完，
          // 期间车一动不动；提前转成对线期能更快回到线路上。
          this.phase = 'realign';
          this.phaseLeftMs = REALIGN_MS;
          this.stuckMs = 0;
        }
        this.emitReverse(vehicle, track, out);
        return;
      }
      case 'realign': {
        this.phaseLeftMs -= dt;
        if (this.phaseLeftMs <= 0) {
          this.phase = 'none';
          // 清空卡住计时，给正常驾驶一个完整的 stuckMs 窗口，避免连环倒车
          this.stuckMs = 0;
        }
        break;
      }
      case 'none': {
        // 只有跑起来过的车才可能"卡住"：倒计时期间车速恒为 0，
        // 若在这里判定，AI 会在 3-2-1 期间就开始倒车。
        if (this.armed && (blocked || this.stuckMs >= AI.stuckMs)) {
          this.phase = 'reverse';
          this.phaseLeftMs = AI.recoveryReverseMs;
          this.stuckMs = 0;
          this.emitReverse(vehicle, track, out);
          return;
        }
        break;
      }
    }

    if (this.elapsedMs < this.reactionMs) {
      // 发车反应：起步晚一点（难度差异之一）。集成层也会延迟解锁，二者不叠加。
      out.throttle = 0;
      out.steer = 0;
      out.drift = false;
      return;
    }

    this.driveNormal(vehicle, track, out);
    if (this.phase === 'realign') out.throttle = Math.min(out.throttle, REALIGN_THROTTLE);
  }

  // ------------------------------------------------------------ 正常行驶

  private driveNormal(vehicle: VehicleLike, track: TrackQuery, out: DriveInput): void {
    const speed = Math.abs(vehicle.speed);
    const cap = TUNING.vehicle.maxSpeed * this.profile.speedCapRatio;
    const progress = track.progressAt(vehicle.x, vehicle.y);

    // --- 先估计前方曲率：限速与前视距离都要用它。
    //     取两段局部曲率里较大的那个，等价于"提前一点收油"，比只看一段保守。
    const look = 70 + speed * 0.9;
    const tangentA = track.tangentAtArc(progress.arc + look * 0.2);
    const tangentB = track.tangentAtArc(progress.arc + look * 0.6);
    const tangentC = track.tangentAtArc(progress.arc + look);
    const turn = Math.max(Math.abs(wrapAngle(tangentB - tangentA)), Math.abs(wrapAngle(tangentC - tangentB)));
    const curvature = turn / Math.max(1, look * 0.4);
    const tightness = clamp(curvature / CORNER_CURVATURE_REF, 0, 1);
    // 记下来供调参 / 验收：漂移阈值到底有没有被触发过，光看圈速是看不出来的
    this.lastCurvatureValue = curvature;

    // --- 转向：对准前方中心线上的前视点（AutoPilot 的纯追踪），急弯里收短前视避免切弯
    const lookAhead =
      (this.profile.lookAheadBase + speed * this.profile.lookAheadPerSpeed) *
      (1 - CORNER_LOOKAHEAD_SHRINK * tightness);
    const targetArc = progress.arc + lookAhead;
    const target = track.pointAtArc(targetArc);

    // 走线偏移（A7）：在中心线法线方向叠加一个缓慢变化的偏移。
    // 正偏移 = 前进方向的右侧（与 Track.signedLateral 同号约定）。
    const amp = this.profile.lineOffsetPx * clamp(1 - progress.lateralDistance / OFFSET_CORRIDOR_PX, 0, 1);
    const offset = amp * Math.sin((targetArc / OFFSET_WAVELENGTH_PX) * Math.PI * 2 + this.linePhase0);
    const normal = target.tangent + Math.PI / 2;
    const targetX = target.x + Math.cos(normal) * offset;
    const targetY = target.y + Math.sin(normal) * offset;

    const desired = Math.atan2(targetY - vehicle.y, targetX - vehicle.x);
    const headingError = wrapAngle(desired - vehicle.heading);
    // signedLateral > 0 表示车在前进方向右侧，需要往左修正
    const lateralCorrection = clamp(-progress.signedLateral * 0.0045, -0.35, 0.35);
    const seek = clamp(headingError * this.profile.steerGain + lateralCorrection, -1, 1);

    // --- 限速：先守住难度速度上限（A2），再用曲率压低过弯速度
    let targetSpeed = cap;
    if (curvature > 1e-5) {
      targetSpeed = Math.min(targetSpeed, Math.sqrt(this.profile.corneringGrip / curvature));
    }
    targetSpeed = Math.min(targetSpeed, steerAuthorityLimit(curvature));
    // 偏离中心线时收油，给自己留出修正空间
    targetSpeed -= Math.min(OFF_LINE_SLOWDOWN_MAX, progress.lateralDistance * OFF_LINE_SLOWDOWN_K);
    // 兜底：无论上面怎么减，都不能超过本档速度上限，也不能低于下限
    targetSpeed = clamp(targetSpeed, Math.min(MIN_TARGET_SPEED, cap), cap);

    if (speed < targetSpeed * THROTTLE_ON_RATIO) out.throttle = 1;
    else if (speed > targetSpeed * THROTTLE_OFF_RATIO) out.throttle = OVERSPEED_BRAKE;
    else out.throttle = 0;

    out.steer = clamp(seek + this.mistakeSteer, -1, 1);

    // --- 漂移决策（CR-06）：只有 useDrift 的档位才会真的漂
    out.drift = this.shouldDrift(curvature, speed, vehicle);
  }

  /**
   * 是否该在这帧漂移。
   *
   * 四个条件缺一不可（每一个都对应一种"漂了还不如不漂"的失败模式）：
   *
   *  1. **档位开了 `useDrift`**：四档目前全关 —— 实测漂移对圈速是负收益，
   *     理由写在 `types.ts` 的 `DifficultyProfile.useDrift` 上。
   *  2. **曲率够大**（`> profile.drift.curvature`，默认取 `TUNING.ai.driftCurvature`）：
   *     缓弯漂移纯亏（漂移有额外纵向阻力 `driftSpeedScrub`，稳态速度掉到约 370px/s，
   *     比抓地过弯慢得多）。
   *
   *     ⚠️ 这个阈值**按档可调**，因为不同赛道的曲率分布差很多：
   *     0.0045 是按 track1/track3 标定的（只在场最急那几个弯触发）；
   *     「漂移龙」同一套估计方法的 p95 就有 0.0059、max 0.0079 ——
   *     拿一个全局常数去卡两张分布不同的图，必然一张不触发、一张狂触发。
   *  3. **速度够高**（`> drift.minSpeed`）：横向推力按速度缩放，低速漂移只会让车
   *     原地打转而不产生有效转向。
   *  4. **侧滑角还没过大**（`< drift.maxAngle`）。漂移是"控制住的滑"，不是失控 ——
   *     没有这道闸，AI 会在连续弯里把侧滑角越推越大直到滑出赛道，
   *     表现为"困难 AI 反而更容易撞墙"。
   */
  private shouldDrift(curvature: number, speed: number, vehicle: VehicleLike): boolean {
    if (this.profile.useDrift !== true) return false;
    const cfg = this.driftConfig;
    if (curvature <= cfg.curvature) return false;
    if (speed <= cfg.minSpeed) return false;
    // 侧滑角从车辆状态读；假车（单测）没这个字段时按 0 处理，等价于"还没开始滑"
    const angle = vehicle.driftAngle ?? 0;
    if (angle > cfg.maxAngle) return false;
    this.driftFramesCount += 1;
    return true;
  }

  // ------------------------------------------------------------ 脱困

  /**
   * 脱困输出：倒车 + 反向打舵。
   *
   * "反向打舵"取的是**常规前向转向指令的相反数**：
   * 车辆模型里倒车时转向对车头的作用方向会翻转（`heading += steer * rate * sign(speed)`），
   * 所以把正常指令取反，倒车过程中车头才会朝线路方向转，而不是继续往墙上顶。
   * 不能输错符号，否则会变成"倒着往墙里扎"。
   */
  private emitReverse(vehicle: VehicleLike, track: TrackQuery, out: DriveInput): void {
    const seek = this.seekOnly(vehicle, track);
    out.throttle = TUNING.ai.recoveryThrottle;
    out.steer = clamp(-seek, -1, 1);
    out.drift = false;
  }

  /** 只算纯追踪的转向量（不含失误误差），供脱困复用。 */
  private seekOnly(vehicle: VehicleLike, track: TrackQuery): number {
    const speed = Math.abs(vehicle.speed);
    const progress = track.progressAt(vehicle.x, vehicle.y);
    const lookAhead = this.profile.lookAheadBase + speed * this.profile.lookAheadPerSpeed;
    const target = track.pointAtArc(progress.arc + lookAhead);
    const desired = Math.atan2(target.y - vehicle.y, target.x - vehicle.x);
    const headingError = wrapAngle(desired - vehicle.heading);
    const lateralCorrection = clamp(-progress.signedLateral * 0.0045, -0.35, 0.35);
    return clamp(headingError * this.profile.steerGain + lateralCorrection, -1, 1);
  }

  // ------------------------------------------------------------ 失误

  /** 推进失误状态机：指数分布调度下一次失误，持续 mistakeDurationMs。 */
  private stepMistake(dtMs: number): void {
    if (this.mistakeLeftMs > 0) {
      this.mistakeLeftMs -= dtMs;
      if (this.mistakeLeftMs <= 0) {
        this.mistakeLeftMs = 0;
        this.mistakeSteer = 0;
        this.scheduleNextMistake();
      }
      return;
    }
    if (this.nextMistakeMs === Number.POSITIVE_INFINITY) this.scheduleNextMistake();
    this.nextMistakeMs -= dtMs;
    if (this.nextMistakeMs > 0) return;

    this.mistakes += 1;
    this.mistakeLeftMs = this.profile.mistakeDurationMs;
    this.mistakeSteer = (this.nextRandom() < 0.5 ? -1 : 1) * this.profile.mistakeSteerError;
    if (this.mistakeLeftMs <= 0) {
      // 时长为 0 的档位：只影响这一帧，立刻排下一次
      this.mistakeSteer = 0;
      this.scheduleNextMistake();
    }
  }

  private scheduleNextMistake(): void {
    const rate = this.profile.mistakeRatePerSecond;
    if (rate <= 0) {
      this.nextMistakeMs = Number.POSITIVE_INFINITY;
      return;
    }
    // 指数分布：单位时间内的期望失误次数正好等于 mistakeRatePerSecond
    const u = clamp(this.nextRandom(), 1e-9, 1 - 1e-9);
    this.nextMistakeMs = (-Math.log(u) / rate) * 1000;
  }

  /** mulberry32：32 位状态、无依赖、同一 seed 逐帧可复现。 */
  private nextRandom(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

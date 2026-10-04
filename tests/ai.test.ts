import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AIDriver, type VehicleLike } from '../src/game/AIDriver';
import { TUNING } from '../src/game/constants';
import { DIFFICULTIES, assertDifficultyOrdering, getDifficulty } from '../src/game/Difficulty';
import type { DriveInput } from '../src/game/DriveInput';
import { VehicleDynamics } from '../src/game/VehicleDynamics';
import type {
  CenterlineSample,
  DifficultyId,
  DifficultyProfile,
  TrackMeta,
  TrackProgress,
  TrackQuery,
} from '../src/game/types';

const FRAME_MS = 16;
/** 假赛道半径（像素）。 */
const RADIUS = 600;
/** 与真实赛道一致：gen-track.mjs 里 HALF_WIDTH = 2.3 瓦片 × 32px。 */
const HALF_WIDTH = 2.3 * 32;
/** 车身中心能到达的边界（扣掉车身半径），撞墙时假车把位置压回这里并立刻停车。 */
const CORRIDOR = HALF_WIDTH - TUNING.vehicle.bodyRadius;
const DIFFICULTY_IDS: DifficultyId[] = ['easy', 'normal', 'hard'];

function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

function makeInput(): DriveInput {
  return { throttle: 0, steer: 0, drift: false };
}

/**
 * 假的环形赛道：半径 600px 的圆。
 *
 * 它必须和 `Track` 保持两处一致的约定，否则 AI 的转向符号会反：
 *  - 弧长 = 角度 × 半径（所以 `pointAtArc` / `progressAt` 互为逆运算）；
 *  - `signedLateral > 0` 表示车在前进方向的右侧（与 `Track.progressAt` 的叉积同号）。
 */
class CircleTrack implements TrackQuery {
  readonly radius: number;
  readonly totalLength: number;

  /**
   * @param radius 半径（像素）。取一个极大的半径 = 近似直线，
   *   用来把"走线偏移"从"前视点切弯"里剥离出来单独验证（A7）。
   */
  constructor(radius = RADIUS) {
    this.radius = radius;
    this.totalLength = Math.PI * 2 * radius;
  }

  progressAt(x: number, y: number): TrackProgress {
    const R = this.radius;
    const theta = Math.atan2(y, x);
    const arc = this.wrapArc(theta * R);
    const cx = Math.cos(theta) * R;
    const cy = Math.sin(theta) * R;
    const dx = -Math.sin(theta); // 前进方向（切线）
    const dy = Math.cos(theta);
    // 叉积 > 0 = 在前进方向右侧（与 Track.ts 的实现同号）
    const cross = dx * (y - cy) - dy * (x - cx);
    return {
      arc,
      t: arc / this.totalLength,
      lateralDistance: Math.abs(cross),
      signedLateral: cross,
      tangent: Math.atan2(dy, dx),
    };
  }

  pointAtArc(arc: number): CenterlineSample {
    const theta = this.wrapArc(arc) / this.radius;
    return {
      x: Math.cos(theta) * this.radius,
      y: Math.sin(theta) * this.radius,
      tangent: theta + Math.PI / 2,
    };
  }

  tangentAtArc(arc: number): number {
    return this.pointAtArc(arc).tangent;
  }

  /** 摆放假车用：`lateral > 0` = 偏向圆心（= 前进方向右侧）。 */
  poseAt(arc: number, lateral = 0, headingOffset = 0): { x: number; y: number; heading: number } {
    const theta = this.wrapArc(arc) / this.radius;
    const rho = this.radius - lateral;
    return {
      x: Math.cos(theta) * rho,
      y: Math.sin(theta) * rho,
      heading: theta + Math.PI / 2 + headingOffset,
    };
  }

  wrapArc(arc: number): number {
    let value = arc % this.totalLength;
    if (value < 0) value += this.totalLength;
    return value;
  }
}

/** 弧长差（考虑绕圈），落在 (-total/2, total/2]。 */
function arcDelta(from: number, to: number, total: number): number {
  let delta = to - from;
  if (delta > total / 2) delta -= total;
  if (delta < -total / 2) delta += total;
  return delta;
}

interface FakeCarInit {
  arc?: number;
  lateral?: number;
  headingOffset?: number;
  speed?: number;
}

/**
 * 极简车辆积分器：照抄 M1/M2 `Vehicle.update` 的纵向 + 转向模型（草地与漂移无关，故省略），
 * 让 AI 测试跑的是"和真车同款"的运动学，而不是一个随便的玩具模型。
 */
function stepVehicle(car: VehicleLike & { x: number; y: number; heading: number; speed: number }, dtMs: number, input: DriveInput): void {
  const V = TUNING.vehicle;
  const dt = dtMs / 1000;

  if (input.throttle === 0) {
    const coast = V.coastDecel * dt;
    if (Math.abs(car.speed) <= coast) car.speed = 0;
    else car.speed -= Math.sign(car.speed) * coast;
  }
  car.speed -= car.speed * V.dragK * dt;

  if (input.throttle > 0) {
    if (car.speed < V.maxSpeed) {
      const accel = car.speed < 0 ? V.brakeDecel : V.engineAccel;
      car.speed = Math.min(V.maxSpeed, car.speed + accel * input.throttle * dt);
    }
  } else if (input.throttle < 0) {
    const maxReverse = V.maxSpeed * V.reverseRatio;
    if (car.speed > 0) {
      car.speed = Math.max(0, car.speed + input.throttle * V.brakeDecel * dt);
    } else {
      car.speed = Math.max(-maxReverse, car.speed + input.throttle * V.engineAccel * V.reverseRatio * dt);
    }
  }

  const absSpeed = Math.abs(car.speed);
  if (absSpeed > 1) {
    const authority = Math.min(1, absSpeed / V.steerSpeedRef);
    const highSpeedLoss = 1 - V.highSpeedSteerLoss * Math.min(1, absSpeed / V.maxSpeed);
    const direction = car.speed >= 0 ? 1 : -1;
    car.heading += input.steer * V.maxSteerRate * authority * highSpeedLoss * direction * dt;
  }

  car.x += Math.cos(car.heading) * car.speed * dt;
  car.y += Math.sin(car.heading) * car.speed * dt;
}

/**
 * 圆形假赛道上的假车。
 *
 * `walls = true` 时把假赛道当成有限宽的走廊：出界即压回边界并立刻停车、置 `blocked`，
 * 这样"撞墙不动"和"脱困后能不能重新跑起来"都能在单元测试里复现。
 */
class FakeCar implements VehicleLike {
  x: number;
  y: number;
  heading: number;
  speed: number;
  blocked = false;

  private readonly track: CircleTrack;
  private readonly walls: boolean;

  constructor(track: CircleTrack, init: FakeCarInit = {}, walls = false) {
    const pose = track.poseAt(init.arc ?? 0, init.lateral ?? 0, init.headingOffset ?? 0);
    this.track = track;
    this.x = pose.x;
    this.y = pose.y;
    this.heading = pose.heading;
    this.speed = init.speed ?? 0;
    this.walls = walls;
  }

  step(dtMs: number, input: DriveInput): void {
    stepVehicle(this, dtMs, input);

    this.blocked = false;
    if (!this.walls) return;

    const rho = Math.hypot(this.x, this.y);
    if (rho === 0) return;
    const lateral = this.track.radius - rho;
    if (Math.abs(lateral) > CORRIDOR) {
      const scale = (this.track.radius - Math.sign(lateral) * CORRIDOR) / rho;
      this.x *= scale;
      this.y *= scale;
      // 撞墙不动：贴住墙时速度直接归零（真实实现里由 Arcade 的墙面约束达成同样效果）
      this.speed = 0;
      this.blocked = true;
    }
  }
}

interface RunOptions {
  seconds: number;
  seed?: number;
  walls?: boolean;
  init?: FakeCarInit;
  /** 统计平均走线偏移时跳过的起步时间。 */
  warmupMs?: number;
  /** 换一个假车（默认是圆形赛道上的 FakeCar）。 */
  createCar?: (init: FakeCarInit) => SimCar;
}

/** 假车状态类型：AI 只看这几个量。 */
type SimCar = VehicleLike & {
  x: number;
  y: number;
  heading: number;
  speed: number;
  blocked: boolean;
  step(dtMs: number, input: DriveInput): void;
};

/**
 * 用**真实赛道**的中心线几何（`public/assets/maps/track1.meta.json`）搭出来的假赛道。
 *
 * 它和 `Track.ts` 用同一套弧长参数化与叉积符号约定，只是不带瓦片地图：
 * 这样"AI 能不能跑完真实赛道 / 撞墙后能不能回到线路"可以在单元测试里逐帧复现，
 * 既不用跑 e2e（不会和别的工作线抢端口），也不依赖 Phaser。
 * 赛道本身的形状就是"中心线 ± 2.3 瓦片"的等宽走廊（见 tools/gen-track.mjs），
 * 所以这个走廊模型和真实地图的墙壁是一致的。
 */
class MetaTrack implements TrackQuery {
  readonly totalLength: number;
  /**
   * 赛道 id（测试要用它去读对应的 meta.json 拿地表参数）。
   *
   * 注意 `meta` 本身是**赛道元数据**，里面没有 id 字段
   * （`TrackMeta` 的 id 只存在于场景配置里），所以必须由构造方传进来。
   */
  readonly id: string;
  private readonly points: [number, number][];
  private readonly cumulative: number[];
  private readonly tangents: number[];
  /** 上一帧最近的子段：把搜索限制在局部（与 Track.ts 同款优化）。 */
  private searchSegment = 0;

  constructor(meta: TrackMeta, id = 'track1') {
    this.id = id;
    this.points = meta.centerline.points.map((p) => [p[0], p[1]] as [number, number]);
    const cumulative: number[] = [0];
    const tangents: number[] = [];
    for (let i = 1; i < this.points.length; i++) {
      const dx = this.points[i][0] - this.points[i - 1][0];
      const dy = this.points[i][1] - this.points[i - 1][1];
      cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
      tangents.push(Math.atan2(dy, dx));
    }
    tangents.push(tangents[tangents.length - 1]);
    this.cumulative = cumulative;
    this.tangents = tangents;
    this.totalLength = cumulative[cumulative.length - 1];
  }

  progressAt(x: number, y: number): TrackProgress {
    const count = this.points.length - 1;
    let best = { index: 0, t: 0, distance: Number.POSITIVE_INFINITY };
    const scan = (from: number, to: number): void => {
      for (let i = from; i <= to; i++) {
        const seg = ((i % count) + count) % count;
        const a = this.points[seg];
        const b = this.points[seg + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const distance = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
        if (distance < best.distance) best = { index: seg, t, distance };
      }
    };
    scan(this.searchSegment - 28, this.searchSegment + 28);
    if (best.distance > 220) {
      best = { index: 0, t: 0, distance: Number.POSITIVE_INFINITY };
      scan(0, count - 1);
    }
    this.searchSegment = best.index;

    const a = this.points[best.index];
    const b = this.points[best.index + 1];
    const segLength = this.cumulative[best.index + 1] - this.cumulative[best.index];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const cx = a[0] + dx * best.t;
    const cy = a[1] + dy * best.t;
    const cross = segLength > 0 ? (dx * (y - cy) - dy * (x - cx)) / segLength : 0;
    const arc = this.cumulative[best.index] + segLength * best.t;
    return {
      arc,
      t: this.totalLength > 0 ? arc / this.totalLength : 0,
      lateralDistance: Math.abs(cross),
      signedLateral: cross,
      tangent: this.tangents[best.index],
    };
  }

  pointAtArc(arc: number): CenterlineSample {
    const total = this.totalLength;
    let s = arc % total;
    if (s < 0) s += total;
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLength = this.cumulative[lo + 1] - this.cumulative[lo];
    const t = segLength > 0 ? (s - this.cumulative[lo]) / segLength : 0;
    const a = this.points[lo];
    const b = this.points[lo + 1];
    return {
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      tangent: this.tangents[lo],
    };
  }

  tangentAtArc(arc: number): number {
    return this.pointAtArc(arc).tangent;
  }

  /** 摆放假车：`lateral > 0` = 中心线法线正方向（= 前进方向右侧）。 */
  poseAt(arc: number, lateral = 0, headingOffset = 0): { x: number; y: number; heading: number } {
    const sample = this.pointAtArc(arc);
    const normal = sample.tangent + Math.PI / 2;
    return {
      x: sample.x + Math.cos(normal) * lateral,
      y: sample.y + Math.sin(normal) * lateral,
      heading: sample.tangent + headingOffset,
    };
  }

  /** 出走廊就压回边界；返回 null 表示没撞墙。 */
  constrain(x: number, y: number): { x: number; y: number } | null {
    const progress = this.progressAt(x, y);
    if (progress.lateralDistance <= CORRIDOR) return null;
    const sample = this.pointAtArc(progress.arc);
    const normal = sample.tangent + Math.PI / 2;
    const sign = progress.signedLateral >= 0 ? 1 : -1;
    return {
      x: sample.x + Math.cos(normal) * sign * CORRIDOR,
      y: sample.y + Math.sin(normal) * sign * CORRIDOR,
    };
  }
}

/** 真实赛道走廊上的假车：出界 = 撞墙（压回边界 + 停车）。 */
class RealTrackCar implements SimCar {
  x: number;
  y: number;
  heading: number;
  speed: number;
  blocked = false;

  private readonly track: MetaTrack;

  constructor(track: MetaTrack, init: FakeCarInit = {}) {
    const pose = track.poseAt(init.arc ?? 0, init.lateral ?? 0, init.headingOffset ?? 0);
    this.track = track;
    this.x = pose.x;
    this.y = pose.y;
    this.heading = pose.heading;
    this.speed = init.speed ?? 0;
  }

  step(dtMs: number, input: DriveInput): void {
    stepVehicle(this, dtMs, input);
    const clamped = this.track.constrain(this.x, this.y);
    this.blocked = clamped !== null;
    if (clamped) {
      this.x = clamped.x;
      this.y = clamped.y;
      this.speed = 0;
    }
  }
}

interface RunResult {
  car: SimCar;
  driver: AIDriver;
  progressPx: number;
  pathPx: number;
  maxSpeed: number;
  maxLateral: number;
  meanLateral: number;
  recoveryFrames: number;
  recoveryEntries: number;
  recoveryDurationsMs: number[];
  steerLog: number[];
  throttleLog: number[];
  /** 每帧结束时的累计前进距离，用来算"第几秒跑完 3 圈"。 */
  progressLog: number[];
  /** 每帧的有符号横向偏移（+ = 前进方向右侧），用来验证走线差异。 */
  lateralLog: number[];
  driftCount: number;
  blockedLog: boolean[];
  recoveryLog: boolean[];
}

/** 跑一场假比赛：每一帧 AI 出输入 → 假车积分 → 记录统计。 */
function run(track: TrackQuery, profile: DifficultyProfile, seed: number, options: RunOptions): RunResult {
  const walls = options.walls ?? false;
  const warmupMs = options.warmupMs ?? 2000;
  const car = options.createCar
    ? options.createCar(options.init ?? {})
    : new FakeCar(track as CircleTrack, options.init, walls);
  const driver = new AIDriver(profile, seed);
  const out = makeInput();
  const frames = Math.round((options.seconds * 1000) / FRAME_MS);

  let prevPose = { x: car.x, y: car.y };
  let prevArc = track.progressAt(car.x, car.y).arc;
  let progressPx = 0;
  let pathPx = 0;
  let maxSpeed = 0;
  let maxLateral = 0;
  let lateralSum = 0;
  let lateralFrames = 0;
  let recoveryFrames = 0;
  let recoveryEntries = 0;
  let wasRecovering = false;
  let recoveryStartMs = 0;
  const recoveryDurationsMs: number[] = [];
  const steerLog: number[] = [];
  const throttleLog: number[] = [];
  const progressLog: number[] = [];
  const lateralLog: number[] = [];
  const blockedLog: boolean[] = [];
  const recoveryLog: boolean[] = [];
  let driftCount = 0;

  for (let i = 0; i < frames; i++) {
    driver.drive(car, track, FRAME_MS, out);
    if (out.drift) driftCount += 1;
    steerLog.push(out.steer);
    throttleLog.push(out.throttle);

    const recovering = driver.isRecovering;
    recoveryLog.push(recovering);
    if (recovering) {
      recoveryFrames += 1;
      if (!wasRecovering) {
        recoveryEntries += 1;
        recoveryStartMs = i * FRAME_MS;
      }
    } else if (wasRecovering) {
      recoveryDurationsMs.push(i * FRAME_MS - recoveryStartMs);
    }
    wasRecovering = recovering;

    car.step(FRAME_MS, out);
    blockedLog.push(car.blocked);

    pathPx += Math.hypot(car.x - prevPose.x, car.y - prevPose.y);
    prevPose = { x: car.x, y: car.y };

    const progress = track.progressAt(car.x, car.y);
    const delta = arcDelta(prevArc, progress.arc, track.totalLength);
    if (delta > 0) progressPx += delta; // 只累计"前进"：倒车脱困不该算成里程
    prevArc = progress.arc;

    const speed = Math.abs(car.speed);
    maxSpeed = Math.max(maxSpeed, speed);
    maxLateral = Math.max(maxLateral, progress.lateralDistance);
    if (i * FRAME_MS >= warmupMs) {
      lateralSum += progress.lateralDistance;
      lateralFrames += 1;
    }
    progressLog.push(progressPx);
    lateralLog.push(progress.signedLateral);
  }
  if (wasRecovering) recoveryDurationsMs.push(frames * FRAME_MS - recoveryStartMs);

  return {
    car,
    driver,
    progressPx,
    pathPx,
    maxSpeed,
    maxLateral,
    meanLateral: lateralFrames > 0 ? lateralSum / lateralFrames : 0,
    recoveryFrames,
    recoveryEntries,
    recoveryDurationsMs,
    steerLog,
    throttleLog,
    progressLog,
    lateralLog,
    driftCount,
    blockedLog,
    recoveryLog,
  };
}

/** 累计前进距离第一次达到 distancePx 的时刻（毫秒）；从未达到返回 null。 */
function timeToDistance(result: RunResult, distancePx: number): number | null {
  for (let i = 0; i < result.progressLog.length; i++) {
    if (result.progressLog[i] >= distancePx) return (i + 1) * FRAME_MS;
  }
  return null;
}

/** 载入真实赛道的中心线几何（纯逻辑测试用，不需要 Phaser）。 */
function loadRealTrack(): MetaTrack {
  return loadTrack('track1');
}

/** 载入任意一条赛道的中心线几何。 */
function loadTrack(id: string): MetaTrack {
  const url = new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url);
  return new MetaTrack(JSON.parse(readFileSync(url, 'utf8')) as TrackMeta, id);
}

/** 在真实赛道走廊上跑一场假比赛。 */
function runOnReal(track: MetaTrack, profile: DifficultyProfile, seed: number, options: RunOptions): RunResult {
  return run(track, profile, seed, { ...options, createCar: (init) => new RealTrackCar(track, init) });
}

/** 断言一帧输出满足 A1（合法范围）。 */
function assertLegal(out: DriveInput, label: string): void {
  assert.ok(out.throttle >= -1 && out.throttle <= 1, `${label}: throttle=${out.throttle} 越界`);
  assert.ok(out.steer >= -1 && out.steer <= 1, `${label}: steer=${out.steer} 越界`);
}

describe('Difficulty 查表与自检', () => {
  it('全部难度档的单调性自检通过（越难的档必须每一项都更强 / 更准 / 更少失误）', () => {
    assert.doesNotThrow(() => assertDifficultyOrdering());
  });

  it('炼狱档确实比困难档更强，而且是"用满车辆能力"的档', () => {
    const hard = getDifficulty('hard');
    const inferno = getDifficulty('inferno');
    assert.equal(inferno.label, '炼狱');
    // 速度上限必须顶到 1.0 —— 这是炼狱相对困难唯一能动的"绝对速度"杠杆
    assert.equal(inferno.speedCapRatio, 1, '炼狱必须用满车辆极速');
    assert.ok(inferno.corneringGrip > hard.corneringGrip * 2, '炼狱要解除曲率限速这一层');
    assert.ok(inferno.lineOffsetPx < hard.lineOffsetPx, '炼狱走线必须比困难更贴');
    assert.ok(inferno.reactionMs < hard.reactionMs, '炼狱起步必须比困难更快');
  });

  it('非法 / 空难度回落到默认难度', () => {
    assert.equal(getDifficulty('hard').id, 'hard');
    assert.equal(getDifficulty('easy').id, 'easy');
    assert.equal(getDifficulty('inferno').id, 'inferno');
    assert.equal(getDifficulty(null).id, 'normal');
    assert.equal(getDifficulty(undefined).id, 'normal');
    assert.equal(getDifficulty('impossible').id, 'normal');
    assert.equal(getDifficulty('').id, 'normal');
  });

  it('全部难度档的速度上限严格递增', () => {
    const caps = DIFFICULTY_IDS.map((id) => TUNING.vehicle.maxSpeed * DIFFICULTIES[id].speedCapRatio);
    for (let i = 1; i < caps.length; i++) {
      assert.ok(caps[i] > caps[i - 1], `速度上限应递增，实际 ${caps.join(' / ')}`);
    }
  });
});

describe('漂移阈值按档可调（CR-16）', () => {
  it('档位没配 drift 时回落到 TUNING.ai 的全局默认（历史行为不变）', () => {
    const plain: DifficultyProfile = { ...DIFFICULTIES.hard, useDrift: true, drift: undefined };
    /** 让车以指定速度"贴着中心线"跑：假车的速度是我们直接设定的。 */
    const driveAt = (curvature: number, speed: number, profile: DifficultyProfile): DriveInput[] => {
      const track = new CircleTrack(1 / curvature);
      const driver = new AIDriver(profile, 7);
      const out: DriveInput = { throttle: 0, steer: 0, drift: false };
      const logs: DriveInput[] = [];
      const radius = 1 / curvature;
      const car: VehicleLike = { x: radius, y: 0, heading: Math.PI / 2, speed, driftAngle: 0 };
      for (let i = 0; i < 30; i++) {
        driver.drive(car, track, 1000 / 60, out);
        logs.push({ ...out });
      }
      return logs;
    };

    // 曲率低于全局阈值（缓弯）：不该漂
    const calm = driveAt(TUNING.ai.driftCurvature * 0.5, 400, plain);
    assert.equal(calm.filter((o) => o.drift).length, 0, '曲率低于全局阈值不该漂');

    // 曲率高于全局阈值 + 速度高于 driftMinSpeed：应当漂
    const sharp = driveAt(TUNING.ai.driftCurvature * 2.5, TUNING.ai.driftMinSpeed + 120, plain);
    assert.ok(
      sharp.filter((o) => o.drift).length > 0,
      `曲率高于阈值 + 速度够 + 档位开了 useDrift → 应当漂（阈值 ${TUNING.ai.driftCurvature}）`,
    );
  });

  it('档位给了 drift 就用档位自己的阈值（换图不必改全局常数）', () => {
    const curvature = TUNING.ai.driftCurvature * 2.5;
    const strict: DifficultyProfile = {
      ...DIFFICULTIES.hard,
      useDrift: true,
      // 阈值抬到远高于这条假赛道的曲率 → 一帧都不该漂
      drift: { curvature: TUNING.ai.driftCurvature * 10, minSpeed: 0, maxAngle: 1 },
    };
    const track = new CircleTrack(1 / curvature);
    const driver = new AIDriver(strict, 7);
    const out: DriveInput = { throttle: 0, steer: 0, drift: false };
    const radius = 1 / curvature;
    const car: VehicleLike = { x: radius, y: 0, heading: Math.PI / 2, speed: 400, driftAngle: 0 };
    let driftFrames = 0;
    for (let i = 0; i < 30; i++) {
      driver.drive(car, track, 1000 / 60, out);
      if (out.drift) driftFrames += 1;
    }
    assert.equal(driftFrames, 0, '档位自己的阈值更高时，不该再漂');
  });
});

describe('AIDriver 输出契约（A1 / A2）', () => {
  it('A1：三档难度跑 20 秒，任何一帧的输出都在合法范围内', () => {
    const track = new CircleTrack();
    for (const id of DIFFICULTY_IDS) {
      const result = run(track, DIFFICULTIES[id], 11, { seconds: 20, walls: true });
      // 半径 600 的圆是缓弯（曲率 0.0017），远低于漂移阈值 0.0045 ——
      // 三档在这条假赛道上都不该漂。困难档的漂移在"真物理 + 真实急弯"那组测试里验。
      assert.equal(result.driftCount, 0, `${id} 在缓弯圆环上不该输出漂移`);
      for (let i = 0; i < result.steerLog.length; i++) {
        assertLegal(
          { throttle: result.throttleLog[i], steer: result.steerLog[i], drift: false },
          `${id} 第 ${i} 帧`,
        );
      }
    }
  });

  it('A2：任何时刻车速都不超过本档速度上限（含收油滞环）', () => {
    const track = new CircleTrack();
    for (const id of DIFFICULTY_IDS) {
      const cap = TUNING.vehicle.maxSpeed * DIFFICULTIES[id].speedCapRatio;
      const result = run(track, DIFFICULTIES[id], 12, { seconds: 20, walls: true });
      assert.ok(
        result.maxSpeed <= cap * 1.06,
        `${id}: 最高车速 ${result.maxSpeed.toFixed(1)} 超过本档上限 ${cap.toFixed(1)}`,
      );
    }
  });

  it('起步反应时间与档位一致，倒计时期间不会误判卡住', () => {
    const track = new CircleTrack();
    for (const id of DIFFICULTY_IDS) {
      const driver = new AIDriver(DIFFICULTIES[id], 5);
      const car = new FakeCar(track, {}, true);
      const out = makeInput();
      assert.equal(driver.reactionMs, DIFFICULTIES[id].reactionMs);
      // 模拟 3-2-1 倒计时：车一直停着，AI 每帧仍被调用
      let earlyThrottle = 0;
      for (let t = 0; t < 3000; t += FRAME_MS) {
        driver.drive(car, track, FRAME_MS, out);
        assert.equal(driver.isRecovering, false, `${id}: 倒计时期间不应进入脱困`);
        // 判定要用"这一帧结束后的比赛时间"：drive() 内部先累加 dtMs 再判断反应时间
        if (t + FRAME_MS <= DIFFICULTIES[id].reactionMs) {
          assert.equal(out.throttle, 0, `${id}: 反应时间内不应给油`);
          assert.equal(out.steer, 0, `${id}: 反应时间内不应打舵`);
          earlyThrottle += 1;
        }
      }
      assert.ok(earlyThrottle > 0, `${id}: 应覆盖到反应时间窗口`);
      // 倒计时结束后（早已越过 reactionMs）必须全力起步
      assert.equal(out.throttle, 1, `${id}: 反应时间结束后应该全力起步`);
      assert.equal(car.blocked, false, '假车在倒计时里没有被推着撞墙');
    }
  });
});

describe('AIDriver 难度差异（A3 / REQ-008）', () => {
  it('A3：同一假赛道同样时长，前进距离严格 hard > normal > easy', () => {
    const track = new CircleTrack();
    const seconds = 30;
    const results = DIFFICULTY_IDS.map((id) => ({
      id,
      cap: TUNING.vehicle.maxSpeed * DIFFICULTIES[id].speedCapRatio,
      run: run(track, DIFFICULTIES[id], 2024, { seconds, walls: true }),
    }));

    for (const item of results) {
      console.log(
        `  [A3] ${item.id}: 前进 ${item.run.progressPx.toFixed(0)}px / 路程 ${item.run.pathPx.toFixed(0)}px` +
          ` / 平均速度 ${(item.run.progressPx / seconds).toFixed(1)}px/s / 上限 ${item.cap.toFixed(1)}px/s` +
          ` / 脱困 ${item.run.recoveryEntries} 次`,
      );
    }

    const [easy, normal, hard] = results;
    assert.ok(
      easy.run.progressPx < normal.run.progressPx,
      `普通(${normal.run.progressPx.toFixed(0)}) 应快于简单(${easy.run.progressPx.toFixed(0)})`,
    );
    assert.ok(
      normal.run.progressPx < hard.run.progressPx,
      `困难(${hard.run.progressPx.toFixed(0)}) 应快于普通(${normal.run.progressPx.toFixed(0)})`,
    );
    // "明显快"：困难至少要比简单多跑 20%
    assert.ok(
      hard.run.progressPx > easy.run.progressPx * 1.2,
      `困难只比简单快 ${(((hard.run.progressPx - easy.run.progressPx) / easy.run.progressPx) * 100).toFixed(1)}%，不够明显`,
    );
  });

  it('A3 补充：没有墙时三档同样单调，说明差距来自难度参数而非撞墙运气', () => {
    const track = new CircleTrack();
    const distances = DIFFICULTY_IDS.map(
      (id) => run(track, DIFFICULTIES[id], 77, { seconds: 20 }).progressPx,
    );
    console.log(`  [A3-补] 无墙前进距离：easy=${distances[0].toFixed(0)} normal=${distances[1].toFixed(0)} hard=${distances[2].toFixed(0)}`);
    assert.ok(distances[0] < distances[1] && distances[1] < distances[2]);
  });
});

describe('AIDriver 脱困（A4 / REQ-007）', () => {
  it('A4：撞墙不动会进入脱困，输出倒车并反向打舵，recoveryReverseMs 后退出', () => {
    const track = new CircleTrack();
    const profile = DIFFICULTIES.normal;
    const driver = new AIDriver(profile, 7);
    // 车头正对右侧外墙、离墙 6px 起步：一给油就撞墙停住
    const car = new FakeCar(track, { arc: 0, lateral: -(CORRIDOR - 6), headingOffset: -Math.PI / 2 }, true);
    const out = makeInput();

    let lastFreeSteer: number | null = null;
    let firstReverseSteer: number | null = null;
    let firstReverseThrottle: number | null = null;
    let firstReverseFrame = -1;
    let exitFrame = -1;
    let wasRecovering = false;
    const durationMs: number[] = [];
    let startMs = 0;

    for (let i = 0; i < 500; i++) {
      const blockedBefore = car.blocked;
      driver.drive(car, track, FRAME_MS, out);
      assertLegal(out, `脱困 ${i}`);

      if (driver.isRecovering) {
        if (firstReverseFrame < 0) {
          firstReverseFrame = i;
          firstReverseSteer = out.steer;
          firstReverseThrottle = out.throttle;
        }
        if (!wasRecovering) startMs = i * FRAME_MS;
      } else {
        if (wasRecovering && exitFrame < 0) exitFrame = i;
        // 记录"撞墙前最后一帧"的常规转向，用来验证脱困是反向打舵
        if (!blockedBefore) lastFreeSteer = out.steer;
      }
      if (wasRecovering && !driver.isRecovering) durationMs.push(i * FRAME_MS - startMs);
      wasRecovering = driver.isRecovering;

      car.step(FRAME_MS, out);
    }

    assert.ok(firstReverseFrame > 0, '撞墙后必须进入脱困');
    assert.ok(lastFreeSteer !== null, '应该记录到撞墙前的常规转向');
    assert.equal(firstReverseThrottle, TUNING.ai.recoveryThrottle, '脱困时必须按配置倒车');
    assert.ok(
      (firstReverseSteer ?? 0) * (lastFreeSteer ?? 0) < 0,
      `脱困应反向打舵：卡住前 ${String(lastFreeSteer)}，脱困时 ${String(firstReverseSteer)}`,
    );
    assert.ok(Math.abs(firstReverseSteer ?? 0) > 0.5, `脱困打舵应明显，实际 ${String(firstReverseSteer)}`);
    assert.ok(exitFrame > firstReverseFrame, '倒车结束后必须退出脱困');
    assert.equal(durationMs.length, 1, '这一轮只应脱困一次');
    assert.ok(
      Math.abs(durationMs[0] - TUNING.ai.recoveryReverseMs) <= 2 * FRAME_MS,
      `脱困时长 ${durationMs[0]}ms 应约等于 recoveryReverseMs=${TUNING.ai.recoveryReverseMs}ms`,
    );
  });

  it('A4：一直卡着会周期性重试脱困，而不是卡在脱困里不出来', () => {
    const track = new CircleTrack();
    const driver = new AIDriver(DIFFICULTIES.normal, 3);
    const out = makeInput();
    // 先让它"跑起来"（arming），之后固定成一台永远撞墙、速度恒为 0 的车
    const car: VehicleLike = { x: RADIUS, y: 0, heading: Math.PI / 2, speed: 200 };
    for (let i = 0; i < 10; i++) driver.drive(car, track, FRAME_MS, out);
    car.speed = 0;
    car.blocked = true;

    const pattern: boolean[] = [];
    let reverseFrames = 0;
    let forwardFrames = 0;
    let maxContinuousReverse = 0;
    let current = 0;
    for (let i = 0; i < Math.round(6000 / FRAME_MS); i++) {
      driver.drive(car, track, FRAME_MS, out);
      assertLegal(out, `卡住 ${i}`);
      pattern.push(driver.isRecovering);
      if (driver.isRecovering) {
        reverseFrames += 1;
        current += 1;
        maxContinuousReverse = Math.max(maxContinuousReverse, current);
        assert.equal(out.throttle, TUNING.ai.recoveryThrottle);
      } else {
        current = 0;
        if (out.throttle > 0) forwardFrames += 1; // 对线阶段"往前拱一下"
      }
    }

    // 每轮 = 倒车 recoveryReverseMs + 对线 320ms + 重新判定 stuckMs
    const entries = pattern.filter((value, index) => value && !pattern[index - 1]).length;
    assert.ok(entries >= 2, `6 秒内应至少尝试 2 次脱困，实际 ${entries} 次`);
    assert.ok(
      maxContinuousReverse * FRAME_MS <= TUNING.ai.recoveryReverseMs + 2 * FRAME_MS,
      `单次倒车不应超过 recoveryReverseMs，实际 ${maxContinuousReverse * FRAME_MS}ms`,
    );
    // 倒车之间必须有"往前拱"的尝试（标准的三点头脱困），否则就是一直在倒车
    assert.ok(forwardFrames > 0, '两次倒车之间必须有向前推进的尝试');
    assert.ok(
      reverseFrames * FRAME_MS < 6000 * 0.8,
      `倒车时间占比过高（${((reverseFrames * FRAME_MS) / 6000).toFixed(2)}），说明脱困没有奏效`,
    );
  });

  it('A4 / REQ-007：真撞墙后能自己倒出来并重新回到线路上', () => {
    const track = new CircleTrack();
    const profile = DIFFICULTIES.normal;
    const result = run(track, profile, 99, {
      seconds: 10,
      walls: true,
      init: { arc: 0, lateral: -(CORRIDOR - 6), headingOffset: -Math.PI / 2 },
      warmupMs: 0,
    });

    const endProgress = track.progressAt(result.car.x, result.car.y);
    console.log(
      `  [A4] 撞墙起跑 10 秒后：前进 ${result.progressPx.toFixed(0)}px / 偏移 ${endProgress.lateralDistance.toFixed(1)}px` +
        ` / 车速 ${Math.abs(result.car.speed).toFixed(1)}px/s / 脱困 ${result.recoveryEntries} 次`,
    );
    assert.ok(result.recoveryEntries >= 1, '撞墙后必须触发过脱困');
    assert.ok(
      result.progressPx > 1500,
      `脱困后应能继续沿赛道前进，实际只有 ${result.progressPx.toFixed(0)}px`,
    );
    assert.equal(result.car.blocked, false, '结束时不应还贴在墙上');
    assert.ok(
      endProgress.lateralDistance < CORRIDOR * 0.6,
      `脱困后应回到线路附近，实际偏移 ${endProgress.lateralDistance.toFixed(1)}px`,
    );
    assert.ok(
      result.recoveryFrames * FRAME_MS < 4000,
      `10 秒里倒车了 ${((result.recoveryFrames * FRAME_MS) / 1000).toFixed(1)}s，太久了`,
    );
  });
});

describe('AIDriver 失误与确定性（A5 / A6）', () => {
  it('A5：同一 seed 逐帧输出完全一致；不同 seed 的失误时机不同', () => {
    const track = new CircleTrack();
    const profile = DIFFICULTIES.easy;
    const a = run(track, profile, 4242, { seconds: 30, walls: true });
    const b = run(track, profile, 4242, { seconds: 30, walls: true });
    const c = run(track, profile, 99, { seconds: 30, walls: true });

    assert.deepEqual(a.steerLog, b.steerLog, '同 seed 的转向序列必须逐帧一致');
    assert.deepEqual(a.throttleLog, b.throttleLog, '同 seed 的油门序列必须逐帧一致');
    assert.deepEqual(
      [a.car.x, a.car.y, a.car.heading, a.car.speed],
      [b.car.x, b.car.y, b.car.heading, b.car.speed],
      '同 seed 的最终位姿必须一致',
    );
    assert.equal(a.driver.mistakeCount, b.driver.mistakeCount);
    assert.notDeepEqual(c.steerLog, a.steerLog, '不同 seed 应产生不同的失误时机');
  });

  it('A5：reset 之后同一 seed 重新复现（重开比赛用）', () => {
    const track = new CircleTrack();
    const profile = DIFFICULTIES.normal;
    const driver = new AIDriver(profile, 31337);
    const car = new FakeCar(track, { speed: 250 });
    const out = makeInput();
    const first: number[] = [];
    for (let i = 0; i < 1200; i++) {
      driver.drive(car, track, FRAME_MS, out);
      first.push(out.steer);
    }
    driver.reset();
    const again: number[] = [];
    for (let i = 0; i < 1200; i++) {
      driver.drive(car, track, FRAME_MS, out);
      again.push(out.steer);
    }
    assert.deepEqual(again, first, 'reset 后应从同一 seed 重新开始');
  });

  it('A6：失误率越高，单位时间内出现的转向误差越多', () => {
    const track = new CircleTrack();
    const seconds = 300;
    const frames = Math.round((seconds * 1000) / FRAME_MS);
    // 冻住的车：位置/朝向/速度恒定，只有失误会改变输出，
    // 于是"与零失误基准不同的帧数"就是失误时长的直接度量。
    const frozen: VehicleLike = { x: RADIUS, y: 0, heading: Math.PI / 2, speed: 200 };
    const dirty = makeInput();
    const cleanOut = makeInput();

    const stats = DIFFICULTY_IDS.map((id) => {
      const profile = DIFFICULTIES[id];
      const noMistake: DifficultyProfile = { ...profile, mistakeRatePerSecond: 0 };
      const driver = new AIDriver(profile, 2024);
      const baseline = new AIDriver(noMistake, 2024);
      let mismatchFrames = 0;
      for (let i = 0; i < frames; i++) {
        driver.drive(frozen, track, FRAME_MS, dirty);
        baseline.drive(frozen, track, FRAME_MS, cleanOut);
        assertLegal(dirty, `${id} 失误 ${i}`);
        // 跳过发车反应时间，之后基准输出恒定，任何差异都来自失误
        if (i * FRAME_MS > 2000 && Math.abs(dirty.steer - cleanOut.steer) > 1e-9) mismatchFrames += 1;
      }
      return { id, mismatchFrames, count: driver.mistakeCount };
    });

    for (const item of stats) {
      console.log(
        `  [A6] ${item.id}: ${seconds}s 内失误 ${item.count} 次，影响 ${item.mismatchFrames} 帧` +
          `（≈${((item.mismatchFrames * FRAME_MS) / 1000).toFixed(1)}s）`,
      );
    }
    const [easy, normal, hard] = stats;
    assert.ok(easy.mismatchFrames > 0, '简单档必须真的会失误');
    assert.ok(
      easy.mismatchFrames > hard.mismatchFrames,
      `简单档失误影响 ${easy.mismatchFrames} 帧，应多于困难档的 ${hard.mismatchFrames} 帧`,
    );
    assert.ok(
      easy.mismatchFrames >= normal.mismatchFrames && normal.mismatchFrames >= hard.mismatchFrames,
      '失误影响帧数应随难度单调减少',
    );
    assert.ok(easy.count > hard.count, `失误次数应随难度减少：easy=${easy.count} hard=${hard.count}`);
  });

  it('A6：失误幅度受 mistakeSteerError 约束，不会把 AI 打成失控', () => {
    const track = new CircleTrack();
    const profile = DIFFICULTIES.easy;
    const driver = new AIDriver(profile, 8);
    const frozen: VehicleLike = { x: RADIUS, y: 0, heading: Math.PI / 2, speed: 300 };
    const out = makeInput();
    const noMistake: DifficultyProfile = { ...profile, mistakeRatePerSecond: 0 };
    const baseline = new AIDriver(noMistake, 8);
    const cleanOut = makeInput();
    let maxDelta = 0;
    for (let i = 0; i < Math.round(120_000 / FRAME_MS); i++) {
      driver.drive(frozen, track, FRAME_MS, out);
      baseline.drive(frozen, track, FRAME_MS, cleanOut);
      maxDelta = Math.max(maxDelta, Math.abs(out.steer - cleanOut.steer));
    }
    assert.ok(maxDelta > 0, '两分钟内简单档应至少失误一次');
    assert.ok(
      maxDelta <= profile.mistakeSteerError * profile.steerGain + 1e-9,
      `单次失误的转向偏差 ${maxDelta.toFixed(3)} 不应超过 steerGain × mistakeSteerError`,
    );
  });
});

describe('AIDriver 走线（A7）', () => {
  it('A7：lineOffsetPx 越大越不贴中心线（easy > normal > hard）', () => {
    // 用半径极大的假赛道近似直线：纯追踪不再"切弯"，
    // 测到的横向偏移就只可能来自 lineOffsetPx，A7 才测得准。
    const track = new CircleTrack(500_000);
    const seconds = 60;
    const stats = DIFFICULTY_IDS.map((id) => {
      const result = run(track, DIFFICULTIES[id], 606, { seconds, walls: false, warmupMs: 4000 });
      return { id, mean: result.meanLateral, max: result.maxLateral };
    });
    for (const item of stats) {
      console.log(`  [A7] ${item.id}: 平均偏移 ${item.mean.toFixed(1)}px / 最大偏移 ${item.max.toFixed(1)}px`);
    }
    const [easy, normal, hard] = stats;
    assert.ok(
      easy.mean > normal.mean && normal.mean > hard.mean,
      `平均走线偏移应随难度递减：${stats.map((s) => `${s.id}=${s.mean.toFixed(1)}`).join(' / ')}`,
    );
    assert.ok(easy.mean > 12, `简单档应明显不贴中心线，实际平均偏移 ${easy.mean.toFixed(1)}px`);
    assert.ok(hard.mean < 20, `困难档应贴紧中心线，实际平均偏移 ${hard.mean.toFixed(1)}px`);
    assert.ok(easy.max < CORRIDOR, `走线偏移不应把 AI 推出走廊，实际最大偏移 ${easy.max.toFixed(1)}px`);
  });

  it('A7：同一档不同 seed 走不同的线，同 seed 完全重合（三台 AI 不会粘在一起）', () => {
    // 关掉失误，把差异来源隔离到"走线初相"上
    const track = new CircleTrack(500_000);
    const noMistake: DifficultyProfile = { ...DIFFICULTIES.easy, mistakeRatePerSecond: 0 };
    const runSeed = (seed: number): RunResult =>
      run(track, noMistake, seed, { seconds: 30, walls: false, warmupMs: 4000 });
    const first = runSeed(1);
    const again = runSeed(1);
    const second = runSeed(2);
    const third = runSeed(3);

    const meanAbsDiff = (a: number[], b: number[]): number =>
      a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;

    const d12 = meanAbsDiff(first.lateralLog, second.lateralLog);
    const d13 = meanAbsDiff(first.lateralLog, third.lateralLog);
    const dSame = meanAbsDiff(first.lateralLog, again.lateralLog);
    console.log(
      `  [A7] 走线差异：|seed1-seed2|=${d12.toFixed(1)}px |seed1-seed3|=${d13.toFixed(1)}px 同 seed=${dSame}`,
    );

    assert.equal(dSame, 0, '同 seed 的走线必须完全一致');
    assert.ok(d12 > 3, `seed 1 与 2 的走线应有可见差异，实际只有 ${d12.toFixed(1)}px`);
    assert.ok(d13 > 3, `seed 1 与 3 的走线应有可见差异，实际只有 ${d13.toFixed(1)}px`);
  });
});

describe('AIDriver 跑真实赛道中心线（REQ-007 / REQ-008 的可重复验证）', () => {
  it('三档难度都能跑完 3 圈，困难明显快于简单，且不会长期卡墙', () => {
    const track = loadRealTrack();
    const laps = TUNING.race.laps;
    const seconds = 150;
    const goal = track.totalLength * laps;

    const results = DIFFICULTY_IDS.map((id) => {
      const result = runOnReal(track, DIFFICULTIES[id], 2026, { seconds });
      const lapMs = timeToDistance(result, goal);
      return { id, result, lapMs };
    });

    for (const item of results) {
      console.log(
        `  [真实赛道] ${item.id}: ${(item.result.progressPx / track.totalLength).toFixed(2)} 圈 / ` +
          `3 圈用时 ${item.lapMs === null ? '未完成' : `${(item.lapMs / 1000).toFixed(2)}s`} / ` +
          `脱困 ${item.result.recoveryEntries} 次（共 ${((item.result.recoveryFrames * FRAME_MS) / 1000).toFixed(1)}s）`,
      );
    }

    for (const item of results) {
      assert.ok(
        item.lapMs !== null,
        `${item.id} 在 ${seconds}s 内没跑完 ${laps} 圈（只跑了 ${(item.result.progressPx / track.totalLength).toFixed(2)} 圈）—— 长期卡墙了`,
      );
      assert.ok(
        item.result.recoveryFrames * FRAME_MS < seconds * 1000 * 0.4,
        `${item.id} 脱困时间占比过高：${((item.result.recoveryFrames * FRAME_MS) / 1000).toFixed(1)}s`,
      );
      // 漂移策略按档位区分：机制已实现（见"漂移机制"那条测试），
      // 但**当前发布配置下三档都不开** —— 漂移图（超级 S 弯道）还没做出来，
      // 在两张抓地跑法的图上让 AI 漂移只是"能漂"而不是"该漂"。
      assert.equal(
        item.result.driftCount,
        0,
        `${item.id} 在当前发布配置下不该漂移（漂移图尚未落地）`,
      );
    }

    const [easy, normal, hard] = results;
    assert.ok(
      (hard.lapMs ?? Infinity) < (normal.lapMs ?? Infinity) && (normal.lapMs ?? Infinity) < (easy.lapMs ?? Infinity),
      `真实赛道上 3 圈用时必须 hard < normal < easy，实际 ${results
        .map((r) => `${r.id}=${r.lapMs === null ? '未完成' : `${(r.lapMs / 1000).toFixed(2)}s`}`)
        .join(' / ')}`,
    );
    const gapRatio = (easy.lapMs ?? 0) / (hard.lapMs ?? 1);
    assert.ok(gapRatio > 1.15, `困难只比简单快 ${((gapRatio - 1) * 100).toFixed(1)}%，不够"明显"`);
  });

  it('多种子稳健性：任意 seed 都能在限时内跑完 3 圈，不会长期卡墙', () => {
    const track = loadRealTrack();
    const goal = track.totalLength * TUNING.race.laps;
    const seconds = 110;
    const seeds = [1, 2, 3, 7, 11, 2026];
    for (const id of DIFFICULTY_IDS) {
      for (const seed of seeds) {
        const result = runOnReal(track, DIFFICULTIES[id], seed, { seconds });
        const lapMs = timeToDistance(result, goal);
        assert.ok(
          lapMs !== null,
          `${id} / seed ${seed} 在 ${seconds}s 内没跑完 3 圈（${(result.progressPx / track.totalLength).toFixed(2)} 圈，脱困 ${result.recoveryEntries} 次）`,
        );
        assert.ok(
          result.recoveryFrames * FRAME_MS < seconds * 1000 * 0.4,
          `${id} / seed ${seed} 脱困时间占比过高`,
        );
      }
      console.log(`  [多种子] ${id}: ${seeds.length} 个 seed 全部完赛`);
    }
  });

  it('真实赛道最急的弯外墙上撞停后，AI 能倒出来并重新回到线路上', () => {
    const track = loadRealTrack();
    // 找出中心线曲率最大的位置 = 最急的弯，把车贴到弯道外侧墙上、车头朝墙
    let worstArc = 0;
    let worstCurvature = 0;
    for (let arc = 0; arc < track.totalLength; arc += 10) {
      const delta = 60;
      const turn = Math.abs(wrapAngle(track.tangentAtArc(arc + delta) - track.tangentAtArc(arc)));
      const curvature = turn / delta;
      if (curvature > worstCurvature) {
        worstCurvature = curvature;
        worstArc = arc;
      }
    }
    // 曲率为正 = 向右转，弯道外侧在前进方向的左侧（signedLateral < 0）
    const delta = 60;
    const signedCurvature = wrapAngle(track.tangentAtArc(worstArc + delta) - track.tangentAtArc(worstArc)) / delta;
    const side = signedCurvature > 0 ? -1 : 1;
    // 贴到外侧墙边（离墙 6px），车头朝墙
    const lateral = side * (CORRIDOR - 6);

    const result = runOnReal(track, DIFFICULTIES.normal, 515, {
      seconds: 20,
      warmupMs: 0,
      init: { arc: worstArc, lateral, headingOffset: side * (Math.PI / 2) },
    });
    const endProgress = track.progressAt(result.car.x, result.car.y);
    console.log(
      `  [真实赛道撞墙] 最急弯 arc=${worstArc.toFixed(0)}（曲率 ${worstCurvature.toFixed(5)}）: ` +
        `20s 前进 ${result.progressPx.toFixed(0)}px / 脱困 ${result.recoveryEntries} 次 / ` +
        `结束偏移 ${endProgress.lateralDistance.toFixed(1)}px / 车速 ${Math.abs(result.car.speed).toFixed(0)}px/s`,
    );

    assert.ok(result.recoveryEntries >= 1, '贴着外墙起步必须触发脱困');
    assert.equal(result.car.blocked, false, '结束时不应还贴在墙上');
    assert.ok(
      result.progressPx > track.totalLength * 0.5,
      `脱困后应重新跑起来，实际只前进了 ${result.progressPx.toFixed(0)}px`,
    );
    assert.ok(
      endProgress.lateralDistance < CORRIDOR * 0.7,
      `脱困后应回到线路附近，实际偏移 ${endProgress.lateralDistance.toFixed(1)}px`,
    );
    assert.ok(
      result.recoveryFrames * FRAME_MS < 8000,
      `20 秒里倒车 ${((result.recoveryFrames * FRAME_MS) / 1000).toFixed(1)}s，太久了`,
    );
  });
});

/**
 * 圈速标定（需求："困难档要跑得跟玩家差不多快"）。
 *
 * 标尺是玩家在 track1 上约 45 秒（≈502px/s，几乎贴着 520px/s 的车辆极速），
 * 所以困难档定在 48～50 秒：比玩家慢一点，但慢得有限，玩家一旦失误就会被追上。
 *
 * 这几条断言就是"调难度别调飘"的护栏：只改 constants 里的 speedCapRatio
 * 而不重新核对实测圈速时，这里会直接报出来。
 */
describe('AI 圈速标定（REQ-008 的可量化验收）', () => {
  /** 3 圈用时（秒），每档取 3 个 seed 的平均值，避免单个 seed 的运气成分。 */
  function lapSeconds(trackId: string, difficulty: DifficultyId): number {
    const track = loadTrack(trackId);
    const goal = track.totalLength * TUNING.race.laps;
    const times: number[] = [];
    for (const seed of [1, 2, 3]) {
      const result = runOnReal(track, DIFFICULTIES[difficulty], seed, { seconds: 300 });
      const ms = timeToDistance(result, goal);
      assert.ok(ms !== null, `${trackId} / ${difficulty} / seed ${seed} 没在 300 秒内跑完 3 圈`);
      times.push(ms / 1000);
    }
    return times.reduce((a, b) => a + b, 0) / times.length;
  }

  it('track1：困难档 3 圈落在 48～50 秒（玩家参考 45 秒）', () => {
    const seconds = lapSeconds('track1', 'hard');
    console.log(`  [圈速] track1 困难 ${seconds.toFixed(2)}s（玩家参考 45.00s）`);
    assert.ok(
      seconds >= 48 && seconds <= 50,
      `track1 困难档应落在 48～50 秒，实际 ${seconds.toFixed(2)}s`,
    );
  });

  it('三档圈速都严格递增（困难 < 普通 < 简单），且困难比简单明显快', () => {
    const easy = lapSeconds('track1', 'easy');
    const normal = lapSeconds('track1', 'normal');
    const hard = lapSeconds('track1', 'hard');
    console.log(
      `  [圈速] track1 简单 ${easy.toFixed(2)}s / 普通 ${normal.toFixed(2)}s / 困难 ${hard.toFixed(2)}s`,
    );
    assert.ok(hard < normal && normal < easy, `圈速必须随难度递减，实际 ${hard} / ${normal} / ${easy}`);
    assert.ok(hard < easy * 0.85, `困难只比简单快 ${(((easy - hard) / easy) * 100).toFixed(1)}%，不够明显`);
  });

  it('三张赛道都能跑完且不长时间卡墙，困难档都是最快的一档', () => {
    for (const id of ['track1', 'track3']) {
      const track = loadTrack(id);
      const goal = track.totalLength * TUNING.race.laps;
      const seconds = 300;
      const results = DIFFICULTY_IDS.map((difficulty) => {
        const result = run(track, DIFFICULTIES[difficulty], 2026, {
          seconds,
          createCar: () => new RealTrackCar(track),
        });
        const ms = timeToDistance(result, goal);
        assert.ok(
          ms !== null,
          `${id} / ${difficulty} 在 ${seconds}s 内没跑完 ${TUNING.race.laps} 圈（只跑了 ` +
            `${(result.progressPx / track.totalLength).toFixed(2)} 圈）—— 长期卡墙了`,
        );
        assert.ok(
          result.recoveryFrames * FRAME_MS < seconds * 1000 * 0.4,
          `${id} / ${difficulty} 脱困时间占比过高`,
        );
        return ms / 1000;
      });
      console.log(
        `  [圈速] ${id}：简单 ${results[0].toFixed(2)}s / 普通 ${results[1].toFixed(2)}s / 困难 ${results[2].toFixed(2)}s`,
      );
      assert.ok(
        results[2] < results[1] && results[1] < results[0],
        `${id} 圈速必须随难度递减，实际 ${results.map((v) => v.toFixed(2)).join(' / ')}`,
      );
    }
  });
});

/**
 * 真物理（`VehicleDynamics`）下的 AI 漂移（CR-06 第 1 项）。
 *
 * 用真物理而不是假车的原因：漂移决策依赖 `vehicle.driftAngle`，而那个量只有
 * 横向物理模型（`VehicleDynamics.updateLateral`）会产出。假车的 `driftAngle`
 * 恒为 0，`shouldDrift` 的 `driftMaxAngle` 闸门就永远不生效 ——
 * **测出来的"会漂移"是假的**。这一组测试专门守这条。
 *
 * ⚠️ 这里也踩过一次坑：`AIDriver` 的曲率是**前视点估算**的，比赛道几何曲率小很多
 * （track1 几何 0.0081 vs AI 测到 0.0051）。第一版把漂移阈值照着几何曲率定成 0.0065，
 * 结果漂移帧数恒为 0 —— 而圈速完全正常，看不出任何异常。
 */
describe('困难 AI 漂移（CR-06）', () => {
  /**
   * 用真物理跑一段，返回漂移帧数与贴墙帧数。
   *
   * 拆成"取赛道"与"跑"两步，是为了让测试能注入一个**自定义 profile**
   * （例如 `{...hard, useDrift: true}`）—— 这样"漂移机制"与
   * "当前发布配置是否开漂移"就能分开验证。
   */
  function runRealPhysicsOn(track: MetaTrack, profile: DifficultyProfile, seconds: number) {
    const meta = JSON.parse(
      readFileSync(new URL(`../public/assets/maps/${track.id}.meta.json`, import.meta.url), 'utf8'),
    ) as TrackMeta;
    const dynamics = new VehicleDynamics({
      grassFactor: meta.surface.grassSpeedFactor,
      grassRecoverSeconds: meta.surface.grassRecoverSeconds,
    });
    const pose = track.poseAt(0);
    dynamics.reset(pose.heading, 0, 0);
    const car: VehicleLike & { driftAngle: number; blocked: boolean } = {
      x: pose.x,
      y: pose.y,
      heading: pose.heading,
      speed: 0,
      driftAngle: 0,
      blocked: false,
    };
    const driver = new AIDriver(profile, 13);
    const out = makeInput();
    const frames = Math.round((seconds * 1000) / FRAME_MS);

    let wallFrames = 0;
    let maxCurvature = 0;
    for (let i = 0; i < frames; i++) {
      driver.drive(car, track, FRAME_MS, out);
      maxCurvature = Math.max(maxCurvature, driver.lastCurvature);

      const clamped = track.constrain(car.x, car.y);
      car.blocked = clamped !== null;
      if (clamped) {
        car.x = clamped.x;
        car.y = clamped.y;
        car.speed = 0;
        dynamics.speed = 0;
        wallFrames += 1;
      }

      const onTrack = track.progressAt(car.x, car.y).lateralDistance <= HALF_WIDTH;
      dynamics.step(FRAME_MS / 1000, out, onTrack, true);
      car.heading = dynamics.heading;
      car.speed = dynamics.speed;
      // 关键一行：把侧滑角喂回给 AI。少了它，漂移决策的闸门读到的永远是 0。
      car.driftAngle = dynamics.driftAngle;
      car.x += dynamics.velocityX * (FRAME_MS / 1000);
      car.y += dynamics.velocityY * (FRAME_MS / 1000);
    }
    return { driftFrames: driver.driftFrames, wallFrames, maxCurvature };
  }

  /** 按赛道 id + 难度跑一段。 */
  function runRealPhysics(id: string, difficulty: DifficultyId, seconds: number) {
    return runRealPhysicsOn(loadTrack(id), getDifficulty(difficulty), seconds);
  }

  it('漂移机制本身正确：开关打开时会在急弯输出 drift（与档位当前是否启用无关）', () => {
    // ⚠️ 这条**不依赖** `TUNING.difficulty.hard.useDrift` 的当前取值。
    //
    // 困难档目前刻意关掉了漂移（等「超级 S 弯道」图落地再看效果），
    // 但漂移的**机制与调参**必须继续被测试盯着 —— 否则将来那张图做好、
    // 重新打开开关时，才发现阈值早就因为赛道改动而失效了。
    // 这里注入一个"开了漂移"的 profile 副本来验机制本身。
    const driftProfile: DifficultyProfile = { ...getDifficulty('hard'), useDrift: true };
    const r = runRealPhysicsOn(loadTrack('track1'), driftProfile, 50);
    console.log(`  [漂移机制] track1 + useDrift=true：${r.driftFrames} 帧 / 贴墙 ${r.wallFrames} 帧`);
    assert.ok(
      r.driftFrames > 0,
      `开了 useDrift 却一帧都没漂 —— 漂移阈值 ${TUNING.ai.driftCurvature} 高于 AI 测到的最大曲率 ` +
        `${r.maxCurvature.toFixed(5)}，条件永远不成立`,
    );
    assert.equal(r.wallFrames, 0, `漂移不该让 AI 撞墙（撞了 ${r.wallFrames} 帧）`);
  });

  it('当前发布配置下三档都不漂移（等 S 弯图落地再开困难档）', () => {
    for (const difficulty of DIFFICULTY_IDS) {
      assert.notEqual(
        getDifficulty(difficulty).useDrift,
        true,
        `${difficulty} 档当前不该开漂移 —— 漂移图还没做出来`,
      );
      const r = runRealPhysics('track1', difficulty, 30);
      assert.equal(r.driftFrames, 0, `${difficulty} 档在发布配置下不该漂移`);
    }
  });

  it('漂移阈值落在"AI 实际能测到的曲率范围"内（防止阈值定成死条件）', () => {
    // 这条断言的意义：把"阈值必须可达"写成测试。
    // 只要有人按几何曲率去调这个数（0.0073+），这条就会红。
    const r = runRealPhysics('track1', 'hard', 30);
    assert.ok(
      r.maxCurvature > TUNING.ai.driftCurvature,
      `AI 在 track1 测到的最大曲率 ${r.maxCurvature.toFixed(5)} 没有超过漂移阈值 ` +
        `${TUNING.ai.driftCurvature}，漂移永远触发不了`,
    );
  });

  it('困难 AI 圈速仍然优于普通档（发布配置下走抓地跑法）', () => {
    const goal = loadTrack('track1').totalLength * TUNING.race.laps;
    const hard = run(loadTrack('track1'), getDifficulty('hard'), 13, {
      seconds: 300,
      createCar: () => new RealTrackCar(loadTrack('track1')),
    });
    const normal = run(loadTrack('track1'), getDifficulty('normal'), 13, {
      seconds: 300,
      createCar: () => new RealTrackCar(loadTrack('track1')),
    });
    const hardMs = timeToDistance(hard, goal);
    const normalMs = timeToDistance(normal, goal);
    assert.ok(hardMs !== null && normalMs !== null, '两档都必须跑完 3 圈');
    console.log(
      `  [圈速] 困难 ${(hardMs / 1000).toFixed(2)}s vs 普通 ${(normalMs / 1000).toFixed(2)}s（漂移帧 ${hard.driftCount}）`,
    );
    assert.ok(hardMs < normalMs, `困难 ${(hardMs / 1000).toFixed(2)}s 不慢于普通 ${(normalMs / 1000).toFixed(2)}s`);
  });
});

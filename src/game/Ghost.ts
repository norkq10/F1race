import { TUNING } from './constants';
import type { GhostData } from './types';

/**
 * M4 幽灵车（REQ-006 / REQ-018）。
 *
 * 本文件是**纯逻辑**：只依赖 constants / types，绝不 import Phaser 的值，
 * 这样录制与回放都能在 Node 单元测试里跑（集成层负责把位姿贴到 sprite 上）。
 */

/** 把角度归一化到 (-π, π]，最短弧插值的前提。 */
function wrapToPi(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** 取两个方向之间的最短夹角（正负表示顺时针 / 逆时针），范围 (-π, π]。 */
export function shortestAngleDelta(from: number, to: number): number {
  return wrapToPi(to - from);
}

/** 校验采样间隔之类的参数；非法值退回配置默认值，避免产出无法通过校验的数据。 */
function safeIntervalMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : TUNING.ghost.sampleIntervalMs;
}

/**
 * 录制玩家驾驶轨迹：把位姿重采样到**严格等距的时间网格**上（0、interval、2×interval …）。
 *
 * 关键点：不能"发现距上次落点超过 intervalMs 时就记下当前坐标"。
 * 那样实际采样间隔会吸附到整数帧（144Hz 下 8 帧 = 55.6ms，75Hz 下 4 帧 = 53.3ms），
 * 而回放是按标称 50ms 推进的 —— 幽灵车会跑得比录制时快（144Hz 下快 11%），
 * 而且误差随圈数累积，很快就甩开玩家跑出画面。
 *
 * 现在的做法：跨过网格时刻时，用**前后两帧插值**求出网格整点的位姿再落点，
 * 网格严格等距，回放就与录制同速。
 */
export class GhostRecorder {
  private readonly intervalMs: number;
  private readonly maxSamples: number;
  /** 扁平数组，每 3 个数为 [x, y, heading]。 */
  private frames: number[] = [];
  /** 下一个待填充的网格时刻（毫秒）。 */
  private nextGridMs = 0;
  /** 上一帧的位姿，用于向网格时刻插值。 */
  private prevT = 0;
  private prevX = 0;
  private prevY = 0;
  private prevHeading = 0;
  private hasPrev = false;

  constructor(intervalMs: number, maxSamples: number) {
    this.intervalMs = safeIntervalMs(intervalMs);
    this.maxSamples =
      Number.isFinite(maxSamples) && maxSamples >= 1 ? Math.floor(maxSamples) : TUNING.ghost.maxSamples;
  }

  reset(): void {
    this.frames = [];
    this.nextGridMs = 0;
    this.hasPrev = false;
    this.prevT = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.prevHeading = 0;
  }

  /**
   * 比赛计时推进时调用。
   * elapsedMs 是这一帧结束时的比赛时间；单位是"比赛计时"而不是墙钟，
   * 所以即使掉帧或被钳制，网格时间轴仍然与回放一致。
   */
  capture(elapsedMs: number, x: number, y: number, heading: number): void {
    // 采样点已满（超长比赛）后直接丢弃，保护 localStorage 体积
    if (this.sampleCount >= this.maxSamples) return;
    if (!Number.isFinite(elapsedMs) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(heading)) {
      return;
    }

    if (!this.hasPrev) {
      // 第一个采样点固定落在 t=0 网格上，回放才与录制同源
      this.frames.push(x, y, heading);
      this.nextGridMs = this.intervalMs;
      this.remember(elapsedMs, x, y, heading);
      return;
    }

    // 跨过哪些网格时刻，就把那些时刻的位姿插值补上（一帧跨多个网格时由循环兜住）
    let guard = 0;
    while (this.nextGridMs <= elapsedMs && this.sampleCount < this.maxSamples && guard++ < 8192) {
      const span = elapsedMs - this.prevT;
      const u = span > 1e-6 ? Math.min(1, Math.max(0, (this.nextGridMs - this.prevT) / span)) : 0;
      const delta = shortestAngleDelta(this.prevHeading, heading);
      this.frames.push(
        this.prevX + (x - this.prevX) * u,
        this.prevY + (y - this.prevY) * u,
        wrapToPi(this.prevHeading + delta * u),
      );
      this.nextGridMs += this.intervalMs;
    }

    this.remember(elapsedMs, x, y, heading);
  }

  private remember(t: number, x: number, y: number, heading: number): void {
    this.prevT = t;
    this.prevX = x;
    this.prevY = y;
    this.prevHeading = heading;
    this.hasPrev = true;
  }

  /** 结束录制，产出可存档的数据（返回副本，之后继续 capture 不会改动它）。 */
  build(totalMs: number): GhostData {
    const total = Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : this.recordedMs;
    return {
      version: TUNING.ghost.dataVersion,
      totalMs: total,
      intervalMs: this.intervalMs,
      frames: [...this.frames],
    };
  }

  get sampleCount(): number {
    return this.frames.length / 3;
  }

  /** 最后一帧对应的比赛时间（首帧为 0）。网格等距，所以可以直接乘出来。 */
  private get recordedMs(): number {
    return this.sampleCount > 1 ? (this.sampleCount - 1) * this.intervalMs : 0;
  }
}

/** 回放：按比赛时间查询插值后的位姿。 */
export class GhostPlayback {
  readonly totalMs: number;
  /** 数据里实际记录到的时长（最后一帧的时间）。 */
  readonly recordedMs: number;

  private readonly frames: number[];
  private readonly count: number;
  private readonly intervalMs: number;

  constructor(data: GhostData) {
    this.intervalMs = safeIntervalMs(data.intervalMs);
    this.frames = sanitizeFrames(data.frames);
    this.count = this.frames.length / 3;
    this.recordedMs = this.count > 1 ? (this.count - 1) * this.intervalMs : 0;
    this.totalMs = Number.isFinite(data.totalMs) ? data.totalMs : this.recordedMs;
  }

  /** 记录里是否没有任何有效帧。 */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * 查询 elapsedMs 时刻的位姿；超出记录范围返回 null。
   * 位置线性插值，朝向走最短弧（否则在 ±π 附近幽灵车会瞬间打转）。
   */
  sampleAt(elapsedMs: number): { x: number; y: number; heading: number } | null {
    if (this.count === 0 || !Number.isFinite(elapsedMs)) return null;
    // 负时间视为起点：回放刚开始时可能传入极小的负值
    if (elapsedMs <= 0) return this.frameAt(0);
    if (elapsedMs > this.recordedMs) return null;

    const exact = elapsedMs / this.intervalMs;
    const index = Math.floor(exact);
    if (index >= this.count - 1) return this.frameAt(this.count - 1);

    const t = exact - index;
    return this.interpolate(index, index + 1, t);
  }

  private frameAt(index: number): { x: number; y: number; heading: number } {
    const base = index * 3;
    return { x: this.frames[base], y: this.frames[base + 1], heading: this.frames[base + 2] };
  }

  private interpolate(a: number, b: number, t: number): { x: number; y: number; heading: number } {
    const from = this.frameAt(a);
    const to = this.frameAt(b);
    const delta = shortestAngleDelta(from.heading, to.heading);
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      heading: wrapToPi(from.heading + delta * t),
    };
  }
}

/** 丢掉尾部不完整 / 含非有限值的采样点，手改过的存档不应该让回放产出 NaN。 */
function sanitizeFrames(frames: readonly number[]): number[] {
  if (!Array.isArray(frames)) return [];
  const usable = Math.floor(frames.length / 3);
  const out: number[] = [];
  for (let i = 0; i < usable; i++) {
    const x = frames[i * 3];
    const y = frames[i * 3 + 1];
    const heading = frames[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(heading)) break;
    out.push(x, y, heading);
  }
  return out;
}

/** 校验一份来路不明的幽灵数据是否可用（存档可能被手改过）。 */
export function isValidGhostData(value: unknown): value is GhostData {
  if (!value || typeof value !== 'object') return false;
  const ghost = value as Partial<GhostData>;
  // 格式版本不匹配说明是别的东西写进来的，宁可当没有记录
  if (ghost.version !== TUNING.ghost.dataVersion) return false;
  if (!Number.isFinite(ghost.totalMs) || (ghost.totalMs as number) < 0) return false;
  if (!Number.isFinite(ghost.intervalMs) || (ghost.intervalMs as number) <= 0) return false;
  if (!Array.isArray(ghost.frames)) return false;
  // 至少要有一帧可以回放，且必须正好是 3 的整数倍
  if (ghost.frames.length < 3 || ghost.frames.length % 3 !== 0) return false;
  return ghost.frames.every((v) => Number.isFinite(v));
}

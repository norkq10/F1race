import type { LapResult } from './types';

/** LapTimer 构造参数（全部外部注入，模块本身不依赖 Phaser / DOM）。 */
export interface LapTimerOptions {
  /** 中心线总弧长（像素）。 */
  totalLength: number;
  /** 比赛圈数。 */
  lapCount: number;
  /**
   * 是否是**单程**赛道（点对点）。默认 false = 闭环绕圈。
   *
   * 单程与闭环只差两件事，都用这个开关分支，闭环那条路径**一个字节都不动**：
   *  1. 相邻帧的弧长增量不做 ±半圈归一（单程没有"绕回来"这回事，取模会把
   *     冲线后的 `arc` 折回 0，凭空算出一个巨大的负增量）；
   *  2. 跨过 `totalLength` 即本圈完成 —— 由于单程的 `laps` 恒为 1，
   *     这一圈就是**整趟成绩**，完成后计时停止（不再重置 lapStart、不再开下一圈）。
   */
  open?: boolean;
  /** 分段时间数（例如 3 = S1/S2/S3）。 */
  sectorCount: number;
  /** 每个分段内记录几个检查点。 */
  checkpointsPerSector: number;
  /** 车辆在赛道上的极速，用于"进度跳跃"判定。 */
  maxSpeed: number;
  /** 允许的弧长增量倍率。 */
  jumpTolerance: number;
  /** 判定阈值的兜底余量（像素）。 */
  jumpSlackPx: number;
}

/** 只读状态快照，供 HUD 使用。 */
export interface LapTimerSnapshot {
  running: boolean;
  finished: boolean;
  /** 比赛总用时（帧边界上的累计值；完赛后请用 totalMs）。 */
  elapsedMs: number;
  /** 当前圈已用时。 */
  lapMs: number;
  /** 当前圈进度 0..1。 */
  lapProgress: number;
  /** 当前是第几圈（1 基）。 */
  currentLap: number;
  laps: LapResult[];
  /** 各圈用时之和；没有完成任何一圈时为 null。 */
  totalMs: number | null;
  /** 本场最佳有效圈；没有有效圈时为 null。 */
  bestLapMs: number | null;
  /** 各分段的最佳成绩（跨场累积由存档负责，这里是本场）。 */
  bestSectorsMs: (number | null)[];
  /** 与参考圈（历史最佳或本场最佳）的实时差值，正 = 更慢。 */
  liveDeltaMs: number | null;
  /** 实时差值参照的是"本场刚刷出的更快圈"还是"历史存档"。 */
  referenceSource: 'session' | 'history' | null;
  /** 当前这一圈是否已经被判无效。 */
  currentLapInvalid: boolean;
  currentLapInvalidReason: string | null;
}

/**
 * 计时引擎。
 *
 * 三个要点：
 *  1. **精确过线**：帧与帧之间用弧长增量做插值，算出真正越过终点的时刻，
 *     而不是把整帧时间算进去。60FPS 下把 ≤16.7ms 的量化误差压到亚毫秒。
 *  2. **无效圈判定**：沿中心线的弧长增量不可能超过"极速 × 时间"，
 *     一旦超出说明发生了抄近道 / 切弯式的进度跳跃，本圈判无效，不污染纪录。
 *  3. **检查点曲线**：每圈记录 checkpointsPerSector × sectorCount 个时间点，
 *     既用来算分段时间，也用来做平滑的实时 delta。
 */
export class LapTimer {
  readonly totalLength: number;
  readonly lapCount: number;
  readonly sectorCount: number;
  readonly checkpointsPerSector: number;
  readonly checkpointCount: number;
  /** 是否是单程赛道（点对点）。见 `LapTimerOptions.open`。 */
  readonly open: boolean;

  private readonly maxSpeed: number;
  private readonly jumpTolerance: number;
  private readonly jumpSlackPx: number;

  private running = false;
  /** 帧边界的累计比赛时间（下一次 update 的起点）。 */
  private elapsed = 0;
  private lapStartMs = 0;
  private lapArc = 0;
  private lastArc = 0;

  private laps: LapResult[] = [];
  private lapValid = true;
  private invalidReason: string | null = null;

  /** 当前圈的检查点用时，索引 0 = 0，索引 checkpointCount = 本圈总时间。 */
  private currentCheckpoints: number[] = [];
  /** 参考圈（最快的那一圈）的检查点曲线。 */
  private referenceCheckpoints: number[] | null = null;
  private referenceSource: 'session' | 'history' | null = null;

  private bestLap: number | null = null;
  private bestSectors: (number | null)[] = [];
  private liveDelta: number | null = null;

  constructor(options: LapTimerOptions) {
    this.totalLength = options.totalLength;
    this.lapCount = options.lapCount;
    this.sectorCount = Math.max(1, options.sectorCount);
    this.checkpointsPerSector = Math.max(1, options.checkpointsPerSector);
    this.checkpointCount = this.sectorCount * this.checkpointsPerSector;
    this.open = options.open === true;
    this.maxSpeed = options.maxSpeed;
    this.jumpTolerance = options.jumpTolerance;
    this.jumpSlackPx = options.jumpSlackPx;
    this.bestSectors = new Array(this.sectorCount).fill(null);
  }

  /** 设置历史最佳圈的检查点曲线作为 delta 参考（长度不匹配则忽略）。 */
  setReference(checkpointsMs: readonly number[] | null): void {
    if (!checkpointsMs || checkpointsMs.length !== this.checkpointCount + 1) {
      this.referenceCheckpoints = null;
      this.referenceSource = null;
      return;
    }
    this.referenceCheckpoints = [...checkpointsMs];
    this.referenceSource = 'history';
    this.liveDelta = null;
  }

  /** 重置本场数据，但保留 delta 参考。 */
  reset(): void {
    this.running = false;
    this.elapsed = 0;
    this.lapStartMs = 0;
    this.lapArc = 0;
    this.lastArc = 0;
    this.laps = [];
    this.lapValid = true;
    this.invalidReason = null;
    this.currentCheckpoints = new Array(this.checkpointCount + 1).fill(0);
    this.bestLap = null;
    this.bestSectors = new Array(this.sectorCount).fill(null);
    this.liveDelta = null;
  }

  /** 从指定的中心线弧长位置开始计时（发车瞬间调用）。 */
  start(arc: number): void {
    this.reset();
    this.running = true;
    this.lastArc = this.normalizeArc(arc);
  }

  /**
   * 把弧长归一化到 [0, total)。
   *
   * 单程赛道**不归一**：它的终点不是起点，把 `arc` 取模会让"冲线之后"的读数
   * 折回 0（表现为成绩表里出现一整圈的假增量）。夹在下限 0 即可 ——
   * 单程倒车也不该退到起点之前。
   */
  private normalizeArc(arc: number): number {
    const total = this.totalLength;
    if (this.open) return Math.min(total, Math.max(0, arc));
    let value = arc % total;
    if (value < 0) value += total;
    return value;
  }

  /**
   * 公开的归一化（与内部推进用的规则完全一致）。
   *
   * 存在的理由：调用方手里也有一份"这辆车现在在哪段弧长上"（`RaceScene` 的
   * `racer.lastArc`，连续进度查询要用它做窗口锚点）。**两份状态必须用同一套约定** ——
   * 踩过的坑：锚点存了未归一的 7531.97（等于起跑点，闭环下也等于 0），
   * 而计时器内部存的是 0，于是发车后第一帧的增量被算成 +7531.97 → 整场判"切弯"。
   */
  normalize(arc: number): number {
    return this.normalizeArc(arc);
  }

  /** 把当前圈标记为无效（重复调用只保留第一个原因）。 */
  markInvalid(reason: string): void {
    if (!this.lapValid) return;
    this.lapValid = false;
    this.invalidReason = reason;
  }

  /**
   * 把进度基准对齐到指定弧长。
   * 瞬移之后必须调用，否则下一帧会被当成"抄近道"而误判为本圈无效。
   * 注意不能用 `update(0, arc)` 代替：dt 为 0 时 update 会直接返回。
   */
  rebase(arc: number): void {
    this.lastArc = this.normalizeArc(arc);
  }

  /**
   * 推进一帧。
   * @param dtMs 本帧时长（毫秒）
   * @param arc 车当前位置在中心线上的弧长
   * @returns 本帧完成的圈（通常为空数组）
   */
  update(dtMs: number, arc: number): LapResult[] {
    const completed: LapResult[] = [];
    if (!this.running || dtMs <= 0) return completed;

    const total = this.totalLength;
    const frameStartMs = this.elapsed;

    // 相邻帧的弧长增量。
    //
    // 闭环：中心线首尾相接，一个很大的正/负增量其实可能是"绕了另一侧"，按 ±半圈归一。
    // 单程：起点与终点不是同一个地方，**没有可归一的东西** —— 照上面的规则改写会
    // 把"冲线瞬间从 20660 掉回 0"当成 -20660px 的跳变，于是整趟被判"切弯"无效。
    let delta = arc - this.lastArc;
    if (!this.open) {
      if (delta > total / 2) delta -= total;
      else if (delta < -total / 2) delta += total;
    }
    this.lastArc = arc;

    // --- 进度跳跃检测：正常行驶的弧长增量有硬上限
    const maxAdvance = this.maxSpeed * (dtMs / 1000) * this.jumpTolerance + this.jumpSlackPx;
    if (Math.abs(delta) > maxAdvance) {
      this.markInvalid('切弯：赛道进度异常跳跃');
    }

    if (delta > 0) {
      const segment = total / this.checkpointCount;
      let remaining = delta;
      let cursor = this.lapArc;
      let guard = 0;

      while (remaining > 1e-9 && guard++ <= this.checkpointCount + 1) {
        const nextIndex = Math.floor(cursor / segment + 1e-9) + 1;
        const boundary = nextIndex >= this.checkpointCount ? total : nextIndex * segment;
        const need = boundary - cursor;

        if (need <= remaining + 1e-9) {
          // 本帧内跨过了这个边界，插值出精确时刻
          const travelled = delta - remaining + need;
          const atMs = frameStartMs + (travelled / delta) * dtMs;
          remaining -= need;
          cursor = boundary;

          if (nextIndex >= this.checkpointCount) {
            completed.push(this.completeLap(atMs));
            // 单程：这一圈就是整趟，跨过终点后**本帧剩下的弧长不能继续推进**。
            // 不 break 的话，循环会把 `cursor` 归零后拿着剩余的 delta 继续跑 ——
            // 于是"已跑进度"从 0 重新开始（表现为进度条冲线后掉回 0）。
            if (this.open) break;
            cursor = 0;
          } else {
            this.currentCheckpoints[nextIndex] = atMs - this.lapStartMs;
          }
        } else {
          cursor += remaining;
          remaining = 0;
        }
      }

      // 单程跨过终点时不能把 `lapArc` 拉回 0（那会让进度条冲线后掉回 0）——
      // `completeLap` 已经把它钉在 totalLength，这里保持不动。
      if (!(this.open && completed.length > 0)) this.lapArc = cursor;
    } else if (delta < 0) {
      // 倒车：进度回退，起点处夹在 0，避免负进度被后续前进白刷
      this.lapArc = Math.max(0, this.lapArc + delta);
    }

    this.elapsed = frameStartMs + dtMs;
    this.updateLiveDelta();
    return completed;
  }

  private completeLap(atMs: number): LapResult {
    const lapMs = Math.max(0, atMs - this.lapStartMs);
    this.currentCheckpoints[this.checkpointCount] = lapMs;

    const sectorsMs: number[] = [];
    for (let s = 0; s < this.sectorCount; s++) {
      const from = this.currentCheckpoints[s * this.checkpointsPerSector];
      const to = this.currentCheckpoints[(s + 1) * this.checkpointsPerSector];
      sectorsMs.push(Math.max(0, to - from));
    }

    const result: LapResult = {
      index: this.laps.length + 1,
      lapMs,
      valid: this.lapValid,
      invalidReason: this.invalidReason,
      sectorsMs,
    };
    this.laps.push(result);

    if (result.valid && (this.bestLap === null || lapMs < this.bestLap)) {
      this.bestLap = lapMs;
      this.referenceCheckpoints = [...this.currentCheckpoints];
      this.referenceSource = 'session';
      for (let s = 0; s < this.sectorCount; s++) {
        const previous = this.bestSectors[s];
        this.bestSectors[s] = previous === null || sectorsMs[s] < previous ? sectorsMs[s] : previous;
      }
    }

    // 单程：跨过终点就是整场结束，**不再开下一圈**。
    //
    // 这里把 `running` 置 false 是必要的：场景要到它自己那一帧才调 `stop()`，
    // 中间还有若干次 `update()`。不置 false 的话，车冲线后继续往前滑，
    // `lapArc` 会被一帧帧推过 `totalLength`（成绩看着在涨、进度条超过 100%）。
    // `update()` 开头就有 `if (!running) return`，所以这一置就够了。
    if (this.open) {
      this.running = false;
      this.lapArc = this.totalLength;
      return result;
    }

    // 进入下一圈
    this.lapStartMs = atMs;
    this.currentCheckpoints = new Array(this.checkpointCount + 1).fill(0);
    this.lapValid = true;
    this.invalidReason = null;
    return result;
  }

  private updateLiveDelta(): void {
    const reference = this.referenceCheckpoints;
    if (!reference || this.lapArc <= 0) {
      this.liveDelta = null;
      return;
    }
    const segment = this.totalLength / this.checkpointCount;
    const index = Math.min(this.checkpointCount - 1, Math.max(0, Math.floor(this.lapArc / segment)));
    const fraction = (this.lapArc - index * segment) / segment;
    const referenceMs = reference[index] + (reference[index + 1] - reference[index]) * fraction;
    this.liveDelta = this.elapsed - this.lapStartMs - referenceMs;
  }

  get snapshot(): LapTimerSnapshot {
    const finished = this.laps.length >= this.lapCount;
    const totalMs = this.laps.length > 0 ? this.laps.reduce((sum, lap) => sum + lap.lapMs, 0) : null;
    return {
      running: this.running,
      finished,
      elapsedMs: this.elapsed,
      lapMs: this.running ? this.elapsed - this.lapStartMs : 0,
      lapProgress: this.totalLength > 0 ? this.lapArc / this.totalLength : 0,
      currentLap: Math.min(this.laps.length + 1, this.lapCount),
      laps: this.laps.map((lap) => ({ ...lap, sectorsMs: [...lap.sectorsMs] })),
      totalMs,
      bestLapMs: this.bestLap,
      bestSectorsMs: [...this.bestSectors],
      liveDeltaMs: this.liveDelta,
      referenceSource: this.referenceSource,
      currentLapInvalid: !this.lapValid,
      currentLapInvalidReason: this.invalidReason,
    };
  }

  /** 历史最佳圈的检查点曲线（本场刷新后即为本场的更快圈）。 */
  get checkpoints(): number[] | null {
    return this.referenceCheckpoints ? [...this.referenceCheckpoints] : null;
  }

  /** 停止计时（完赛后调用，冻结 elapsed）。 */
  stop(): void {
    this.running = false;
  }
}

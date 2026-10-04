/**
 * GhostRunner.ts
 * 幽灵车的装载、回放推进与时间差计算（纯逻辑部分，**不 import Phaser**）。
 *
 * 为什么单独成模块：这部分以前埋在 `RaceScene` 里（同时管着 sprite 的可见性、
 * 位置与 HUD 文本），没法写单元测试。而它有一处非常容易错的数学 ——
 * **幽灵车进度要用"±半圈归一"的增量累加**，否则每绕一圈进度就会跳变一次，
 * 表现为 HUD 上的时间差在过线瞬间突然变成 ±几十秒。
 *
 * 拆法：本模块只管"进度与时间差"这件纯计算。sprite 的创建 / 摆位 / 显隐留在场景里
 * —— 那部分必须认识 Phaser，也不值得为它写测试。
 */

/**
 * 幽灵车回放 + 进度累计。
 *
 * 调用顺序（每帧）：`advance(pose)` → `gapMs(playerProgressPx, playerSpeed)`。
 */
export class GhostRunner {
  private progressPx = 0;
  private lastArc = 0;
  private started = false;
  /**
   * 赛道总长（像素）。
   *
   * ⚠️ 刻意**不**写成 `constructor(private readonly totalLength: number)`：
   * 单元测试跑的是 Node 的"类型剥离"模式，它不支持 TypeScript 的**参数属性**
   * （会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。整个项目都守着这条约束。
   */
  private readonly totalLength: number;

  constructor(totalLength: number) {
    this.totalLength = totalLength;
  }

  /** 幽灵车累计进度（像素）。 */
  get progress(): number {
    return this.progressPx;
  }

  /** 最近一次的弧长读数（调试用）。 */
  get arc(): number {
    return this.lastArc;
  }

  /** 重置到起跑状态（发车 / 重开时调用）。 */
  reset(startArc: number): void {
    this.progressPx = 0;
    this.lastArc = startArc;
    this.started = true;
  }

  /**
   * 按幽灵车当前位置推进累计进度。
   *
   * **关键点**：用 ±半圈归一的增量累加，而不是直接取 `arc`。
   * `arc` 在过起跑线时会从 `totalLength` 跳回 0，直接相减会得到 `-totalLength`
   * 这个巨大负值 —— 那会让 HUD 的时间差在过线瞬间突然变成几十秒。
   *
   * @param arc 幽灵车当前所在弧长
   * @returns 归一化后的本帧增量（像素），调试 / 测试用
   */
  advance(arc: number): number {
    if (!this.started) {
      this.lastArc = arc;
      this.started = true;
      return 0;
    }
    let delta = arc - this.lastArc;
    if (delta > this.totalLength / 2) delta -= this.totalLength;
    else if (delta < -this.totalLength / 2) delta += this.totalLength;
    this.lastArc = arc;
    // 钳到非负：幽灵车理论上不该后退，但录制的抖动会带来极小负增量
    this.progressPx = Math.max(0, this.progressPx + delta);
    return delta;
  }

  /**
   * 与幽灵车的时间差（**正 = 玩家领先**）。
   *
   * 用"进度差 ÷ 玩家当前车速"做线性估算 —— 不是精确值，但只要车速稳定就够准，
   * 而且比"记录每个采样点的时间戳再插值"便宜得多（后者要为一整场的每一帧做二分）。
   *
   * 分母有 120px/s 的下限：玩家静止时进度差除以 0 会得到 Infinity，
   * HUD 上会显示成一个荒唐的巨大数字。
   */
  gapMs(playerProgressPx: number, playerSpeed: number): number {
    const gapPx = playerProgressPx - this.progressPx;
    return (gapPx / Math.max(120, Math.abs(playerSpeed))) * 1000;
  }
}

/**
 * 由一圈的弧长读数序列累计出总进度（像素）。
 *
 * 存在的意义：让"±半圈归一"这件事可以被直接测。真正的运行期逻辑在
 * `GhostRunner.advance()` 里（逐帧、有状态），这个纯函数版与它共用同一套算法，
 * 测试会断言两者结果一致 —— 免得将来只改了一边。
 *
 * ⚠️ 结果**不保证严格单调**：负增量会被钳到 0（幽灵车理论上不该后退），
 * 所以"倒退一段再前进"的序列会看到进度停住不动。这是刻意行为，不是 bug。
 *
 * @param arcs 按时间顺序的弧长读数（0..totalLength）
 * @param totalLength 赛道总长
 * @returns 每一步之后的累计进度（长度与 arcs 相同；空输入返回空数组）
 */
export function accumulateProgress(arcs: readonly number[], totalLength: number): number[] {
  if (arcs.length === 0) return [];
  const out: number[] = [];
  let progress = 0;
  let last = arcs[0];
  out.push(progress);
  for (let i = 1; i < arcs.length; i++) {
    let delta = arcs[i] - last;
    if (delta > totalLength / 2) delta -= totalLength;
    else if (delta < -totalLength / 2) delta += totalLength;
    last = arcs[i];
    progress = Math.max(0, progress + delta);
    out.push(progress);
  }
  return out;
}

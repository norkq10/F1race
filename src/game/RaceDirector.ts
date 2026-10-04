/**
 * RaceDirector.ts
 * 比赛状态机（纯逻辑，**不 import Phaser**，可直接单元测试）。
 *
 * 为什么把它单独抽出来：`RaceScene` 曾经 1290 行、113 个方法，把状态机、
 * 排名、幽灵车、小地图、结算、调试 API 全塞在一个 Phaser 场景里。
 * `docs/known-issues.md` 记录的两个最隐蔽的 bug 恰好都出在这一带：
 *
 *  - 第 9 条：`updateRanking()` 没进每帧循环 → 排名整场是发车瞬间的快照；
 *  - 第 10 条：`syncProgressBaseline()` 遍历了全部 racer → 瞬移调试把 AI 基准一起改了。
 *
 * 根因不是"代码丑"，而是**这两块逻辑没有单元测试** —— 它们被埋在 Phaser 场景里，
 * 而场景没法在 Node 里跑。抽成纯模块之后，这些历史 bug 就有了直接的回归测试。
 *
 * 本模块只负责"什么时候该做什么"，不碰任何渲染 / 物理 / DOM。
 * 需要与外部交互的地方全部走构造时注入的回调（见 `RaceDirectorEffects`）。
 */

/** 比赛阶段。 */
export type RacePhase = 'countdown' | 'racing' | 'finished';

/** 倒计时数字（索引 = 第几个 step，越界表示不显示）。 */
export const COUNTDOWN_LABELS = ['3', '2', '1'] as const;

export interface RaceDirectorConfig {
  /** 单个倒计时数字的时长（毫秒）。 */
  countdownStepMs: number;
  /** 倒计时总时长（毫秒），到时进入 racing。 */
  countdownMs: number;
}

/**
 * 状态机对外部的副作用出口。
 *
 * 全部可选：状态机自己不关心"有没有人听"，没有监听者时它照样正确推进状态。
 * 场景在构造时把这些接到 HUD / 物理 / 计时器上。
 */
export interface RaceDirectorEffects {
  /** 倒计时数字变化（从 3 到 1）。 */
  onCountdownStep?(label: string): void;
  /** 倒计时结束、正式发车。 */
  onBeginRacing?(): void;
  /** 暂停状态变化。 */
  onPausedChanged?(paused: boolean): void;
  /** 比赛结束。 */
  onFinished?(): void;
}

export class RaceDirector {
  private phase: RacePhase = 'countdown';
  private isPaused = false;
  /** 本段倒计时还剩多少毫秒。暂停时冻结，恢复后接着走（而不是跳过暂停的那段）。 */
  private countdownLeftMs: number;
  /** 已经播报到第几个数字（-1 = 还没播）。 */
  private stepShown = -1;
  private readonly config: RaceDirectorConfig;
  private readonly effects: RaceDirectorEffects;

  constructor(config: RaceDirectorConfig, effects: RaceDirectorEffects = {}) {
    this.config = config;
    this.effects = effects;
    this.countdownLeftMs = config.countdownMs;
  }

  get state(): RacePhase {
    return this.phase;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  get racing(): boolean {
    return this.phase === 'racing';
  }

  get finished(): boolean {
    return this.phase === 'finished';
  }

  /** 当前该显示的倒计时数字（没有则 null）。 */
  get countdownLabel(): string | null {
    if (this.phase !== 'countdown') return null;
    return COUNTDOWN_LABELS[this.stepShown] ?? null;
  }

  /**
   * 推进一帧。
   *
   * @param dtMs 本帧时长（毫秒）
   * @returns 本帧是否发生了"发车"这一状态跃迁（调用方据此做一次性初始化）
   */
  tick(dtMs: number): boolean {
    // 暂停或已结束时，状态机完全冻结：不推进倒计时、不发车。
    // 这就是"暂停期间车辆不可动"的根 —— 计时不前进，比赛也就不开始。
    if (this.isPaused || this.phase !== 'countdown') return false;

    this.countdownLeftMs -= dtMs;

    // 播报当前数字（只用"已经过去的时间"反推，不依赖累计误差小的帧率）
    const elapsed = this.config.countdownMs - Math.max(0, this.countdownLeftMs);
    const step = Math.floor(elapsed / this.config.countdownStepMs);
    if (step !== this.stepShown) {
      this.stepShown = step;
      const label = COUNTDOWN_LABELS[step];
      if (label !== undefined) this.effects.onCountdownStep?.(label);
    }

    if (this.countdownLeftMs <= 0) {
      this.beginRacing();
      return true;
    }
    return false;
  }

  /** 立即发车（跳过剩余倒计时）。倒计时期间以外调用无效。 */
  beginRacing(): void {
    if (this.phase !== 'countdown') return;
    this.phase = 'racing';
    this.stepShown = -1;
    this.effects.onBeginRacing?.();
  }

  /**
   * 暂停。
   *
   * 允许在倒计时期间暂停：这时"计时已停"是事实，画面也该冻住。
   * （曾经这里限制成"只有 racing 才能暂停"，结果倒计时按 Esc 毫无反应。）
   */
  pause(): boolean {
    if (this.isPaused || this.phase === 'finished') return false;
    this.isPaused = true;
    this.effects.onPausedChanged?.(true);
    return true;
  }

  /** 恢复。 */
  resume(): boolean {
    if (!this.isPaused) return false;
    this.isPaused = false;
    this.effects.onPausedChanged?.(false);
    return true;
  }

  /** 暂停状态下切换。 */
  togglePause(): void {
    if (this.isPaused) this.resume();
    else this.pause();
  }

  /**
   * 结束比赛。
   *
   * @returns 是否真的发生了跃迁（重复调用返回 false，避免结算跑两遍）
   */
  finish(): boolean {
    if (this.phase === 'finished') return false;
    this.phase = 'finished';
    // 完赛之后不允许再处于暂停态，否则结算面板会被暂停覆盖层压住
    if (this.isPaused) {
      this.isPaused = false;
      this.effects.onPausedChanged?.(false);
    }
    this.effects.onFinished?.();
    return true;
  }

  /** 回到倒计时初始状态（重开比赛）。 */
  reset(): void {
    const wasPaused = this.isPaused;
    this.phase = 'countdown';
    this.isPaused = false;
    this.countdownLeftMs = this.config.countdownMs;
    this.stepShown = -1;
    // 重开时若原本处于暂停，也要把暂停覆盖层收掉
    if (wasPaused) this.effects.onPausedChanged?.(false);
  }

  /**
   * 是否接受驾驶输入。
   *
   * 只有"正式比赛中且未暂停"才接受。倒计时期间锁死是 REQ-015 的硬要求。
   */
  get acceptsInput(): boolean {
    return this.phase === 'racing' && !this.isPaused;
  }
}

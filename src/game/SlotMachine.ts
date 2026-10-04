/**
 * SlotMachine.ts
 * 结算抽奖：刷新本赛道最佳总时间之后弹出的"老虎机"演出（纯 DOM + CSS）。
 *
 * 需求要点：
 *   - 三连相同 = 中奖，中奖动画要"有力气、华丽、惊艳、富贵"；
 *   - CR-15 落地后中奖**产出车辆皮肤**（`onSettled` 回调由场景接线，
 *     见 `RaceScene.handleLotterySettled`）—— 它不再是空转的演出；
 *   - 中奖率与总开关在 `TUNING.lottery`：**发布默认关闭**，
 *     99% 只作为 `?lottery=test` 的调试覆盖（CR-08 第 1 条）。
 *
 * 实现说明：三条转轮各自是一个纵向排布的符号带（`reel-strip`），
 * 用 CSS transition 把带子往上滚到目标符号；每条带子的尾部是"重复的符号序列"，
 * 所以滚动时看起来是无限循环的。停稳后再按中奖与否播放不同的收尾动画。
 */

import { TUNING } from './constants';

/** 转轮上的符号（纯装饰）。 */
const SYMBOLS = ['💎', '👑', '🏆', '💰', '7️⃣'];

/** 每条带子是符号序列重复几遍（转起来才够长、够快）。 */
const STRIP_REPEATS = 6;
/** 每个符号格的高度（像素），必须与 CSS 里的 .reel 高度一致。 */
const REEL_CELL_PX = 78;

/**
 * 转动期间显示的中性提示。
 *
 * 必须**每次抽奖都一样**，而且**不能提到任何结果相关的字眼**：只要它随结果变化、
 * 或者暗示"看起来要中了"，玩家在转轮停稳前就已经知道答案了。
 * （真踩过两处：未中奖时开转就写"差一点就三连了…"；
 * 另一种写法"转动中…三连相同即中奖"里带着"中奖"二字，同样算剧透。）
 *
 * 玩法说明放在 HTML 的静态文案里（`#lottery-hint` 的初始值），结果由 `settle()` 写进
 * `#lottery-verdict`。
 */
const SPIN_HINT = '转动中…';

export interface LotteryOptions {
  /** 随机源，注入以便测试。"中奖"由它决定。 */
  random?: () => number;
  /**
   * 本次抽奖使用的中奖率。
   *
   * 默认取 `TUNING.lottery.winRate`；调试覆盖（`?lottery=test`）会传
   * `TUNING.lottery.testWinRate`。做成参数而不是在类里读 URL：
   * 这个类不认识 URL，也不该认识。
   */
  winRate?: number;
  /** 全部停稳并播完中奖 / 未中奖动画后回调。 */
  onSettled?: (won: boolean) => void;
}

export class SlotMachine {
  private readonly root: HTMLElement;
  private readonly strips: HTMLElement[];
  private readonly verdict: HTMLElement;
  private readonly burst: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly random: () => number;
  /** 本次使用的中奖率（可变：调试覆盖可以在每次 play 前改）。 */
  private winRate: number;
  private timers: number[] = [];
  private settled = false;
  private won = false;
  private closed = false;

  constructor(root: HTMLElement, options: LotteryOptions = {}) {
    this.root = root;
    this.random = options.random ?? Math.random;
    this.winRate = options.winRate ?? TUNING.lottery.winRate;
    this.strips = [0, 1, 2].map((i) => {
      const el = document.getElementById(`reel-${i}`);
      if (!el) throw new Error(`[F1race] 缺少转轮 DOM：#reel-${i}`);
      return el;
    });
    this.verdict = SlotMachine.require('lottery-verdict');
    this.burst = SlotMachine.require('lottery-burst');
    this.hint = SlotMachine.require('lottery-hint');
    this.onSettled = options.onSettled;
  }

  private readonly onSettled?: (won: boolean) => void;

  private static require(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`[F1race] 缺少抽奖 DOM 元素 #${id}`);
    return el;
  }

  /**
   * 改中奖率（调试 / 验收用）。
   *
   * ⚠️ 只改概率，不改"抽奖是否开启" —— 开关在场景手里（`TUNING.lottery.enabled`）。
   */
  setWinRate(winRate: number): void {
    this.winRate = winRate;
  }

  /** 当前生效的中奖率（调试 / 验收用：断言"发布默认不是 0.99"）。 */
  get effectiveWinRate(): number {
    return this.winRate;
  }

  /** 是否已经出结果（中奖与否都算）。 */
  get isSettled(): boolean {
    return this.settled;
  }

  /** 本次抽奖是否中奖（未出结果时为 false）。 */
  get isWin(): boolean {
    return this.won;
  }

  /**
   * 播放一次抽奖。
   *
   * 转轮动作分两段，缺一不可：
   *   1. **匀速长滚**（CSS animation，linear）：滚过整条带子，
   *      看起来就是老虎机在"哗啦啦"转。这段必须够长，否则只是"啪"地跳一下，
   *      玩家根本看不清在转（第一版就是这样）；
   *   2. **减速停稳**（CSS transition）：在滚动末尾接一个缓出，精确停在目标符号上。
   *
   * 用 animation 而不是单个长 transition，是因为 transition 的缓动会让整段滚动
   * 前段慢、后段快，反而不像机器；而 animation 可以做到"匀速滚 + 最后减速"。
   *
   * @returns 本次是否中奖，调用方据此显示后续提示
   */
  play(): boolean {
    this.reset();
    this.closed = false;
    this.won = this.random() < this.winRate;

    // 中奖：三条都停在同一个符号；未中奖：第三条故意换个符号
    const winIndex = Math.floor(this.random() * SYMBOLS.length);
    const loseIndex = (winIndex + 1 + Math.floor(this.random() * (SYMBOLS.length - 1))) % SYMBOLS.length;
    const targets = this.won ? [winIndex, winIndex, winIndex] : [winIndex, winIndex, loseIndex];

    this.root.classList.remove('hidden');
    // ⚠️ 这里**不设** is-win：那是结果着色，只能在 settle() 里上。详见下面 settle 的注释。
    this.root.classList.remove('is-win');
    /**
     * ⚠️ **开转前不能透露结果。**
     *
     * 这里原来直接把结算用的那句（"三连相同 · 中奖！" / "差一点就三连了…"）写上去了，
     * 于是转轮还在哗啦啦转，玩家已经知道答案 —— 悬念全没了（玩家报的 bug）。
     *
     * 所以分两段文案：
     *   - 转动期间：一句**永远一样**的中性提示（不泄露任何信息）；
     *   - 停稳之后（`settle()`）：才换成真正的结论。
     */
    this.hint.textContent = SPIN_HINT;
    this.hint.classList.remove('hidden');
    this.verdict.classList.add('hidden');
    this.burst.classList.remove('bursting');

    // --- 建带子并复位到顶部（不带动画）
    this.strips.forEach((strip) => {
      this.buildStrip(strip);
      strip.classList.remove('spinning', 'landing');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0px)';
      // 强制重排，让上面的复位立刻生效（否则后面的动画会被合并掉）
      void strip.offsetHeight;
    });

    this.strips.forEach((strip, i) => {
      const spinMs = TUNING.lottery.spinMs[i] ?? 1600;
      const rollMs = Math.round(spinMs * 0.8);
      const baseIndex = (STRIP_REPEATS - 1) * SYMBOLS.length + targets[i];
      // 带子总高（像素）：整条重复序列的高度
      const totalPx = STRIP_REPEATS * SYMBOLS.length * REEL_CELL_PX;
      const rollTarget = -totalPx;
      const landingTarget = -baseIndex * REEL_CELL_PX;

      // 第一段：匀速滚到底（animation 的终点 = 整条带子）
      strip.style.setProperty('--spin-from', '0px');
      strip.style.setProperty('--spin-to', `${rollTarget}px`);
      strip.style.setProperty('--roll-ms', `${rollMs}ms`);
      strip.classList.add('spinning');

      // 第二段：滚动结束时把 transform 钉在滚动终点，再切到"精确落点"。
      //
      // 顺序很重要：**先摘掉 .spinning 类**。只清 `style.animation` 是不够的 ——
      // 类还在的话，下一帧 `reel-roll ... forwards` 又会生效，把 transform 重新钉回
      // 滚动终点，后面的 transition 就再也推不动它（症状：三条转轮停在空白处）。
      const timer = window.setTimeout(() => {
        strip.classList.remove('spinning');
        strip.style.animation = '';
        strip.style.transition = 'none';
        strip.style.transform = `translateY(${rollTarget}px)`;
        void strip.offsetHeight;
        strip.classList.add('landing');
        strip.style.transition = `transform ${Math.round(spinMs - rollMs)}ms cubic-bezier(0.15, 0.85, 0.25, 1)`;
        strip.style.transform = `translateY(${landingTarget}px)`;
      }, rollMs);
      this.timers.push(timer);
    });

    // 全部停稳 -> 结算
    const total = Math.max(...TUNING.lottery.spinMs) + 420;
    this.timers.push(window.setTimeout(() => this.settle(), total));
    return this.won;
  }

  /** 生成一条转轮带子：重复若干遍符号，尾部对齐到一个完整序列。 */
  private buildStrip(strip: HTMLElement): void {
    const cells: HTMLElement[] = [];
    for (let r = 0; r < STRIP_REPEATS; r++) {
      for (const symbol of SYMBOLS) {
        const cell = document.createElement('div');
        cell.className = 'reel-cell';
        cell.textContent = symbol;
        cells.push(cell);
      }
    }
    strip.replaceChildren(...cells);
  }

  /** 停稳后的收尾：中奖放华丽动画，未中奖给一句安慰。 */
  private settle(): void {
    this.settled = true;
    // 着色只在尘埃落定后才上（`is-win` 也是一条"剧透通道"：
    // 未中奖时面板会转成冷色，转轮还没停玩家就看出结果了）
    this.root.classList.toggle('is-win', this.won);
    this.verdict.classList.remove('hidden');
    if (this.won) {
      this.verdict.classList.add('is-win');
      this.verdict.textContent = '恭喜中奖！';
      this.hint.textContent = '三连相同 · 中奖！';
      // 爆发特效：金色光柱 + 撒金币（DOM 由 CSS 动画驱动）
      this.burst.replaceChildren(
        ...Array.from({ length: 28 }, (_, i) => {
          const coin = document.createElement('span');
          coin.className = 'coin';
          coin.textContent = i % 3 === 0 ? '💰' : i % 3 === 1 ? '⭐' : '💎';
          coin.style.left = `${(i * 3.6 + 4) % 100}%`;
          coin.style.animationDelay = `${(i % 9) * 70}ms`;
          return coin;
        }),
      );
      this.burst.classList.add('bursting');
      this.root.classList.add('celebrate');
    } else {
      this.verdict.classList.remove('is-win');
      this.verdict.textContent = '很遗憾，没有中奖';
      this.hint.textContent = '差一点就三连了…';
      this.root.classList.remove('celebrate');
    }
    this.onSettled?.(this.won);
  }

  /** 关闭抽奖面板。 */
  close(): void {
    this.closed = true;
    this.root.classList.add('hidden');
    this.root.classList.remove('celebrate');
    this.burst.classList.remove('bursting');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 清空定时器与状态（重开比赛 / 重新抽奖时调用）。 */
  reset(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
    this.settled = false;
    this.won = false;
    this.root.classList.remove('celebrate', 'is-win');
    this.burst.classList.remove('bursting');
    this.burst.replaceChildren();
    this.verdict.classList.add('hidden');
    // 提示回到"中性"那句：面板重开时不能残留上一轮的结果
    this.hint.textContent = SPIN_HINT;
    this.hint.classList.remove('hidden');
    this.strips.forEach((strip) => {
      strip.classList.remove('spinning', 'landing');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0px)';
    });
  }
}

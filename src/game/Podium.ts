/**
 * Podium.ts
 * 结算界面的领奖台 + 本场数据面板（纯 DOM，不依赖 Phaser）。
 *
 * 需求要点：
 *   1. 1~4 名各站一个**对应车色**的小人，一眼能看出哪个是自己；
 *   2. **只有冠军上蹦下跳**，其余名次安静站着（2/3/4 名的姿态依次更"垂头"）；
 *   3. "超越自己"这类过程数据要显示在结算界面里。
 *
 * 这里刻意不引入任何动画库：小人是几个 div 拼的像素块，
 * 冠军的弹跳用 CSS keyframes（见 style.css 的 .podium-figure.champion）。
 */

/** 一名车手在领奖台上的展示数据。 */
export interface PodiumEntry {
  rank: number;
  name: string;
  isPlayer: boolean;
  /** 车手配色（0xRRGGBB，与车身 tint 一致）。 */
  color: number;
  /** 右侧的说明文字（总时间或进度）。 */
  detail: string;
  finished: boolean;
}

/** 把 0xRRGGBB 转成 CSS 颜色。 */
function toCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** 小人配色做明暗处理（车顶高光 / 身体主色 / 阴影）。 */
function shades(color: number): { light: string; main: string; dark: string } {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const mix = (v: number, target: number, k: number) => clamp(v + (target - v) * k);
  return {
    light: toCss((clamp(mix(r, 255, 0.45)) << 16) | (clamp(mix(g, 255, 0.45)) << 8) | clamp(mix(b, 255, 0.45))),
    main: toCss(color),
    dark: toCss((clamp(mix(r, 0, 0.45)) << 16) | (clamp(mix(g, 0, 0.45)) << 8) | clamp(mix(b, 0, 0.45))),
  };
}

/**
 * 领奖台渲染器。
 *
 * 领奖台按"名次越高、台子越高"排列，视觉顺序固定为 2 / 1 / 3，第 4 名摆在旁边。
 * 用固定顺序而不是按名次排序，是因为真实的领奖台就是冠军站中间 —— 玩家不用读文字
 * 就能看出谁是第一。
 */
export class Podium {
  private readonly root: HTMLElement;
  /** 120ms 播一档的入场动画定时器。 */
  private revealTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** 清空领奖台（重开比赛时调用）。 */
  clear(): void {
    if (this.revealTimer !== null) {
      window.clearTimeout(this.revealTimer);
      this.revealTimer = null;
    }
    this.root.replaceChildren();
    this.root.classList.remove('revealed');
  }

  /**
   * 渲染领奖台。
   *
   * @param entries 全部车手（按名次排好），只取前 4 名上台
   */
  render(entries: readonly PodiumEntry[]): void {
    this.clear();
    const top = entries.slice(0, 4);
    if (top.length === 0) return;

    // 领奖台站位：2 / 1 / 3 / 4（第 4 名放在最右，台子最矮）
    const order = [1, 0, 2, 3].filter((i) => i < top.length);
    const podiumHeight: Record<number, number> = { 1: 62, 2: 44, 3: 30, 4: 18 };

    for (const index of order) {
      const entry = top[index];
      const { light, main, dark } = shades(entry.color);

      const slot = document.createElement('div');
      slot.className = 'podium-slot';
      slot.dataset['rank'] = String(entry.rank);

      const figure = document.createElement('div');
      // 冠军加 champion 类 -> CSS 里上蹦下跳；其余名次安静站着
      figure.className = `podium-figure${entry.rank === 1 ? ' champion' : ''}${entry.isPlayer ? ' is-player' : ''}`;
      figure.style.setProperty('--car-light', light);
      figure.style.setProperty('--car-main', main);
      figure.style.setProperty('--car-dark', dark);

      // 小人 = 头 + 身体 + 两条腿（像素块），圆角留着让 CSS 决定
      const head = document.createElement('span');
      head.className = 'fig-head';
      const body = document.createElement('span');
      body.className = 'fig-body';
      const legs = document.createElement('span');
      legs.className = 'fig-legs';
      figure.append(head, body, legs);

      const block = document.createElement('div');
      block.className = 'podium-block';
      block.style.height = `${podiumHeight[entry.rank] ?? 18}px`;

      const medal = document.createElement('div');
      medal.className = 'podium-medal';
      medal.textContent = String(entry.rank);

      const name = document.createElement('div');
      name.className = 'podium-name';
      name.textContent = entry.name;
      if (entry.isPlayer) name.classList.add('is-player');

      const detail = document.createElement('div');
      detail.className = 'podium-detail';
      detail.textContent = entry.detail;

      slot.append(figure, block, medal, name, detail);
      this.root.append(slot);
    }

    // 逐个"登台"：一排小人依次弹出来，比一次性出现有仪式感
    this.root.classList.add('revealed');
    const slots = Array.from(this.root.querySelectorAll<HTMLElement>('.podium-slot'));
    slots.forEach((slot, i) => {
      slot.style.animationDelay = `${i * 120}ms`;
    });
  }
}

/** 本场数据面板里的一行。 */
export interface StatRow {
  label: string;
  value: string;
  /** 强调色（新纪录之类）。 */
  accent?: boolean;
  /** 正/负号着色（超越自己为绿、退步为红）。 */
  tone?: 'good' | 'bad' | 'neutral';
}

/**
 * 把结算数据渲染成"标签 / 数值"两列的网格。
 *
 * 用 replaceChildren 全量重建而不是逐个更新：结算界面每场只渲染一次，
 * 重建更简单也不会漏字段。
 */
export function renderStats(root: HTMLElement, rows: readonly StatRow[]): void {
  root.replaceChildren(
    ...rows.flatMap((row) => {
      const label = document.createElement('div');
      label.className = 'row';
      const labelText = document.createElement('span');
      labelText.className = 'label';
      labelText.textContent = row.label;
      const value = document.createElement('span');
      value.className = 'value mono';
      if (row.accent) value.classList.add('accent');
      if (row.tone === 'good') value.classList.add('tone-good');
      if (row.tone === 'bad') value.classList.add('tone-bad');
      value.textContent = row.value;
      label.append(labelText, value);
      return [label];
    }),
  );
}

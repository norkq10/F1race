import { ASSETS, TUNING } from './constants';
import { formatDelta, formatEstimate, formatStamp, formatTime } from './format';
import { Garage } from './Garage';
import { Minimap, minimapSizeFor, type MinimapDot } from './Minimap';
import { Podium, renderStats, type StatRow } from './Podium';
import { SKINS } from './Skins';
import type { SkinStore } from './SkinStore';
import { SlotMachine } from './SlotMachine';
import type { DifficultyId, RaceResult, SaveData, StandingEntry, TrackMeta } from './types';

function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[F1race] 缺少 DOM 元素 #${id}`);
  return el as T;
}

export interface HudHandlers {
  onRestart: () => void;
  onClearSave: () => void;
  onResume: () => void;
  /** M5：切换难度（会重开比赛）。 */
  onDifficultyChange: (id: DifficultyId) => void;
  /** 切换赛道（会重开整个比赛场景）。 */
  onTrackChange: (id: string) => void;
  /** 打开车库（CR-15）。场景负责据此暂停比赛。 */
  onGarageOpen: () => void;
  /** 关闭车库。场景负责恢复暂停前的状态。 */
  onGarageClose: () => void;
  /**
   * 装备一款皮肤（CR-15）。
   *
   * @returns 是否真的换了 —— 未拥有的皮肤返回 false，车库据此给出"没生效"的反馈
   *   （`Skins.equipSkin` 刻意不替玩家解锁，见其说明）。
   */
  onSkinEquip: (id: string) => boolean;
  /**
   * 抽奖停稳后的落点（CR-15）：`won === true` 时**必须**产出皮肤。
   *
   * 这是"抽奖不再是空转演出"的唯一接线点，删掉它 CR-08 的问题就回来了。
   */
  onLotterySettled: (won: boolean) => void;
}

/** 实时排名榜的一行。 */
export interface StandingRow {
  rank: number;
  name: string;
  isPlayer: boolean;
  finished: boolean;
  /** 右侧显示的时间或差距文本。 */
  gap: string;
}

/**
 * HUD 与各类界面的 DOM 桥接层（REQ-009 / REQ-017）。
 * 只在文本真正变化时写 DOM，避免每帧无谓的重排。
 */
export class Hud {
  private readonly hud = requireEl('hud');
  private readonly lap = requireEl('hud-lap');
  private readonly lapLabel = requireEl('hud-lap-label');
  private readonly lapTime = requireEl('hud-lap-time');
  private readonly lapTimeLabel = requireEl('hud-lap-time-label');
  private readonly totalTime = requireEl('hud-total-time');
  private readonly bestLap = requireEl('hud-best-lap');
  private readonly bestTotal = requireEl('hud-best-total');
  private readonly rank = requireEl('hud-rank');
  private readonly speed = requireEl('hud-speed');
  private readonly surface = requireEl('hud-surface');
  private readonly drift = requireEl('hud-drift');
  private readonly fps = requireEl('hud-fps');
  private readonly toast = requireEl('hud-toast');

  private readonly ghost = requireEl('hud-ghost');
  private readonly difficultyLabel = requireEl('hud-difficulty');
  private readonly standingsList = requireEl<HTMLOListElement>('hud-standings');
  private readonly difficultySelect = requireEl('difficulty-select');
  private readonly trackLabel = requireEl('hud-track');
  private readonly trackSelect = requireEl('track-select');

  private readonly delta = requireEl('hud-delta');
  private readonly deltaValue = requireEl('hud-delta-value');
  private readonly deltaSource = requireEl('hud-delta-source');
  private readonly lapFlag = requireEl('hud-lap-flag');

  private readonly countdown = requireEl('countdown');
  private readonly pause = requireEl('pause');

  private readonly result = requireEl('result');
  private readonly resultTitle = requireEl('result-title');
  private readonly resultBadge = requireEl('result-badge');
  private readonly resultInvalid = requireEl('result-invalid');
  private readonly resultTotal = requireEl('result-total');
  private readonly resultDelta = requireEl('result-delta');
  private readonly resultBestLap = requireEl('result-best-lap');
  private readonly resultBestLapAll = requireEl('result-best-lap-all');
  private readonly resultBestTotal = requireEl('result-best-total');
  private readonly resultPrevious = requireEl('result-previous');
  private readonly resultLaps = requireEl<HTMLOListElement>('result-laps');
  private readonly resultSectors = requireEl('result-sectors');
  private readonly resultHistory = requireEl<HTMLOListElement>('result-history');
  private readonly resultStandings = requireEl<HTMLOListElement>('result-standings');
  private readonly resultDifficulty = requireEl('result-difficulty');
  private readonly resultStats = requireEl('result-stats');
  private readonly podiumRoot = requireEl('podium');
  private readonly podium = new Podium(this.podiumRoot);

  /** 结算抽奖（老虎机）。只在刷新本赛道最佳总时间时播放。 */
  private readonly lottery: SlotMachine;
  private readonly btnLotteryClose = requireEl<HTMLButtonElement>('btn-lottery-close');

  /**
   * 中奖产出（CR-15）：抽到的皮肤缩略图 + 明确文案。
   *
   * 重复抽到已有的皮肤时也走这块 DOM，只是换成"已拥有"的灰色样式 ——
   * **不允许静默吞掉**，玩家会记恨那种做法（见 `Skins.unlockSkin`）。
   */
  private readonly lotterySkin = requireEl('lottery-skin');
  private readonly lotterySkinThumb = requireEl<HTMLImageElement>('lottery-skin-thumb');
  private readonly lotterySkinTitle = requireEl('lottery-skin-title');
  private readonly lotterySkinDesc = requireEl('lottery-skin-desc');

  /** 车库（皮肤选择，CR-15）。 */
  private readonly garage: Garage;
  private readonly btnGarage = requireEl<HTMLButtonElement>('btn-garage');
  private readonly btnGarageClose = requireEl<HTMLButtonElement>('btn-garage-close');

  private readonly btnRestart = requireEl<HTMLButtonElement>('btn-restart');
  private readonly btnClearSave = requireEl<HTMLButtonElement>('btn-clear-save');
  private readonly btnResume = requireEl<HTMLButtonElement>('btn-resume');
  private readonly btnRestartPause = requireEl<HTMLButtonElement>('btn-restart-pause');

  private readonly cache = new Map<string, string>();
  private toastTimer: number | null = null;

  /** 小地图（右上角，固定不随镜头移动）。换赛道时按新赛道尺寸重建。 */
  private minimap: Minimap | null = null;
  private readonly minimapCanvas = requireEl<HTMLCanvasElement>('minimap-canvas');

  /**
   * @param handlers 各类界面动作的回调
   * @param skins    皮肤车库状态（CR-15）。由场景持有，这里只读 / 转发，
   *                 保证"装备状态"只有一个来源。
   */
  constructor(handlers: HudHandlers, skins: SkinStore) {
    this.btnRestart.addEventListener('click', () => handlers.onRestart());
    this.btnClearSave.addEventListener('click', () => handlers.onClearSave());
    this.btnResume.addEventListener('click', () => handlers.onResume());
    this.btnRestartPause.addEventListener('click', () => handlers.onRestart());

    for (const button of Array.from(this.difficultySelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.addEventListener('click', () => {
        const id = button.dataset['difficulty'] as DifficultyId | undefined;
        if (id) handlers.onDifficultyChange(id);
      });
    }

    for (const button of Array.from(this.trackSelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.addEventListener('click', () => {
        const id = button.dataset['track'];
        if (id) handlers.onTrackChange(id);
      });
    }

    // --- 车库（CR-15 皮肤选择）
    //
    // 装备动作由 Garage 直接回调场景：换的只是玩家精灵的贴图，不需要重开场景，
    // 所以"选中即时生效，下一场比赛使用"是天然成立的（下一场必然重新 buildRacers）。
    this.garage = new Garage(skins, {
      onClose: () => handlers.onGarageClose(),
      onEquip: (id) => handlers.onSkinEquip(id),
    });
    this.btnGarage.addEventListener('click', () => handlers.onGarageOpen());
    this.btnGarageClose.addEventListener('click', () => handlers.onGarageClose());

    // --- 抽奖（老虎机）
    //
    // ⚠️ `onSettled` 必须在这里接上：曾经 `SlotMachine.play()` 的返回值没人用，
    // 中奖只放动画、不产出任何东西 —— 那正是 CR-08 的核心问题。
    // 现在中奖会在回调里抽一款皮肤并落盘（`RaceScene.handleLotterySettled`）。
    this.lottery = new SlotMachine(requireEl('lottery'), {
      onSettled: (won) => handlers.onLotterySettled(won),
    });
    this.btnLotteryClose.addEventListener('click', () => this.closeLottery());
    // Enter / Esc 都能收下；只在抽奖面板打开时拦截，避免影响正常驾驶
    window.addEventListener('keydown', (event) => {
      if (!this.isLotteryVisible) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        this.closeLottery();
      }
    });
  }

  // ------------------------------------------------------------ 车库（CR-15）

  /** 打开车库。 */
  openGarage(highlightId: string | null = null): void {
    this.garage.open(highlightId);
  }

  /** 关闭车库。 */
  closeGarage(): void {
    this.garage.close();
  }

  /** 车库是否正在显示（调试 / 测试用）。 */
  get isGarageVisible(): boolean {
    return this.garage.isVisible;
  }

  /** 按当前皮肤状态重画车库（解锁 / 装备后调用）。 */
  renderGarage(): void {
    this.garage.render();
  }

  /** 设置抽奖使用的中奖率。 */
  setLotteryWinRate(winRate: number): void {
    this.lottery.setWinRate(winRate);
  }

  /** 当前生效的抽奖中奖率（调试 / 验收用）。 */
  get lotteryWinRate(): number {
    return this.lottery.effectiveWinRate;
  }

  /**
   * 在抽奖面板上交代中奖产出（CR-15）。
   *
   * @param id       抽到（或重复抽到）的皮肤 id
   * @param isNew    true = 首次获得；false = 已拥有（必须给出明确交代）
   */
  showLotterySkin(id: string, isNew: boolean): void {
    const skin = SKINS[id];
    this.lotterySkinThumb.src = `${ASSETS.skinUrlDir}/${ASSETS.skinUrlPrefix}${skin?.assetSuffix ?? id}.png`;
    this.lotterySkinThumb.alt = skin?.label ?? id;
    this.lotterySkinTitle.textContent = isNew ? `获得新皮肤：${skin?.label ?? id}` : `已拥有：${skin?.label ?? id}`;
    this.lotterySkinDesc.textContent = isNew
      ? `${skin?.desc ?? ''}（车库 (G) 里可以立刻装备）`
      : '重复获得，已折算成"已拥有"提示（皮肤不会重复计数）。';
    this.lotterySkin.classList.toggle('is-duplicate', !isNew);
    this.lotterySkin.classList.remove('hidden');
  }

  /** 收起中奖产出那块面板。 */
  hideLotterySkin(): void {
    this.lotterySkin.classList.add('hidden');
    this.lotterySkin.classList.remove('is-duplicate');
  }

  /** 中奖产出的文案（调试 / 测试用）。 */
  get lotterySkinText(): string {
    return this.lotterySkin.classList.contains('hidden')
      ? ''
      : `${this.lotterySkinTitle.textContent ?? ''} ${this.lotterySkinDesc.textContent ?? ''}`.trim();
  }

  /** 弹出并播放一次抽奖。 */
  playLottery(): void {
    // 每次播放都先把上一轮的中奖产出收掉，否则上一款皮肤会挂在新一轮结果旁边
    this.hideLotterySkin();
    this.lottery.play();
  }

  /** 关闭抽奖面板。 */
  closeLottery(): void {
    this.lottery.close();
  }

  /** 抽奖面板是否正在显示（调试 / 测试用）。 */
  get isLotteryVisible(): boolean {
    return !requireEl('lottery').classList.contains('hidden');
  }

  /** 抽奖是否已出结果。 */
  get isLotterySettled(): boolean {
    return this.lottery.isSettled;
  }

  /** 本次抽奖是否中奖。 */
  get isLotteryWin(): boolean {
    return this.lottery.isWin;
  }

  /** 抽奖中奖 / 未中奖的判定结果（未出结果时为 null）。 */
  get lotteryOutcome(): boolean | null {
    return this.lottery.isSettled ? this.lottery.isWin : null;
  }

  /** 领奖台根元素（调试接口用来检查小人与冠军动画）。 */
  get podiumRootElement(): HTMLElement {
    return this.podiumRoot;
  }

  /** 隐藏抽奖并清掉状态（重开比赛时调用）。 */
  resetLottery(): void {
    this.lottery.reset();
    this.lottery.close();
    this.hideLotterySkin();
  }

  // ------------------------------------------------------------ 小地图

  /**
   * 按当前赛道重建小地图。
   *
   * 每换一条赛道都要重建：赛道尺寸、中心线形状、路面宽度都不一样，
   * 投影参数和预渲染的底图都必须重算。
   */
  buildMinimap(meta: TrackMeta): void {
    // 中心线点数是赛道尺寸的两倍多，这里全部用得上（轮廓要贴着小地图走）
    const size = minimapSizeFor(meta.world.width, meta.world.height);
    this.minimap = new Minimap(this.minimapCanvas, {
      width: size.width,
      height: size.height,
      worldWidth: meta.world.width,
      worldHeight: meta.world.height,
      centerline: meta.centerline.points,
      // 路面宽度：半宽 2.3 瓦片 → 全宽 4.6 瓦片（与生成器的 HALF_WIDTH 一致）
      trackWidthPx: meta.tileSize * 4.6,
    });
  }

  /** 小地图是否已经就绪（调试 / 测试用）。 */
  get hasMinimap(): boolean {
    return this.minimap !== null;
  }

  /** 刷新小地图上的所有光点。 */
  drawMinimap(dots: readonly MinimapDot[]): void {
    this.minimap?.draw(dots);
  }

  /** 当前选中的难度。 */
  get selectedDifficulty(): DifficultyId {
    const active = this.difficultySelect.querySelector<HTMLButtonElement>('button.active');
    return (active?.dataset['difficulty'] as DifficultyId | undefined) ?? 'normal';
  }

  setDifficulty(id: DifficultyId, label: string): void {
    this.setText(this.difficultyLabel, 'difficulty', label);
    for (const button of Array.from(this.difficultySelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.classList.toggle('active', button.dataset['difficulty'] === id);
    }
  }

  /** 难度只在发车前可以改，避免比赛中途换对手。 */
  setDifficultyLocked(locked: boolean): void {
    for (const button of Array.from(this.difficultySelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = locked;
    }
  }

  /** 显示当前赛道，并把选中的按钮高亮。 */
  setTrack(id: string, label: string): void {
    this.setText(this.trackLabel, 'track', label);
    for (const button of Array.from(this.trackSelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.classList.toggle('active', button.dataset['track'] === id);
    }
  }

  /** 与难度同理：赛道也是发车前才能改（换图会重开比赛）。 */
  setTrackLocked(locked: boolean): void {
    for (const button of Array.from(this.trackSelect.querySelectorAll<HTMLButtonElement>('button'))) {
      button.disabled = locked;
    }
  }

  private setText(el: HTMLElement, key: string, text: string): void {
    if (this.cache.get(key) === text) return;
    this.cache.set(key, text);
    el.textContent = text;
  }

  show(): void {
    this.hud.classList.remove('hidden');
  }

  /**
   * 写左上角"第几圈 / 共几圈"。
   *
   * `total <= 1`（单程赛道）时**不显示 `/1`** —— 那是句废话，只会占位置。
   * 配套的文案切换见 `setLapMode`。
   */
  setLap(current: number, total: number): void {
    this.setText(this.lap, 'lap', String(current));
    const dim = this.lap.querySelector('.dim');
    if (dim) this.setText(dim as HTMLElement, 'lap-total', total > 1 ? `/${total}` : '');
  }

  /**
   * 切换左上角"圈数"那一组信息的文案。
   *
   * 闭环（3 圈）：「圈数 1/3」「当前圈速」。
   * **单程**（跑完一趟即完赛，CR-16「漂移龙」）：「进度 1/1」「本趟用时」——
   * 说"第 1 圈"会让玩家以为还有第二圈，而这张图上并没有。
   */
  setLapMode(open: boolean): void {
    this.setText(this.lapLabel, 'lap-label', open ? '进度' : '圈数');
    this.setText(this.lapTimeLabel, 'lap-time-label', open ? '本趟用时' : '当前圈速');
  }

  setLapTime(ms: number): void {
    this.setText(this.lapTime, 'lap-time', formatTime(ms));
  }

  setTotalTime(ms: number): void {
    this.setText(this.totalTime, 'total-time', formatTime(ms));
  }

  setBestLap(ms: number | null): void {
    this.setText(this.bestLap, 'best-lap', formatTime(ms));
  }

  setBestTotal(ms: number | null): void {
    this.setText(this.bestTotal, 'best-total', formatTime(ms));
  }

  setRank(position: number, total: number): void {
    this.setText(this.rank, 'rank', String(position));
    const dim = this.rank.querySelector('.dim');
    if (dim) this.setText(dim as HTMLElement, 'rank-total', `/${total}`);
  }

  setSpeed(kmh: number): void {
    this.setText(this.speed, 'speed', String(Math.round(kmh)));
  }

  setSurface(onTrack: boolean): void {
    this.setText(this.surface, 'surface', onTrack ? '赛道' : '草地 · 减速中');
    const wantOff = !onTrack;
    if (this.surface.classList.contains('off-track') !== wantOff) {
      this.surface.classList.toggle('off-track', wantOff);
    }
  }

  setFps(value: number): void {
    this.setText(this.fps, 'fps', String(Math.round(value)));
  }

  /** M3：漂移状态指示（同时把侧滑角显示出来，方便调参与验收）。 */
  setDrift(active: boolean, angleRad: number): void {
    this.setText(this.drift, 'drift', active ? `漂移 ${angleRad.toFixed(2)} rad` : '抓地');
    this.drift.classList.toggle('active', active);
  }

  /**
   * M4：幽灵车状态。
   * @param gapMs 与幽灵车的时间差，**正 = 领先**；没有记录时传 null
   */
  setGhostStatus(gapMs: number | null, hasGhost: boolean): void {
    if (!hasGhost) {
      this.setText(this.ghost, 'ghost', '无记录');
      this.ghost.classList.remove('ahead', 'behind');
      return;
    }
    if (gapMs === null) {
      this.setText(this.ghost, 'ghost', '跟随中');
      this.ghost.classList.remove('ahead', 'behind');
      return;
    }
    // 显示与「领先/落后」语义一致：领先显示 +，落后显示 −
    const ahead = gapMs > 0;
    this.setText(this.ghost, 'ghost', formatDelta(gapMs));
    this.ghost.classList.toggle('ahead', ahead);
    this.ghost.classList.toggle('behind', !ahead);
  }

  /** M5：实时排名榜。 */
  setStandings(rows: readonly StandingRow[], playerRank: number, total: number): void {
    this.setText(this.rank, 'rank', String(playerRank));
    const dim = this.rank.querySelector('.dim');
    if (dim) this.setText(dim as HTMLElement, 'rank-total', `/${total}`);
    this.renderStandings(this.standingsList, rows);
  }

  private renderStandings(list: HTMLOListElement, rows: readonly StandingRow[]): void {
    list.replaceChildren(
      ...rows.map((row) => {
        const li = document.createElement('li');
        if (row.isPlayer) li.classList.add('is-player');
        if (row.finished) li.classList.add('is-finished');

        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = String(row.rank);

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = row.name;

        const gap = document.createElement('span');
        gap.className = 'gap';
        gap.textContent = row.gap;

        li.append(rank, name, gap);
        return li;
      }),
    );
  }

  /** 实时 delta：正 = 慢于参考圈。 */
  setDelta(ms: number | null, source: 'session' | 'history' | null): void {
    const visible = ms !== null && source !== null;
    this.delta.classList.toggle('hidden', !visible);
    if (!visible) return;

    this.setText(this.deltaValue, 'delta', formatDelta(ms));
    this.setText(this.deltaSource, 'delta-source', source === 'session' ? '对比 本场最佳圈' : '对比 历史最佳圈');
    const ahead = (ms ?? 0) < 0;
    this.delta.classList.toggle('ahead', ahead);
    this.delta.classList.toggle('behind', !ahead);
  }

  /** 当前圈是否已被判无效。 */
  setLapValidity(invalid: boolean): void {
    this.lapFlag.classList.toggle('hidden', !invalid);
  }

  showCountdown(text: string, isGo: boolean): void {
    this.countdown.classList.remove('hidden', 'pop');
    this.countdown.classList.toggle('go', isGo);
    this.countdown.textContent = text;
    // 触发重排以重启动画
    void this.countdown.offsetWidth;
    this.countdown.classList.add('pop');
  }

  hideCountdown(): void {
    this.countdown.classList.add('hidden');
  }

  showPause(): void {
    this.pause.classList.remove('hidden');
  }

  hidePause(): void {
    this.pause.classList.add('hidden');
  }

  get isPauseVisible(): boolean {
    return !this.pause.classList.contains('hidden');
  }

  showToast(text: string, durationMs = 1400): void {
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), durationMs);
  }

  showResult(result: RaceResult, save: SaveData): void {
    // 结算面板盖上以后，飘在下面的 toast 只会碍事
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.classList.add('hidden');

    // 标题：把"冠军"和"新纪录"都摆出来（两者独立，可能同时成立）。
    // 以前只报纪录，于是"拿了第一但没刷纪录"在结算里看起来毫无收获 ——
    // 而抽奖恰恰会因为夺冠而触发，标题不提冠军会让人莫名其妙。
    const titleParts: string[] = ['完赛'];
    if (result.wonRace) titleParts.push('冠军');
    if (result.isNewBestTotal) titleParts.push('新纪录');
    if (!result.valid) titleParts.push('成绩无效');
    this.resultTitle.textContent = titleParts.join(' · ');

    this.resultBadge.classList.toggle('hidden', !(result.isNewBestTotal || result.isNewBestLap || result.wonRace));
    if (result.isNewBestTotal && result.isNewBestLap) this.resultBadge.textContent = '双刷新纪录！';
    else if (result.isNewBestTotal) this.resultBadge.textContent = '最佳总时间刷新！';
    else if (result.isNewBestLap) this.resultBadge.textContent = '最佳圈刷新！';
    else this.resultBadge.textContent = '冠军！';

    const invalidReasons = result.invalidReasons.filter(Boolean);
    this.resultInvalid.classList.toggle('hidden', invalidReasons.length === 0);
    this.resultInvalid.textContent = invalidReasons.length
      ? `本场成绩不计入纪录：${invalidReasons.join('；')}`
      : '';

    this.resultTotal.textContent = formatTime(result.totalMs);
    this.resultBestLap.textContent = formatTime(result.bestLapMs);
    this.resultBestLapAll.textContent = formatTime(save.bestLapMs);
    this.resultBestTotal.textContent = formatTime(save.bestTotalMs);
    this.resultPrevious.textContent =
      result.previousBestTotalMs === null ? '首次完赛' : formatTime(result.previousBestTotalMs);

    if (result.deltaToPreviousBestMs === null) {
      this.resultDelta.textContent = '首次完赛';
      this.resultDelta.classList.remove('ahead', 'behind');
    } else {
      this.resultDelta.textContent = formatDelta(result.deltaToPreviousBestMs);
      this.resultDelta.classList.toggle('ahead', result.deltaToPreviousBestMs < 0);
      this.resultDelta.classList.toggle('behind', result.deltaToPreviousBestMs >= 0);
    }

    this.resultLaps.replaceChildren(
      ...result.lapResults.map((lap) => {
        const li = document.createElement('li');
        if (!lap.valid) li.classList.add('invalid');
        else if (lap.lapMs === result.bestLapMs) li.classList.add('best');

        const name = document.createElement('span');
        name.textContent = `第 ${lap.index} 圈${lap.valid ? '' : ' · 无效'}`;
        const time = document.createElement('span');
        time.textContent = formatTime(lap.lapMs);
        li.append(name, time);
        return li;
      }),
    );

    this.resultSectors.textContent =
      result.bestSectorsMs.length > 0
        ? result.bestSectorsMs.map((ms, i) => `S${i + 1} ${formatTime(ms)}`).join('  ')
        : '无有效圈';

    this.resultHistory.replaceChildren(
      ...save.history.map((record, index) => {
        const li = document.createElement('li');
        if (index === 0) li.classList.add('current');
        if (!record.valid) li.classList.add('invalid');
        const stamp = document.createElement('span');
        stamp.textContent = `${formatStamp(record.at)}${record.valid ? '' : ' · 无效'}`;
        const time = document.createElement('span');
        time.textContent = formatTime(record.totalMs);
        li.append(stamp, time);
        return li;
      }),
    );

    this.resultDifficulty.textContent = TUNING.difficulty[result.difficulty].label;
    this.renderStandings(
      this.resultStandings,
      result.standings.map((entry: StandingEntry) => {
        // 未完赛的车：给出**预计完赛时间**（known-issues 第 9 条）。
        // 玩家冲线就结束比赛，其他车还在跑；只显示"第 3 圈"读者没法判断差多少。
        // 用 `entry.id` 查表而不是 `entry.name` —— 见 StandingEntry.id 的说明。
        const estimate = result.finishEstimatesMs.get(entry.id) ?? null;
        return {
          rank: entry.rank,
          name: entry.name,
          isPlayer: entry.isPlayer,
          finished: entry.totalMs !== null,
          gap:
            entry.totalMs !== null
              ? entry.gapMs !== null && entry.gapMs > 0
                ? `${formatTime(entry.totalMs)}  +${(entry.gapMs / 1000).toFixed(3)}`
                : formatTime(entry.totalMs)
              : estimate !== null
                ? `${entry.progressLabel ?? '未完赛'} · ${formatEstimate(estimate)}`
                : (entry.progressLabel ?? '进行中'),
        };
      }),
    );

    // 领奖台小人下方也显示同一个预计时间，保持两处文案一致
    this.podium.render(
      result.standings.slice(0, 4).map((entry) => {
        const estimate = result.finishEstimatesMs.get(entry.id) ?? null;
        return {
          rank: entry.rank,
          name: entry.name,
          isPlayer: entry.isPlayer,
          color: entry.color,
          detail:
            entry.totalMs !== null
              ? formatTime(entry.totalMs)
              : estimate !== null
                ? formatEstimate(estimate)
                : (entry.progressLabel ?? '未完赛'),
          finished: entry.totalMs !== null,
        };
      }),
    );

    // --- 领奖台：1~4 名各站一个对应车色的小人，只有冠军蹦

    this.renderResultStats(result, save);

    this.result.classList.remove('hidden');
  }

  /**
   * 本场数据面板。
   *
   * 核心是"有没有超越自己"：把本场总时间与**本赛道历史最佳**直接对比，
   * 用颜色 + 文案说明是进步还是退步。其余是成绩细节与自我表现数据。
   */
  private renderResultStats(result: RaceResult, save: SaveData): void {
    const rows: StatRow[] = [];
    const p = result.progress;

    rows.push({ label: '总时间', value: formatTime(result.totalMs), accent: result.isNewBestTotal });

    // --- 超越自己：与历史最佳对比（这一行是整个面板的重点）
    if (result.deltaToPreviousBestMs === null) {
      rows.push({ label: '超越自己', value: '首次完赛 · 已记录为最佳', tone: 'good', accent: true });
    } else {
      const d = result.deltaToPreviousBestMs;
      rows.push({
        label: '超越自己',
        value: d < 0 ? `超越！快了 ${formatDelta(-d)}` : d > 0 ? `慢了 ${formatDelta(d)}` : '与最佳持平',
        accent: d < 0,
        tone: d < 0 ? 'good' : d > 0 ? 'bad' : 'neutral',
      });
      if (result.previousBestTotalMs !== null) {
        rows.push({ label: '此前最佳总时间', value: formatTime(result.previousBestTotalMs) });
      }
    }
    rows.push({ label: '本赛道最佳总时间', value: formatTime(save.bestTotalMs) });

    rows.push({ label: '本场最佳圈', value: formatTime(result.bestLapMs), accent: result.isNewBestLap });
    rows.push({ label: '历史最佳圈', value: formatTime(save.bestLapMs) });

    // --- 自我表现数据
    rows.push({ label: '最高车速', value: `${(p.topSpeed * TUNING.vehicle.speedToKmh).toFixed(0)} km/h` });
    rows.push({ label: '漂移累计', value: `${(p.driftMs / 1000).toFixed(1)} s` });
    rows.push({ label: '撞墙次数', value: `${p.wallHits} 次` });

    // --- 成绩有效性 / 难度 / 赛道
    rows.push({
      label: '成绩有效',
      value: result.valid ? '有效' : `无效（${result.invalidReasons.join('；') || '未知'}）`,
      tone: result.valid ? 'good' : 'bad',
    });
    rows.push({ label: '最终名次', value: `第 ${result.playerRank} 名` });
    rows.push({ label: '难度', value: TUNING.difficulty[result.difficulty].label });
    rows.push({ label: '赛道', value: result.trackName });
    if (result.ghostRecorded) rows.push({ label: '幽灵车', value: '已记录本场', tone: 'good' });

    renderStats(this.resultStats, rows);
  }

  /** 重开 / 换赛道时清掉领奖台与数据面板，避免闪一下上一场的成绩。 */
  clearResultExtras(): void {
    this.podium.clear();
    this.resultStats.replaceChildren();
  }

  /** 隐藏结算面板（连带清掉领奖台动画）。 */
  hideResult(): void {
    this.result.classList.add('hidden');
    this.podium.clear();
  }

  /**
   * 收起车库覆盖层。
   *
   * 重开比赛 / 换赛道时要调：车库挡着整个屏幕，开着它"重开"了玩家也看不见比赛。
   * 场景那边会一并把暂停状态恢复（车库打开时比赛是暂停的）。
   */
  hideGarage(): void {
    this.garage.close();
  }

  get isResultVisible(): boolean {
    return !this.result.classList.contains('hidden');
  }
}

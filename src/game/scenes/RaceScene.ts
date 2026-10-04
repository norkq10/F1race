import Phaser from 'phaser';
import { AIDriver } from '../AIDriver';
import { AutoPilot } from '../AutoPilot';
import {
  computeCarContact,
  draftFactor,
  isInDraftZone,
  separatePositions,
  wrapAnglePi,
} from '../CarContact';
import {
  ASSETS,
  DEFAULT_DIFFICULTY,
  DEFAULT_TRACK_ID,
  RACER_COLORS,
  TRACK_LABELS,
  TRACK_ORDER,
  TRACK_SELECT_STORAGE_KEY,
  TUNING,
  skinAssetKey,
  trackAssetKeys,
} from '../constants';
import { getDifficulty } from '../Difficulty';
import { formatTime } from '../format';
import { GhostPlayback, GhostRecorder, isValidGhostData } from '../Ghost';
import { GhostRunner } from '../GhostRunner';
import {
  resetHudForNewRace,
  syncHudBestLap,
  syncHudFrame,
  syncHudGhost,
  type HudStaticContext,
} from '../RaceHudSync';
import { Hud, type StandingRow } from '../Hud';
import { InputController, type DriveInput } from '../InputController';
import { LapTimer } from '../LapTimer';
import { installRaceDebugApi, type DebugPlayerPhysics } from '../RaceDebugApi';
import { RaceDirector } from '../RaceDirector';
import {
  computeStandings,
  estimateFinishMs,
  progressLabelFor,
  rebasePlayerOnly,
  toStandingEntries,
  toStandingRows,
  type StandingsInput,
} from '../RaceStandings';
import {
  computeMinimapProjection,
  minimapSizeFor,
  projectToMinimap,
  type MinimapDot,
} from '../Minimap';
import { TrackSaveStores, type SaveStore } from '../SaveStore';
import { SKINS, STARTER_SKIN_ID, pickSkinDrop } from '../Skins';
import { SkinStore } from '../SkinStore';
import { Track } from '../Track';
import { Vehicle } from '../Vehicle';
import type {
  DifficultyId,
  LapResult,
  RaceProgressStats,
  RaceResult,
  RankedRacer,
  RunRecord,
  StandingEntry,
  TrackMeta,
} from '../types';

/** 难度选择的持久化键（与成绩存档分开，避免清纪录时把偏好也清掉）。 */
const DIFFICULTY_KEY = 'f1race.difficulty';

/**
 * 参赛者：玩家与 AI 共用同一套记账（各自一个 LapTimer）。
 *
 * 注意它**不是** `RaceStandings.StandingsInput`：那个是"拍平后的进度快照"，
 * 只含排名需要的字段；这个持有车辆、计时器、AI driver 等运行期对象。
 * `standingsInputs()` 负责把前者从后者投影出来 —— 这层适配是场景的职责。
 */
interface Racer {
  id: string;
  name: string;
  isPlayer: boolean;
  vehicle: Vehicle;
  timer: LapTimer;
  ai: AIDriver | null;
  /** AI 的随机种子，换难度重建 driver 时要保持一致。 */
  aiSeed: number;
  /** 完赛总时间；未完赛为 null。 */
  finishMs: number | null;
  /** 缓存的本帧总进度（像素），排名与调试用。 */
  progressPx: number;
  /**
   * 上一帧的**中心线弧长**，用于连续进度查询（`Track.arcNear`）。
   *
   * 它的作用是"记住这台车在哪条路上"：发夹弯里两段路可能靠得很近，
   * 没有这个锚点的话，全局最近点会在两段之间跳，计时器看到的就是假的进度跳跃。
   */
  lastArc: number;
  /**
   * 上一帧的**世界坐标**，用来算"这一帧实际移动了多远"。
   *
   * 连续进度查询要拿它设限：投影点离车比"这帧真的走的距离"还远，
   * 就说明那个投影在别的路段上，不能采信。少了它就只能用"速度上限 × dt"这种
   * 宽松到挡不住问题的近似（详见 `TrackGeometry.arcNear` 的注释）。
   */
  lastX: number;
  lastY: number;
  /**
   * 连续弧长查询**连续被拒**的次数。
   *
   * 投影被拒时读数原地不动（那是防止误判切弯的核心）。但要是连着被拒很多帧，
   * 说明锚点已经跟丢了（调试瞬移、被撞飞到赛道另一头），再死守旧弧长就会让这辆车
   * 永远卡住。到这个阈值就放行一次投影，让计时器去做它的判定（多半会判无效）。
   */
  rejectStreak: number;
  /** 车手配色（车身 tint / 小地图光点 / 领奖台小人共用）。 */
  color: number;
}

/** 暴露给自动化测试 / 调试的接口（window.__F1RACE__）。 */
export interface F1RaceDebugApi {
  version: string;
  milestone: string;
  ready: boolean;
  scene: RaceScene;
  getState: () => Record<string, unknown>;
  setInput: (throttle: number, steer: number) => void;
  setDrift: (enabled: boolean) => void;
  clearInput: () => void;
  setAutopilot: (enabled: boolean) => void;
  setDifficulty: (id: DifficultyId) => void;
  /** 切换赛道；会重开整个比赛场景。 */
  setTrack: (id: string) => void;
  /** 开关 AI 对手；切换会重开比赛。用于把 M1/M2 的回归测试与对手干扰隔离开。 */
  setAiEnabled: (enabled: boolean) => void;
  /** 弹出结算抽奖（纯演出，用于验收抽奖动画）。 */
  openLottery: () => void;
  closeLottery: () => void;
  /** 本帧小地图上的光点（含画布内坐标），用于验证小地图。 */
  getMinimapDots: () => (MinimapDot & { screenX: number; screenY: number })[];
  teleportToProgress: (t: number) => void;
  place: (x: number, y: number, heading?: number, speed?: number) => void;
  /** 故意不做进度对齐的瞬移，用来复现"抄近道"式的进度跳跃。 */
  cheatTeleport: (t: number) => void;
  skipCountdown: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  clearSave: () => void;
}

/**
 * 比赛场景。
 *
 * M1：可驾驶原型（瓦片赛道、镜头刚性跟随、WASD、草地减速、撞墙减速弹开、倒计时）。
 * M2：计时与成绩体系（帧内插值精确计时、无效圈、实时 delta、分段、成绩历史、暂停）。
 * M3：漂移（VehicleDynamics 的横向维度，Space 切换抓地力）。
 * M4：幽灵车（录制最佳场次并同场半透明回放，无碰撞）。
 * M5：3 台 AI 对手 + 三档难度 + 按总时间排名。
 */
export class RaceScene extends Phaser.Scene {
  /**
   * 连续弧长查询允许"连续被拒"的帧数上限。
   *
   * 超过它就放行一次投影（详见 `Racer.rejectStreak`）。取 12 帧（约 0.2 秒）：
   * 正常驾驶里被拒最多一两帧，12 帧足以区分"偶尔的投影噪声"与"锚点已经跟丢"。
   */
  private static readonly STUCK_REJECT_LIMIT = 12;
  private track!: Track;
  /** 当前赛道 id（决定加载哪张地图、以及用哪一份成绩存档）。 */
  private trackId: string = DEFAULT_TRACK_ID;
  private player!: Vehicle;
  private racers: Racer[] = [];
  private vehicleSprites: Phaser.Physics.Arcade.Sprite[] = [];
  private controls!: InputController;
  private hud!: Hud;
  /** 多赛道存档：每条赛道各自一份纪录 / 幽灵车。 */
  private saves!: TrackSaveStores;
  private save!: SaveStore;

  /**
   * 皮肤车库（CR-15）。
   *
   * **独立存储键**（`f1race.skins.v1`），与成绩存档完全解耦：操控规则升版会清空纪录，
   * 但"抽到的皮肤"不该跟着丢（见 `SkinStore.ts` 头部与 `docs/known-issues.md` 第 16 条）。
   *
   * 在这里初始化（字段初始化而不是 create()）：`trackId` 换图会重开场景，
   * 但 SkinStore 每次都从 localStorage 读回来，重建一次不会丢状态。
   */
  private readonly skins = new SkinStore();

  /**
   * 抽奖调试覆盖（`?lottery=test`）。
   *
   * CR-08 要求"抽奖发布默认关闭"，但自动化验收必须能走通"中奖 → 解锁皮肤"整条链路，
   * 所以留一个**显式**的调试口子：带上这个参数时抽奖强制开启、中奖率取
   * `TUNING.lottery.testWinRate`。发布路径（不带参数）永远是 `TUNING.lottery.enabled`。
   */
  private lotteryDebug = false;

  /**
   * 车库打开前比赛是否已经暂停。
   *
   * 车库打开时要暂停（否则玩家在菜单里被 AI 超过），关掉时要恢复**打开前**的状态 ——
   * 不能无条件 resume：玩家可能是自己按 Esc 暂停的，那样关掉车库会"帮他继续比赛"。
   */
  private garagePausedRace = false;

  /** 最近一次抽到的新皮肤 id（打开车库时高亮一下）。 */
  private lastUnlockedSkinId: string | null = null;

  private autopilot: AutoPilot | null = null;
  private debugInput: DriveInput | null = null;
  private debugDrift = false;
  private debugMode = false;

  private difficulty: DifficultyId = DEFAULT_DIFFICULTY;
  /**
   * 换赛道是"重开场景"实现的，提示语要等新场景 create() 完再弹；
   * 用构造参数传会污染场景签名，所以用这个一次性标记。
   */
  private pendingTrackNote = false;
  private ranking: RankedRacer[] = [];
  /** AI 是否参赛。关掉后 AI 会把车停到角落、计时也不推进，用于隔离回归测试。 */
  private aiEnabled = true;

  private ghostSprite: Phaser.GameObjects.Sprite | null = null;
  private ghostPlayback: GhostPlayback | null = null;
  private ghostRecorder: GhostRecorder | null = null;
  /**
   * 幽灵车进度累计器（纯逻辑，含跨线归一；见 GhostRunner.ts）。
   *
   * 赛道总长要到 create() 里读到 meta 才知道，所以这里先给 0 占位，
   * 在 installGhost() 里用真实长度重建。
   */
  private ghostRunner = new GhostRunner(0);
  private ghostRecorded = false;

  /**
   * 比赛过程中的自我表现统计（结算界面用）。
   *
   * 逐帧采样的原因：最高车速、漂移时长、撞墙次数都属于过程量，
   * 赛后只看最终成绩是算不出来的。
   */
  private peerStats = {
    topSpeed: 0,
    driftMs: 0,
    wallHits: 0,
    /** 上一帧是否贴着墙（用于把"持续贴墙"算成一次撞击）。 */
    wasBlocked: false,
  } as {
    topSpeed: number;
    driftMs: number;
    wallHits: number;
    wasBlocked: boolean;
  };

  /** 本帧小地图光点（Hud 画完之后这里留一份，供调试接口读取）。 */
  private lastMinimapDots: MinimapDot[] = [];

  /**
   * 比赛状态机（纯逻辑，见 `RaceDirector.ts`）。
   *
   * 状态**只**存在这里 —— 场景里原本的 `raceState` / `paused` / `countdownStartMs` /
   * `countdownStep` 四个字段已经删掉，读状态一律走
   * `this.director.state` / `.racing` / `.paused` / `.acceptsInput`。
   * 之前它们散在场景各处、与状态机逻辑分离，正是
   * "倒计时期间车辆可动""暂停不冻结计时"这类 bug 的温床。
   *
   * 放在字段初始化里而不是构造函数：`Phaser.Scene` 的构造函数只该 `super('Race')`，
   * 而这些回调要访问 `this.hud` / `this.physics` —— 它们同样是字段，
   * 初始化顺序上 director 在前没关系，因为回调是**延迟调用**的（真的发车/暂停时才触发）。
   */
  private readonly director = new RaceDirector(
    {
      countdownStepMs: TUNING.race.countdownStepMs,
      countdownMs: TUNING.race.countdownMs,
    },
    {
      onCountdownStep: (label) => this.handleCountdownStep(label),
      onBeginRacing: () => this.handleBeginRacing(),
      onPausedChanged: (paused) => this.handlePausedChanged(paused),
      onFinished: () => this.handleFinished(),
    },
  );

  constructor() {
    super('Race');
  }

  create(): void {
    const params = new URLSearchParams(window.location.search);
    this.debugMode = params.get('debug') === '1';
    // CR-08：抽奖发布默认关闭，`?lottery=test` 是显式的调试覆盖（见 lotteryDebug 的说明）
    this.lotteryDebug = params.get('lottery') === 'test';
    this.garagePausedRace = false;

    this.resetRuntimeState();
    this.trackId = RaceScene.loadTrackId(params);
    const assets = trackAssetKeys(this.trackId);
    const meta = this.cache.json.get(assets.metaKey) as TrackMeta | undefined;
    if (!meta) throw new Error(`[F1race] 缺少赛道元数据：${assets.metaKey}`);
    this.difficulty = RaceScene.loadDifficulty();
    // 存档要早于幽灵车装载，否则读不到最佳场次的录制
    this.saves = new TrackSaveStores(DEFAULT_TRACK_ID);
    this.save = this.saves.for(this.trackId);

    this.track = new Track(this, assets.mapKey, assets.metaKey);
    this.physics.world.setBounds(0, 0, meta.world.width, meta.world.height);

    // --- 参赛者：玩家 + 3 台 AI
    this.racers = this.buildRacers(meta);
    this.player = this.racers[0].vehicle;
    this.vehicleSprites = this.racers.map((racer) => racer.vehicle.sprite);

    this.controls = new InputController(this);
    this.installGhost(meta);

    // --- 物理：撞墙 / 车与车（REQ-014：玩家-AI、AI-AI 都减速弹开）
    for (const racer of this.racers) {
      this.physics.add.collider(racer.vehicle.sprite, this.track.wallsLayer);
    }
    this.physics.add.collider(this.vehicleSprites, this.vehicleSprites, this.onVehicleCollision);

    // --- 镜头：俯视正上方，主角固定在屏幕中心（REQ-002）
    const cam = this.cameras.main;
    cam.setBounds(0, 0, meta.world.width, meta.world.height);
    cam.setZoom(TUNING.camera.zoom);
    cam.setRoundPixels(true);
    cam.setBackgroundColor('#11131a');
    cam.startFollow(this.player.sprite, true, TUNING.camera.lerp, TUNING.camera.lerp);

    if (this.debugMode) this.installDebugHelpers();

    // --- HUD
    this.hud = new Hud(
      {
        onRestart: () => this.resetRace(),
        onResume: () => this.resumeRace(),
        onDifficultyChange: (id) => this.changeDifficulty(id),
        onTrackChange: (id) => this.changeTrack(id),
        onGarageOpen: () => this.openGarage(),
        onGarageClose: () => this.closeGarage(),
        onSkinEquip: (id) => this.equipSkin(id),
        onLotterySettled: (won) => this.handleLotterySettled(won),
        onClearSave: () => {
          this.save.clear();
          for (const racer of this.racers) racer.timer.setReference(null);
          this.ghostPlayback = null;
          this.ghostSprite?.setVisible(false);
          this.hud.setBestTotal(null);
          this.hud.setBestLap(null);
          this.hud.showToast('纪录已清除', 1100);
        },
      },
      this.skins,
    );
    // 调试覆盖只改中奖率；"抽奖是否开启"仍由 TUNING.lottery.enabled 决定
    if (this.lotteryDebug) this.hud.setLotteryWinRate(TUNING.lottery.testWinRate);
    this.hud.show();
    this.hud.hideResult();
    this.hud.hidePause();
    this.hud.setBestTotal(this.save.bestTotalMs);
    this.hud.setLapMode(this.track.isOpen);
    this.hud.setLap(1, this.track.lapCount);
    this.hud.setLapTime(0);
    this.hud.setTotalTime(0);
    this.hud.setSurface(true);
    this.hud.setDelta(null, null);
    this.hud.setLapValidity(false);
    this.hud.setDrift(false, 0);
    this.hud.setDifficulty(this.difficulty, getDifficulty(this.difficulty).label);
    this.hud.setDifficultyLocked(false);
    this.hud.setTrack(this.trackId, this.trackLabel(this.trackId));
    this.hud.setTrackLocked(false);
    this.syncHudBestLap();
    this.updateRanking();
    this.pushStandingsToHud();
    this.syncGhostHud(null);
    // 小地图按新赛道的尺寸/形状重建（换赛道会重开场景，所以放在这里）
    this.hud.buildMinimap(this.track.meta);
    this.drawMinimap();

    if (this.pendingTrackNote) {
      // 换赛道是"重开场景"实现的：提示要等新场景建好之后再弹
      this.hud.showToast(`赛道：${this.trackLabel(this.trackId)}`, 1400);
      this.pendingTrackNote = false;
    }

    if (this.save.recordsResetForRuleset) {
      this.hud.showToast('操控规则已更新（漂移），历史纪录已重置', 2600);
    }

    this.installDebugApi();

    window.dispatchEvent(new CustomEvent('f1race-ready'));

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      const w = window as unknown as Record<string, unknown>;
      if (w['__F1RACE__'] !== undefined) delete w['__F1RACE__'];
    });
  }

  /** 场景实例会被重复使用，所有可变状态必须在这里归零。 */
  private resetRuntimeState(): void {
    this.racers = [];
    this.vehicleSprites = [];
    this.autopilot = null;
    this.debugInput = null;
    this.debugDrift = false;
    this.lastUnlockedSkinId = null;
    this.garagePausedRace = false;
    // 状态机回初始态（director.reset 会在原本暂停时把暂停覆盖层收掉）
    this.director.reset();
    this.ranking = [];
    this.ghostSprite = null;
    this.ghostPlayback = null;
    this.ghostRecorder = null;
    this.ghostRunner.reset(0);
    this.ghostRecorded = false;
    this.resetPeerStats();
  }

  /** 归零自我表现统计（开赛 / 重开时调用）。 */
  private resetPeerStats(): void {
    this.peerStats = {
      topSpeed: 0,
      driftMs: 0,
      wallHits: 0,
      wasBlocked: false,
    };
  }

  // ------------------------------------------------------------ 参赛者

  /**
   * 当前装备皮肤的贴图 key（CR-15）。
   *
   * 只影响**玩家**：AI 用 `ASSETS.carAiKey` + tint、幽灵车用 `ASSETS.carGhostKey`，
   * 皮肤是玩家的收藏品，不该被对手"穿"上（也就没法靠外观认人了）。
   *
   * 兜底逻辑有两层：
   *   1. 存档里的 id 不认识 → `SkinStore` 读盘时已经被规范化掉（回落 `default`）；
   *   2. 就算 `SKINS` 里查不到，也用 `skinAssetKey(STARTER_SKIN_ID)` 兜底 ——
   *      **绝不能**返回 `ASSETS.carPlayerKey`：那样会在皮肤系统出错时静默退回旧贴图，
   *      看起来"皮肤没生效"，比直接暴露问题更难查。
   */
  private playerSkinTextureKey(): string {
    const equipped = this.skins.equipped;
    const suffix = SKINS[equipped]?.assetSuffix ?? SKINS[STARTER_SKIN_ID].assetSuffix;
    return skinAssetKey(suffix);
  }

  private static loadDifficulty(): DifficultyId {
    try {
      const raw = window.localStorage.getItem(DIFFICULTY_KEY);
      return raw === 'easy' || raw === 'normal' || raw === 'hard' ? raw : DEFAULT_DIFFICULTY;
    } catch {
      return DEFAULT_DIFFICULTY;
    }
  }

  private static storeDifficulty(id: DifficultyId): void {
    try {
      window.localStorage.setItem(DIFFICULTY_KEY, id);
    } catch {
      /* 存不了也不影响本场 */
    }
  }

  /**
   * 读取赛道选择。
   *
   * 优先级：**本地记忆 > URL 参数 > 默认赛道**。
   *
   * 为什么本地记忆优先：URL 里的 `?track=` 只是"这一次从哪张图开始"的引导参数
   * （分享链接 / 自动化测试都靠它），而玩家在 HUD 上点选的赛道是要一直记住的。
   * 如果 URL 永远优先，那么"点按钮换图 → 重开场景 → create() 又读到 URL 里的旧值"
   * 就会把刚换的图立刻换回去 —— 表现为"点了按钮没反应"（真踩过这个坑）。
   *
   * 因此这里做两件事：用本地记忆定夺结果，再把结果同步回 URL，
   * 让地址栏、localStorage、当前地图三者始终一致（刷新/分享都不会跳回旧图）。
   */
  private static loadTrackId(params: URLSearchParams): string {
    const fromUrl = params.get('track');
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(TRACK_SELECT_STORAGE_KEY);
    } catch {
      /* 读不到就只看 URL */
    }

    let chosen: string = DEFAULT_TRACK_ID;
    if (stored && (TRACK_ORDER as readonly string[]).includes(stored)) {
      chosen = stored;
    } else if (fromUrl && (TRACK_ORDER as readonly string[]).includes(fromUrl)) {
      chosen = fromUrl;
    }

    if (fromUrl !== chosen) {
      try {
        params.set('track', chosen);
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
      } catch {
        /* 改不了 URL 也不影响本场，地图已经按 chosen 加载了 */
      }
    }
    return chosen;
  }

  private static storeTrackId(id: string): void {
    try {
      window.localStorage.setItem(TRACK_SELECT_STORAGE_KEY, id);
    } catch {
      /* 存不了也不影响本场 */
    }
  }

  /** 赛道显示名：优先用地图元数据里的名字，读不到时用常量表兜底。 */
  private trackLabel(id: string): string {
    const meta = this.cache.json.get(trackAssetKeys(id).metaKey) as TrackMeta | undefined;
    if (meta?.name) return meta.name;
    return TRACK_LABELS[id as keyof typeof TRACK_LABELS] ?? id;
  }

  /**
   * 换赛道：记下选择并**重开整个场景**。
   *
   * 换图不是换个背景那么简单 —— 瓦片地图、中心线、碰撞层、相机边界、幽灵车
   * 甚至成绩纪录都要跟着换。与其在场景里逐项替换（漏掉一处就是"上一张图的车
   * 还停在草地上"这种脏状态），不如让 Phaser 走一次标准的 shutdown → create：
   * 场景里的显示对象、物理体、碰撞器、计时器全部由引擎负责清理，不会残留。
   */
  private changeTrack(id: string): void {
    if (!(TRACK_ORDER as readonly string[]).includes(id)) return;
    if (id === this.trackId) return;
    RaceScene.storeTrackId(id);
    this.pendingTrackNote = true;
    // 车库开着时比赛是暂停的；重开场景前先收掉它并把暂停状态还原，
    // 否则新场景是"暂停中"起来的，玩家会看到车不动还找不到原因。
    this.closeGarage();
    this.resumeRace();
    // 提示语不在这里弹：scene.restart() 会重建整个场景，toast 的回调计时器也一起没了。
    // 提示放在 create() 里（见 switchNote），换图完成后自然会显示。
    this.scene.restart();
  }

  /**
   * 发车格：**所有车并排在同一条起跑线上**（统一发车线）。
   *
   * 以前是"玩家在最前、AI 依次往后错开"的阶梯式发车格，现在改成同一弧长位置 (arc = 0)、
   * 只做左右横向错开，所以四台车的前保险杠在同一条线上，谁起步快谁先出弯。
   *
   * 横向偏移按 `(0, -1, +1, -2)` 循环取，保证同一时刻没有两台车占同一条线：
   * 车身半径 12px、赛道半宽 73.6px，`gridLateralPx` 取 30px 时
   * 最外侧（±2 格 = ±60px）仍在赛道内，且相邻车之间留 60px 净空，不会一开赛就互撞。
   */
  private gridSlot(index: number): { x: number; y: number; heading: number; arc: number } {
    const sample = this.track.pointAtArc(0);
    // 0, -1, +1, -2, +2 ... 的横向格子顺序
    const lane = index === 0 ? 0 : (index % 2 === 1 ? -1 : 1) * Math.ceil(index / 2);
    const normalX = -Math.sin(sample.tangent);
    const normalY = Math.cos(sample.tangent);
    const lateral = lane * TUNING.ai.gridLateralPx;
    return {
      x: sample.x + normalX * lateral,
      y: sample.y + normalY * lateral,
      heading: sample.tangent,
      arc: 0,
    };
  }

  private buildRacers(meta: TrackMeta): Racer[] {
    const racers: Racer[] = [];
    const profile = getDifficulty(this.difficulty);

    for (let i = 0; i <= TUNING.ai.count; i++) {
      const isPlayer = i === 0;
      const slot = this.gridSlot(i);
      const vehicle = new Vehicle(
        this,
        slot.x,
        slot.y,
        slot.heading,
        // CR-15：玩家用当前装备的皮肤贴图；AI 与幽灵车不受皮肤影响（见 playerSkinTextureKey）
        isPlayer ? this.playerSkinTextureKey() : ASSETS.carAiKey,
        {
          isPlayer,
          grassFactor: meta.surface.grassSpeedFactor,
          grassRecoverSeconds: meta.surface.grassRecoverSeconds,
        },
      );
      vehicle.placeAt(slot.x, slot.y, slot.heading);

      if (!isPlayer) {
        const tintIndex = (i - 1) % TUNING.ai.tints.length;
        vehicle.sprite.setTint(TUNING.ai.tints[tintIndex]);
      }

      // 每台 AI 用不同 seed，走线才不会完全重合
      const aiSeed = i * 977 + 13;
      racers.push({
        id: isPlayer ? 'player' : `ai${i}`,
        name: isPlayer ? '玩家' : (TUNING.ai.names[i - 1] ?? `AI${i}`),
        isPlayer,
        vehicle,
        timer: this.createTimer(),
        ai: isPlayer ? null : new AIDriver(profile, aiSeed),
        aiSeed,
        finishMs: null,
        progressPx: 0,
        // 连续弧长的锚点：发车时就是这条车道的中心线弧长（**归一化**，与计时器同约定；
        // 起跑点在闭环下会被算成 `total - ε`，不归一的话第一帧增量就是一整圈）
        lastArc: this.track.normalizeArc(this.track.progressAt(slot.x, slot.y).arc),
        // 上一帧位置（用于算"这帧实际移动了多远"）。发车时就是发车格坐标。
        lastX: slot.x,
        lastY: slot.y,
        rejectStreak: 0,
        // 车手配色：小地图光点与领奖台小人都用它，必须与车身 tint 一致
        color: RaceScene.racerColor(isPlayer, i),
      });
    }
    return racers;
  }

  /**
   * 建计时器。
   *
   * 圈数与拓扑**都跟着赛道走**（`track.lapCount` / `track.isOpen`），不是全局常量：
   * 「漂移龙」是单程赛道（`laps: 1` + `open: true`），跑完一趟就是整场成绩；
   * 另外两条是 3 圈闭环。以前这里写死 `TUNING.race.laps`，单程图会被要求跑 3 遍。
   */
  private createTimer(): LapTimer {
    return new LapTimer({
      totalLength: this.track.totalLength,
      lapCount: this.track.lapCount,
      open: this.track.isOpen,
      sectorCount: TUNING.race.sectorCount,
      checkpointsPerSector: TUNING.race.checkpointsPerSector,
      maxSpeed: TUNING.vehicle.maxSpeed,
      jumpTolerance: TUNING.race.progressJumpTolerance,
      jumpSlackPx: TUNING.race.progressJumpSlackPx,
    });
  }

  // ------------------------------------------------------------ M4 幽灵车

  private installGhost(meta: TrackMeta): void {
    const data = this.save.bestGhost;
    this.ghostRecorder = new GhostRecorder(TUNING.ghost.sampleIntervalMs, TUNING.ghost.maxSamples);
    // 进度累计器需要赛道总长才能做跨线归一，这里用真实值重建
    this.ghostRunner = new GhostRunner(this.track.totalLength);

    if (!isValidGhostData(data)) {
      this.ghostPlayback = null;
      return;
    }
    this.ghostPlayback = new GhostPlayback(data);
    // 幽灵车没有物理体：天然满足 REQ-018（不会与任何车碰撞）
    this.ghostSprite = this.add
      .sprite(meta.start.x, meta.start.y, ASSETS.carGhostKey)
      .setAlpha(TUNING.ghost.alpha)
      .setDepth(9)
      .setVisible(false);
  }

  private updateGhost(racing: boolean, elapsedMs: number): void {
    const sprite = this.ghostSprite;
    const playback = this.ghostPlayback;
    if (!sprite || !playback) return;

    const pose = playback.sampleAt(racing ? elapsedMs : 0);
    if (!pose) {
      sprite.setVisible(false);
      this.syncGhostHud(null);
      return;
    }

    sprite.setVisible(true);
    sprite.setPosition(pose.x, pose.y);
    sprite.setRotation(pose.heading + Math.PI / 2);

    if (!racing) return;

    // 进度累计（含跨线归一）交给 GhostRunner —— 那段数学有单测覆盖
    this.ghostRunner.advance(this.track.progressAt(pose.x, pose.y).arc);
    this.syncGhostHud(this.ghostGapMs());
  }

  /**
   * 与幽灵车的时间差（正 = 领先）。
   *
   * 用"进度差 ÷ 玩家当前车速"做线性估算，实现在 `GhostRunner.gapMs`
   * （分母有下限，玩家静止时不会算出 Infinity）。
   */
  private ghostGapMs(): number | null {
    if (!this.ghostPlayback) return null;
    return this.ghostRunner.gapMs(this.playerProgressPx(), Math.abs(this.player.speed));
  }

  private syncGhostHud(gapMs: number | null): void {
    syncHudGhost(this.hud, gapMs, this.ghostPlayback !== null);
  }

  private playerProgressPx(): number {
    const racer = this.racers[0];
    if (!racer) return 0;
    const snapshot = racer.timer.snapshot;
    return snapshot.laps.length * this.track.totalLength + snapshot.lapProgress * this.track.totalLength;
  }

  // ------------------------------------------------------------ M5 排名
  //
  // 计算全部委托给 `RaceStandings`（纯逻辑 + 单测）。场景只负责"把计时器读数
  // 拍成快照"这一层适配 —— 那部分是唯一需要认识 LapTimer 的地方。

  /**
   * 把每台车的计时器读数拍成排名模块要的快照。
   *
   * `lapsCompleted` 用 `snapshot.laps.length`，`lapArc` 用
   * `lapProgress × totalLength` —— 与 `RaceStandings` 里
   * `总进度 = 圈数 × 长度 + 本圈弧长` 的约定对应。
   */
  private standingsInputs(): StandingsInput[] {
    return this.racers.map((racer) => {
      const snapshot = racer.timer.snapshot;
      return {
        id: racer.id,
        name: racer.name,
        isPlayer: racer.isPlayer,
        lapsCompleted: snapshot.laps.length,
        lapArc: snapshot.lapProgress * this.track.totalLength,
        finished: racer.finishMs !== null,
        finishMs: racer.finishMs,
        color: racer.color,
      };
    });
  }

  /**
   * 重算排名。
   *
   * ⚠️ **必须每帧调用**（在 `updateHud()` 里）。曾经它只挂在 create/reset/finish 上，
   * 导致比赛途中的名次一直是发车瞬间的快照 —— 见 `docs/known-issues.md` 第 9 条，
   * 回归测试在 `tests/race-standings.test.ts`。
   */
  private updateRanking(): void {
    const inputs = this.standingsInputs();
    const result = computeStandings(inputs, this.track.totalLength);
    this.ranking = result.ranking;
    // 把总进度写回 racer，供调试接口与 AI 读取
    for (const racer of this.racers) {
      racer.progressPx = result.progressPx.get(racer.id) ?? 0;
    }
  }

  private standingRows(): StandingRow[] {
    // 传 context 是为了让"落后很多的未完赛 AI"显示预计完赛时间
    // （known-issues 第 9 条：它们本来只有"第 N 圈"，读者看不出还差多久）
    const player = this.racers.find((r) => r.isPlayer);
    return toStandingRows(this.ranking, this.standingsInputs(), (entry) => this.progressLabel(entry), {
      totalLength: this.track.totalLength,
      elapsedMs: this.racers[0]?.timer.snapshot.elapsedMs ?? 0,
      playerFinishMs: player?.finishMs ?? null,
      lapCount: this.track.lapCount,
    });
  }

  /**
   * 未完赛者在排名里的进度文案。
   *
   * 规则本身在 `RaceStandings.progressLabelFor`（纯函数，单测覆盖）：
   * 闭环「第 N 圈」、单程「进行中」—— 单程只有一趟，"第 1 圈"会让人以为还要再跑一圈。
   */
  private progressLabel(entry: RankedRacer): string {
    return progressLabelFor(entry, this.track.lapCount, this.track.isOpen);
  }

  private get playerRank(): number {
    return this.ranking.find((entry) => entry.isPlayer)?.rank ?? 1;
  }

  private pushStandingsToHud(): void {
    this.hud.setStandings(this.standingRows(), this.playerRank, this.racers.length);
  }

  private changeDifficulty(id: DifficultyId): void {
    if (this.difficulty === id && this.director.state === 'countdown') return;
    this.difficulty = id;
    RaceScene.storeDifficulty(id);
    this.hud.setDifficulty(id, getDifficulty(id).label);
    this.resetRace();
    this.hud.showToast(`难度：${getDifficulty(id).label}`, 1200);
  }

  // ------------------------------------------------------------ 主循环

  override update(_time: number, delta: number): void {
    // 切标签页回来时 delta 可能极大，钳制以避免瞬移
    const dtMs = Math.min(delta, 50);
    const dt = dtMs / 1000;

    if (this.controls.consumePausePressed()) {
      this.director.togglePause();
      return;
    }
    // R 在暂停状态下也要能用（resetRace 会先恢复）
    if (this.controls.consumeRestartPressed()) {
      this.resetRace();
      return;
    }
    // G 开/关车库：暂停时也要能用（想换皮肤看一眼），所以放在暂停早退之前
    if (this.controls.consumeGaragePressed()) {
      if (this.hud.isGarageVisible) this.closeGarage();
      else this.openGarage();
      return;
    }
    if (this.director.paused) return;

    this.sampleInput();
    // 状态机推进倒计时；返回 true 表示这一帧刚好发车
    this.director.tick(dtMs);

    // 输入是否被接受由状态机说了算（倒计时期间锁死是 REQ-015 的硬要求）
    const allowDrive = this.director.acceptsInput;
    for (const racer of this.racers) {
      // AI 需要知道"这帧撞到了东西"，否则脱困只能靠低速判定，会晚约 900ms
      racer.ai?.drive(racer.vehicle, this.track, dtMs, racer.vehicle.input);
      const onTrack = this.track.isOnTrack(racer.vehicle.x, racer.vehicle.y);
      // 尾流（CR-06 第 2 项）：跟车吃减阻。对玩家与 AI 同时生效。
      racer.vehicle.update(dt, onTrack, allowDrive, this.draftFactorFor(racer.vehicle));
    }

    this.advanceTimers(dtMs);
    this.samplePeerStats(dtMs);

    const racing = this.director.racing;
    const elapsedMs = this.racers[0]?.timer.snapshot.elapsedMs ?? 0;
    if (racing) this.ghostRecorder?.capture(elapsedMs, this.player.x, this.player.y, this.player.heading);
    this.updateGhost(racing, elapsedMs);
    this.updateHud();
    this.drawMinimap();
  }

  /**
   * 本帧小地图上的光点（调试 / 自动化测试用）。
   *
   * 额外带上 `screenX / screenY`（光点在小地图画布内的像素位置），
   * 测试可以直接断言"换算没把点画到画布外面去"。
   */
  getMinimapDots(): (MinimapDot & { screenX: number; screenY: number })[] {
    const world = this.track.meta.world;
    const size = minimapSizeFor(world.width, world.height);
    // 复用 Minimap 的同一套投影函数，保证"测试算的"就是"实际画的"
    const projection = computeMinimapProjection(size.width, size.height, world.width, world.height);
    return this.lastMinimapDots.map((dot) => {
      const [screenX, screenY] = projectToMinimap(projection, dot.x, dot.y);
      return { ...dot, screenX, screenY };
    });
  }

  /**
   * 刷新右上角小地图。
   *
   * 小地图不属于世界坐标系（见 Minimap.ts 的说明），所以这里只负责把
   * "世界里的车"翻译成一组光点，位置换算全在 Minimap 内部完成。
   *
   * 每帧都画：4 台车 + 幽灵车一共几个点，比一次 HUD 文本更新还便宜。
   */
  private drawMinimap(): void {
    const dots: MinimapDot[] = [];

    for (const racer of this.racers) {
      if (!racer.isPlayer && !this.aiEnabled) continue;
      dots.push({
        x: racer.vehicle.x,
        y: racer.vehicle.y,
        color: racer.color,
        isPlayer: racer.isPlayer,
        finished: racer.timer.snapshot.finished,
      });
    }

    // 幽灵车：只有可见时才画（没记录 / 未出场就不该出现在小地图上）
    if (this.ghostSprite?.visible) {
      dots.push({
        x: this.ghostSprite.x,
        y: this.ghostSprite.y,
        color: TUNING.ghost.tint,
        isGhost: true,
      });
    }

    this.lastMinimapDots = dots;
    this.hud.drawMinimap(dots);
  }

  /**
   * 每帧累计自我表现数据（结算界面用）。
   *
   * 只采"过程量"：最高车速、漂移时长、撞墙次数。
   * 成绩本身的对比（有没有超越自己）由 SaveStore 的纪录算出，不需要在这里累计。
   */
  private samplePeerStats(dtMs: number): void {
    if (this.director.state !== 'racing') return;
    const me = this.racers[0];
    if (!me) return;

    this.peerStats.topSpeed = Math.max(this.peerStats.topSpeed, Math.abs(me.vehicle.speed));
    if (me.vehicle.isDrifting) this.peerStats.driftMs += dtMs;

    // 撞墙：把"从没贴墙变成贴墙"算一次，避免贴墙滑行时每帧都计数
    const blocked = me.vehicle.blocked;
    if (blocked && !this.peerStats.wasBlocked) this.peerStats.wallHits += 1;
    this.peerStats.wasBlocked = blocked;
  }

  /** 自我表现数据的快照（写进结算数据）。 */
  private peerStatsSnapshot(): RaceProgressStats {
    const p = this.peerStats;
    return {
      topSpeed: p.topSpeed,
      driftMs: p.driftMs,
      wallHits: p.wallHits,
    };
  }

  /**
   * 推进所有参赛者的计时与进度（放在物理之前读位置，读数才是本帧的）。
   *
   * ⚠️ 这里用 `track.arcNear(..., 上一帧弧长, 窗口, 本帧实际位移)` 而不是 `progressAt()` ——
   * 见 `TrackGeometry.arcNear` 的说明。三个关键点：
   *  1. **连续**：只看上一帧弧长附近，压草地/贴墙时不会掉头去报另一段路的弧长；
   *  2. **按实际位移设限**：窗口内最近点要是比"这一帧车真的走了多远"还远，
   *     那它多半落在**别的路段**上（相邻路段净距几十上百像素，而一帧只走 6~9px）；
   *  3. 不采信时改用"沿锚点前移同样的距离"，所以既不会跳变、也不会白送前进量。
   *
   * ⚠️ 第 2 点的上限必须是**实际位移**，不能图省事写成"速度上限 × dt + 容差"。
   * 踩过：某段路上弧长采样密、弧长推进快，用一个宽松的上限挡不住 ——
   * 车明明 397px/s、一帧只走 6.6px，弧长却跳了 73px，照样判「进度异常跳跃」。
   */
  private advanceTimers(dtMs: number): void {
    if (this.director.state !== 'racing') {
      for (const racer of this.racers) {
        racer.timer.rebase(this.track.arcNear(racer.vehicle.x, racer.vehicle.y, racer.lastArc).arc);
      }
      return;
    }

    for (const racer of this.racers) {
      if (!racer.isPlayer && !this.aiEnabled) continue;
      // 本帧实际移动了多远（含一点点余量，免得浮点让"正好相等"落在拒绝侧）
      // 连续弧长锚点被拒的次数（见 STUCK_REJECT_LIMIT）
      const stuck = racer.rejectStreak >= RaceScene.STUCK_REJECT_LIMIT;
      const travelled = Math.hypot(racer.vehicle.x - racer.lastX, racer.vehicle.y - racer.lastY);
      const progress = this.track.arcNear(
        racer.vehicle.x,
        racer.vehicle.y,
        racer.lastArc,
        120,
        travelled,
        racer.lastX,
        racer.lastY,
        stuck,
      );
      // 读数原地不动 = 这一帧的投影被拒（它是"物理上不可能"的）。连着被拒太多次说明
      // 锚点已经彻底跟丢了（调试瞬移、被撞飞出赛道），这时宁可接受一次大跳变 ——
      // 计时器会照常判它无效 —— 也不能让这辆车永远停在旧弧长上。
      racer.rejectStreak = progress.arc === racer.lastArc && !stuck ? racer.rejectStreak + 1 : 0;
      racer.lastArc = progress.arc;
      racer.lastX = racer.vehicle.x;
      racer.lastY = racer.vehicle.y;
      for (const lap of racer.timer.update(dtMs, progress.arc)) {
        if (racer.isPlayer) this.onLapCompleted(lap);
      }
      const snapshot = racer.timer.snapshot;
      if (snapshot.finished && racer.finishMs === null) racer.finishMs = snapshot.totalMs;
    }

    // 玩家冲线即结束本场；已经完赛的 AI 保留成绩，其余按进度排名
    if (this.racers[0]?.timer.snapshot.finished) this.finishRace();
  }

  // ------------------------------------------------------------ 输入

  private sampleInput(): void {
    this.controls.sampleInto(this.player.input);
    if (this.debugInput) {
      this.controls.injectInto(
        this.player.input,
        this.debugInput.throttle,
        this.debugInput.steer,
        this.debugDrift || this.debugInput.drift,
      );
    }
    if (this.autopilot) this.autopilot.drive(this.player, this.track, this.player.input);
  }

  // ------------------------------------------------------------ 状态机
  //
  // 状态本身由 `RaceDirector`（纯逻辑）持有，这里只保留"跃迁时要做的副作用"。
  // 这样拆的理由见 RaceDirector.ts 头部：这套逻辑以前埋在场景里，
  // 没法写单元测试，于是"倒计时期间车辆可动""暂停不冻结计时"这类 bug 反复出现。

  /**
   * 由 RaceDirector 在倒计时数字变化时回调。
   *
   * 注意这里**不**调用 `showCountdown(..., false)` 的"不重置"分支逻辑，
   * 而是由 HUD 自己决定动画 —— 状态机只负责"该显示第几个数字"。
   */
  private handleCountdownStep(label: string): void {
    this.hud.showCountdown(label, false);
  }

  /** 由 RaceDirector 在正式发车时回调：把所有参赛者的计时器归零并起跑。 */
  private handleBeginRacing(): void {
    this.hud.setDifficultyLocked(true);
    this.hud.setTrackLocked(true);

    // 过程统计从"正式发车"这一刻开始计：倒计时期间车速恒为 0，采了也没意义
    this.resetPeerStats();

    for (const racer of this.racers) {
      const arc = this.track.progressAt(racer.vehicle.x, racer.vehicle.y).arc;
      racer.timer.setReference(this.save.bestLapCheckpointsMs);
      racer.timer.start(arc);
      // 连续弧长的锚点必须与计时器**用同一套归一化**：计时器内部存的是 [0,total)，
      // 而进度查询给出的起跑点是 7531.97（闭环下等价于 0）。两边不一致的话，
      // 发车后第一帧的增量会被算成 +7531.97 → 整场判"切弯"（真踩过）。
      racer.lastArc = this.track.normalizeArc(arc);
      racer.lastX = racer.vehicle.x;
      racer.lastY = racer.vehicle.y;
      racer.rejectStreak = 0;
      racer.finishMs = null;
      racer.progressPx = 0;
    }
    this.ghostRecorder?.reset();
    // 显式落一个 t=0 的起点采样：录制必须从网格原点开始，回放才与录制同速
    this.ghostRecorder?.capture(0, this.player.x, this.player.y, this.player.heading);
    this.ghostRunner.reset(0);
    this.ghostRunner.reset(this.track.progressAt(this.player.x, this.player.y).arc);
    this.ghostRecorded = false;

    this.hud.showCountdown('GO!', true);
    this.time.delayedCall(TUNING.race.goDisplayMs, () => this.hud.hideCountdown());
  }

  /** 由 RaceDirector 在暂停状态变化时回调。 */
  private handlePausedChanged(paused: boolean): void {
    if (paused) {
      this.physics.world.pause();
      this.hud.showPause();
    } else {
      this.physics.world.resume();
      this.hud.hidePause();
    }
  }

  /**
   * 由 RaceDirector 在状态跃迁到 finished 时回调。
   *
   * 这里是**空的**：真正的结算流程由 `finishRace()` 在 `director.finish()` 返回 true
   * 之后走完（要读计时器、写存档、装幽灵车、弹结算面板，这些都需要场景的其它字段）。
   * 保留这个回调是为了让它的调用点在状态机里显式可见 —— 将来若要把结算逻辑也搬进
   * 独立的 `ResultFlow`，接线就在这里。
   */
  private handleFinished(): void {
    /* 结算主体在 finishRace() 内，见上方说明 */
  }

  /** 暂停 / 恢复。状态由 director 持有，场景只提供入口（调试接口与 Esc 都用它）。 */
  private pauseRace(): void {
    this.director.pause();
  }

  private resumeRace(): void {
    this.director.resume();
  }

  // ------------------------------------------------------------ 圈数与结算

  /**
   * 完成一圈（单程赛道 = 跑完全程）时的提示。
   *
   * 单程赛道不报"第 1 圈 xx"：它只有一个"趟"，冲线时结算面板马上就弹出来了，
   * 再说一句"第 1 圈"只会让人以为还有第 2 圈。无效成绩的提示照旧给（那种情况值得说）。
   */
  private onLapCompleted(lap: LapResult): void {
    this.syncHudBestLap();
    if (this.director.state !== 'racing') return;
    if (!lap.valid) {
      this.hud.showToast(`第 ${lap.index} 圈无效 · ${lap.invalidReason ?? '未知原因'}`, 1800);
    } else if (!this.track.isOpen && lap.index < this.track.lapCount) {
      this.hud.showToast(`第 ${lap.index} 圈 ${formatTime(lap.lapMs)}`, 1300);
    }
  }

  /**
   * 结束比赛。
   *
   * `director.finish()` 返回 false 表示"已经是 finished 了"，直接返回 ——
   * 这条守卫防的是"结算跑两遍"（会重复写存档、重复弹抽奖）。
   * 状态机那边有单元测试盯着（`tests/race-director.test.ts` 的"重复 finish 只生效一次"）。
   */
  private finishRace(): void {
    if (!this.director.finish()) return;
    this.hud.setDifficultyLocked(false);

    const racer = this.racers[0];
    racer.timer.stop();
    const snapshot = racer.timer.snapshot;
    const totalMs = snapshot.totalMs ?? snapshot.elapsedMs;
    const previousBestTotalMs = this.save.bestTotalMs;
    const lapResults = snapshot.laps;

    const bestLap = snapshot.bestLapMs;
    const bestSectorsMs =
      bestLap === null ? [] : (lapResults.find((lap) => lap.valid && lap.lapMs === bestLap)?.sectorsMs ?? []);
    const invalidReasons = [
      ...new Set(lapResults.filter((lap) => !lap.valid).map((lap) => lap.invalidReason ?? '未知原因')),
    ];
    const valid = invalidReasons.length === 0;

    const record: RunRecord = {
      at: new Date().toISOString(),
      totalMs,
      bestLapMs: bestLap,
      lapTimesMs: lapResults.map((lap) => lap.lapMs),
      sectorsMs: bestSectorsMs,
      valid,
      invalidReason: valid ? null : invalidReasons.join('；'),
    };

    // 幽灵车只在"有效 + 刷新最佳总时间"时写入，与纪录严格对应
    const ghostData = valid ? (this.ghostRecorder?.build(totalMs) ?? null) : null;
    const outcome = this.save.submit(record, valid ? racer.timer.checkpoints : null, ghostData);
    this.ghostRecorded = outcome.isNewBestTotal && valid;

    this.installGhostAfterRace();
    this.updateRanking();
    this.pushStandingsToHud();

    // 先把名次钉下来再建 result。
    // ⚠️ 顺序不能反：抽奖的触发条件之一是"夺冠"，而 `playerRank` 读的是
    // `this.ranking`，它在 `updateRanking()` 之前可能还是上一帧的旧值。
    const finalRank = this.playerRank;
    const beatPersonalBest = valid && outcome.isNewBestTotal;
    const wonRace = finalRank === 1;

    const result: RaceResult = {
      totalMs,
      bestLapMs: bestLap,
      lapResults,
      bestSectorsMs,
      deltaToPreviousBestMs: previousBestTotalMs === null ? null : totalMs - previousBestTotalMs,
      valid,
      invalidReasons,
      isNewBestTotal: outcome.isNewBestTotal,
      isNewBestLap: outcome.isNewBestLap,
      previousBestTotalMs,
      difficulty: this.difficulty,
      standings: this.buildStandings(),
      playerRank: finalRank,
      ghostRecorded: this.ghostRecorded,
      progress: this.peerStatsSnapshot(),
      trackName: this.trackLabel(this.trackId),
      // 未完赛 AI 的预计完赛时间（known-issues 第 9 条）：名次背后没有时间就没有说服力
      finishEstimatesMs: this.finishEstimates(),
      // "超越自己"= 有效成绩且刷新了本赛道最佳总时间（结算里的"新纪录"徽章）
      beatPersonalBest,
      /** 名次第 1 = 冠军。与"刷新纪录"相互独立，见 `RaceResult.wonRace`。 */
      wonRace,
      /**
       * 抽奖的触发条件：**刷新纪录 或 夺冠**（玩家要求"只要拿了冠军就能抽奖"）。
       * 以前只有前者，于是"跑出个人第二好成绩但拿了第一"时什么都没有。
       */
      lotteryEligible: beatPersonalBest || wonRace,
    };

    this.hud.setBestTotal(this.save.bestTotalMs);
    this.syncHudBestLap();
    this.hud.setDelta(null, null);
    this.hud.setLapValidity(false);
    this.hud.showResult(result, this.save.snapshot());
    this.events.emit('race-finished', result);

    // 结算动画之后再放抽奖（刷新纪录 **或** 夺冠）
    if (result.lotteryEligible) this.scheduleLottery();
  }

  /**
   * 抽奖是否开启（CR-08 收口第 1 条）。
   *
   * 发布默认**关闭**（`TUNING.lottery.enabled === false`）；`?lottery=test` 是显式的
   * 调试覆盖。刷新纪录本身不受影响 —— 关掉的只是那个随机拨奖的环节。
   */
  private lotteryEnabled(): boolean {
    return this.lotteryDebug || TUNING.lottery.enabled;
  }

  /**
   * 安排"抽奖"演出。
   *
   * 触发条件（由 `finishRace` 判断并放在 `result.lotteryEligible` 里）：
   * **刷新本赛道最佳总时间 或 拿到冠军**。后者是玩家明确要求加的 ——
   * "跑出个人第二好成绩但拿了第一"以前什么都没有，那种"赢了却没有反馈"
   * 比没有奖励更伤。
   *
   * 时机：**结算动画结束之后**。结算面板里领奖台的小人是一个个登台的，
   * 所以这里等一小段固定时长（够领奖台站齐）再弹出老虎机，
   * 而不是立刻盖在结算面板上 —— 两个动画叠在一起会互相抢注意力。
   *
   * CR-08：抽奖**发布默认关闭**，所以这里要先问开关。
   * 刷新纪录本身仍然照常记录、照常显示"新纪录" —— 关掉的只是随机拨奖那一环。
   */
  private scheduleLottery(): void {
    if (!this.lotteryEnabled()) return;
    this.hud.resetLottery();
    this.time.delayedCall(TUNING.lottery.openDelayMs, () => {
      // 场景可能在等待期间被重开（换赛道 / 按 R），这里做一次状态检查
      if (this.director.state !== 'finished') return;
      this.hud.playLottery();
    });
  }

  // ------------------------------------------------------------ 车库 / 皮肤（CR-15）
  //
  // 车库里只做两件事：换贴图、落盘。**不重建场景、不重启比赛** ——
  // 换皮肤不该把玩家正在跑的这一场作废（"选中即时生效，下一场比赛使用"）。

  /**
   * 打开车库，并**暂停比赛**。
   *
   * 不暂停的话玩家会在翻菜单时被 AI 超过 —— 而且车库是全屏覆盖层，
   * 玩家根本看不见自己被超过，只会觉得"回来就掉了一名"。
   */
  private openGarage(): void {
    if (this.hud.isGarageVisible) return;
    this.garagePausedRace = this.director.paused;
    if (!this.garagePausedRace) this.pauseRace();
    // 抽到的那款高亮一下；没有就正常显示
    this.hud.openGarage(this.lastUnlockedSkinId);
    this.lastUnlockedSkinId = null;
  }

  /**
   * 关闭车库，恢复**打开前**的暂停状态。
   *
   * 无条件 resume 是错的：玩家可能是自己按 Esc 暂停的，那样关掉车库就等于
   * 替他继续了比赛（还会顺带把暂停覆盖层收掉，表现得像"按了继续"）。
   */
  private closeGarage(): void {
    if (!this.hud.isGarageVisible) return;
    this.hud.closeGarage();
    const shouldResume = !this.garagePausedRace;
    this.garagePausedRace = false;
    if (shouldResume && this.director.paused) this.resumeRace();
  }

  /**
   * 装备一款皮肤（CR-15）。
   *
   * @returns 是否真的换了 —— 未拥有的皮肤返回 false（`SkinStore.equip` 不替玩家解锁）。
   */
  private equipSkin(id: string): boolean {
    if (!this.skins.equip(id)) return false;

    // 立刻把玩家精灵换成新贴图：车库后面就是赛道，玩家点一下就该看到变化。
    // 贴图尺寸（28×42）与物理体（圆形，半径 12）与皮肤无关，所以**不动 body** ——
    // 这也正是"皮肤不影响成绩"的一部分：换皮肤只执行 setTexture。
    this.player?.sprite.setTexture(this.playerSkinTextureKey());
    this.hud.renderGarage();
    this.hud.showToast(`已装备：${SKINS[id]?.label ?? id}`, 1200);
    return true;
  }

  /**
   * 抽奖停稳后的落点（CR-15）：中奖产出皮肤。
   *
   * 三条纪律：
   *   1. 中奖**一定**要有产出，不能只是"放了个动画"（CR-08 的原始问题）；
   *   2. 重复抽到已有的皮肤**必须**明确交代（`duplicateReward` 决定文案），
   *      静默吞掉是最容易被玩家记恨的做法；
   *   3. 产出立刻落盘（`SkinStore.unlock` 内部负责），刷新页面不丢。
   */
  private handleLotterySettled(won: boolean): void {
    if (!won) return;
    const id = pickSkinDrop(Math.random, TUNING.skins.dropTable);
    const isNew = this.skins.unlock(id);
    if (isNew) {
      this.lastUnlockedSkinId = id;
      this.hud.showToast(`获得新皮肤：${SKINS[id]?.label ?? id}`, 2200);
    } else {
      this.hud.showToast(`已拥有：${SKINS[id]?.label ?? id}（不会重复计数）`, 2200);
    }
    // 抽奖面板上的产出卡片：文案分"新获得 / 已拥有"两种，绝不留空
    this.hud.showLotterySkin(id, isNew);
    this.hud.renderGarage();
  }

  /** 完赛后把（可能刚刷新的）幽灵车装载起来，下一场就能跟着跑。 */
  private installGhostAfterRace(): void {
    const data = this.save.bestGhost;
    if (!isValidGhostData(data)) return;
    this.ghostPlayback = new GhostPlayback(data);
    if (!this.ghostSprite) {
      const start = this.track.meta.start;
      this.ghostSprite = this.add
        .sprite(start.x, start.y, ASSETS.carGhostKey)
        .setAlpha(TUNING.ghost.alpha)
        .setDepth(9)
        .setVisible(false);
    }
  }

  /** 结算界面的排行榜（委托给 `RaceStandings.toStandingEntries`）。 */
  private buildStandings(): StandingEntry[] {
    return toStandingEntries(this.ranking, this.standingsInputs(), (entry) => this.progressLabel(entry));
  }

  /**
   * 未完赛 AI 的预计完赛时间（毫秒），key = racer id。
   *
   * 给结算界面用：那里显示的是"最终排名"，但玩家冲线时其他车还在跑，
   * 名次背后没有时间就没有说服力（known-issues 第 9 条）。
   * 算不出来（样本不足）的车直接不出现在这张表里。
   */
  private finishEstimates(): Map<string, number> {
    const out = new Map<string, number>();
    const elapsedMs = this.racers[0]?.timer.snapshot.elapsedMs ?? 0;
    for (const racer of this.racers) {
      if (racer.finishMs !== null) continue;
      const snapshot = racer.timer.snapshot;
      const estimate = estimateFinishMs({
        lapsCompleted: snapshot.laps.length,
        lapArc: snapshot.lapProgress * this.track.totalLength,
        elapsedMs,
        totalLength: this.track.totalLength,
        lapCount: this.track.lapCount,
      });
      if (estimate !== null) out.set(racer.id, estimate);
    }
    return out;
  }

  /**
   * 车手配色：玩家用 RACER_COLORS.player，AI 按序号取 tints。
   *
   * 小地图光点、领奖台小人、车身 tint 三处必须用同一套颜色，
   * 玩家才能一眼对上"哪个点/哪个小人是我"。
   *
   * @param isPlayer 是否玩家
   * @param index    参赛序号（0 是玩家，AI 从 1 开始）
   */
  private static racerColor(isPlayer: boolean, index: number): number {
    if (isPlayer) return RACER_COLORS.player;
    const tints = RACER_COLORS.ai;
    const aiIndex = index > 0 ? index - 1 : 0;
    return tints[aiIndex % tints.length];
  }

  /**
   * 瞬移后重新对齐进度基准，否则一次传送会被误判成"跑完一圈"或"抄近道"。
   *
   * 只对齐**玩家自己**的计时器：调试接口瞬移的是玩家，AI 与幽灵车的位置并没有变，
   * 把它们的基准一起改掉会让 AI 的圈数与排名凭空错乱。
   */
  /**
   * 只把**玩家**的计时基准对齐到当前位置。
   *
   * 委托给 `RaceStandings.rebasePlayerOnly`（纯函数，有单测覆盖）。
   * ⚠️ 只对齐玩家是刻意的：调试接口瞬移的是玩家，AI 与幽灵车的位置并没有变，
   * 把它们的基准一起改掉会让 AI 的圈数与排名凭空错乱
   * —— 这是 `docs/known-issues.md` 第 10 条，`tests/race-standings.test.ts` 有回归。
   */
  private syncProgressBaseline(): void {
    const arc = this.track.progressAt(this.player.x, this.player.y).arc;
    // 只把玩家的计时器对齐（RaceStandings 有单测锁住"绝不碰 AI"）
    rebasePlayerOnly(
      this.racers.map((racer) => ({
        isPlayer: racer.isPlayer,
        rebase: (a: number) => racer.timer.rebase(a),
      })),
      arc,
    );
    // 连续弧长的锚点也要跟着走，否则下一次查询的窗口还停在瞬移前的位置
    const me = this.racers.find((racer) => racer.isPlayer);
    if (me) {
      me.lastArc = this.track.normalizeArc(arc);
      me.lastX = me.vehicle.x;
      me.lastY = me.vehicle.y;
      me.rejectStreak = 0;
    }
  }

  private resetRace(): void {
    // 车库挡着整个屏幕：开着它"重开"了玩家也看不见比赛，先收掉。
    // closeGarage 会按"打开前是否暂停"决定要不要恢复，这里随后还要 director.reset()，
    // 所以顺序必须是"先关车库、再 resume、最后 reset"。
    this.closeGarage();
    // 先恢复（director.reset 自己会处理暂停覆盖层），再回倒计时初始态
    this.resumeRace();

    const profile = getDifficulty(this.difficulty);
    for (const racer of this.racers) {
      const index = racer.isPlayer ? 0 : Number.parseInt(racer.id.slice(2), 10);
      const slot = this.gridSlot(index);
      racer.vehicle.placeAt(slot.x, slot.y, slot.heading);
      racer.timer.reset();
      racer.timer.setReference(this.save.bestLapCheckpointsMs);
      // profile 是只读的，换难度只能重建 driver（种子保持不变，走线风格可复现）
      racer.ai = racer.isPlayer || !this.aiEnabled ? null : new AIDriver(profile, racer.aiSeed);
      // AI 关闭时把车挪到地图角落，别挡住玩家
      if (!racer.isPlayer && !this.aiEnabled) racer.vehicle.placeAt(80, 80, 0);
      // 连续弧长的锚点跟着摆位走，否则重开后会拿旧位置当窗口中心（窗口落空 → 回落到全局扫描）
      racer.lastArc = this.track.normalizeArc(this.track.progressAt(racer.vehicle.x, racer.vehicle.y).arc);
      racer.lastX = racer.vehicle.x;
      racer.lastY = racer.vehicle.y;
      racer.rejectStreak = 0;
      racer.finishMs = null;
      racer.progressPx = 0;
    }

    this.track.resetProgressSearch();
    // 回倒计时初始态：director.reset 会一并把暂停覆盖层收掉
    this.director.reset();
    this.ghostRecorder?.reset();
    this.ghostRunner.reset(0);
    this.ghostRecorded = false;

    const cam = this.cameras.main;
    cam.stopFollow();
    cam.centerOn(this.player.x, this.player.y);
    cam.startFollow(this.player.sprite, true, TUNING.camera.lerp, TUNING.camera.lerp);

    this.hud.hideResult();
    this.hud.hideCountdown();
    // 抽奖面板是结算的后续演出，重开时必须一起收掉，否则会悬在新一场比赛上
    this.hud.resetLottery();
    this.hud.setBestTotal(this.save.bestTotalMs);
    // 把 HUD 复位成"一场新比赛该有的样子"（清掉上一场的 delta / 无效标记等残留）
    resetHudForNewRace(this.hud, this.hudContext());
    this.hud.setDifficultyLocked(false);
    this.hud.setTrackLocked(false);
    this.updateRanking();
    this.pushStandingsToHud();
  }

  /**
   * HUD 上的「最佳圈」优先显示本场最佳；本场还没有有效圈时回落到历史最佳，
   * 这样玩家始终有一个可以追的目标（规则在 RaceHudSync 里有单测）。
   */
  private syncHudBestLap(): void {
    syncHudBestLap(this.hud, this.racers[0]?.timer.snapshot.bestLapMs ?? null, this.save.bestLapMs);
  }

  // ------------------------------------------------------------ HUD

  /**
   * 每帧把状态刷进 HUD。
   *
   * 映射规则全部在 `RaceHudSync`（纯函数 + 14 条单测）：倒计时期间圈速回落上一圈、
   * 完赛后总时间定格、只有比赛中才显示 delta…… 这些以前只存在于这里的代码里，
   * 改错了不会被 CI 拦住。
   */
  private updateHud(): void {
    const racer = this.racers[0];
    if (!racer) return;
    // 名次每帧都要重算：只在 create/reset/finish 算的话，比赛途中的排名会一直是发车时的快照
    this.updateRanking();
    const snapshot = racer.timer.snapshot;
    const lastLap = snapshot.laps.length > 0 ? snapshot.laps[snapshot.laps.length - 1] : null;

    syncHudFrame(
      this.hud,
      {
        phase: this.director.state,
        speedKmh: this.player.speedKmh,
        currentLap: snapshot.currentLap,
        lapMs: snapshot.lapMs,
        lastLapMs: lastLap?.lapMs ?? null,
        elapsedMs: snapshot.elapsedMs,
        totalMs: snapshot.totalMs,
        liveDeltaMs: snapshot.liveDeltaMs,
        referenceSource: snapshot.referenceSource,
        currentLapInvalid: snapshot.currentLapInvalid,
        bestLapMs: snapshot.bestLapMs,
        onTrack: this.player.onTrack,
        drifting: this.player.isDrifting,
        driftAngle: this.player.driftAngle,
      },
      this.hudContext(),
    );
    this.pushStandingsToHud();
  }

  /** 传给 `RaceHudSync` 的静态上下文（一场比赛里不变的那些值）。 */
  private hudContext(): HudStaticContext {
    return {
      totalLaps: this.track.lapCount,
      fps: this.game.loop.actualFps,
      difficulty: this.difficulty,
      difficultyLabel: getDifficulty(this.difficulty).label,
      trackId: this.trackId,
      trackLabel: this.trackLabel(this.trackId),
      storedBestLapMs: this.save.bestLapMs,
    };
  }

  // ------------------------------------------------------------ 碰撞

  /**
   * 这台车本帧的尾流阻力倍率（CR-06 第 2 项）。
   *
   * "在前方"的判定不能只看距离 —— 并排的车距离也很近，但它在旁边不在前面。
   * 具体几何判定收在 `isInDraftZone`（纯函数 + 单测），这里只做遍历。
   *
   * 多台车同时在尾流区里时取**最强**的那一份（`Math.min`）：被两台车同时
   * 减阻不该叠乘成"阻力变成 0.72 倍"，那会变成贴车堆里的超能力。
   */
  private draftFactorFor(self: Vehicle): number {
    let best = 1;
    for (const other of this.racers) {
      if (other.vehicle === self) continue;
      if (!isInDraftZone(
        { x: self.x, y: self.y, heading: self.heading },
        { x: other.vehicle.x, y: other.vehicle.y, heading: other.vehicle.heading },
        {
          rangePx: TUNING.contact.draftRangePx,
          maxHeadingRad: TUNING.contact.draftMaxHeadingRad,
          minForwardPx: TUNING.contact.draftMinForwardPx,
        },
      )) {
        continue;
      }
      const gap = Math.hypot(other.vehicle.x - self.x, other.vehicle.y - self.y);
      const factor = draftFactor(gap, wrapAnglePi(other.vehicle.heading - self.heading), {
        rangePx: TUNING.contact.draftRangePx,
        maxHeadingRad: TUNING.contact.draftMaxHeadingRad,
        factor: TUNING.contact.draftFactor,
      });
      if (factor < best) best = factor;
    }
    return best;
  }

  /** 车与车碰撞：法向分离 + 切向摩擦传递（CR-06 第 3 项）。 */
  private readonly onVehicleCollision: Phaser.Types.Physics.Arcade.ArcadePhysicsCallback = (objectA, objectB) => {
    const spriteA = objectA as Phaser.Physics.Arcade.Sprite;
    const spriteB = objectB as Phaser.Physics.Arcade.Sprite;
    const vehicleA = spriteA.getData('vehicle') as Vehicle | undefined;
    const vehicleB = spriteB.getData('vehicle') as Vehicle | undefined;
    if (!vehicleA || !vehicleB) return;

    const bodyA = spriteA.body as Phaser.Physics.Arcade.Body;
    const bodyB = spriteB.body as Phaser.Physics.Arcade.Body;
    const impulse = computeCarContact(
      bodyA.center.x,
      bodyA.center.y,
      bodyB.center.x,
      bodyB.center.y,
      { speed: vehicleA.speed, heading: vehicleA.heading },
      { speed: vehicleB.speed, heading: vehicleB.heading },
      TUNING.vehicle.bodyRadius,
      {
        friction: TUNING.contact.friction,
        bounce: TUNING.contact.bounce,
        maxSpeedTransfer: TUNING.contact.maxSpeedTransfer,
      },
    );

    // --- 1. 切向摩擦 / 回弹：直接改纵向速度（不是 applyImpact —— 那个会额外
    //        弹开一大截，正是"一碰就飞"的来源）。
    vehicleA.speed += impulse.aSpeedDelta;
    vehicleB.speed += impulse.bSpeedDelta;

    // --- 2. 法向分离：把重叠推开，两车各一半。
    //        不这么做的话，Arcade 分离两车时会把它们瞬间弹开，并排跑就成了互殴。
    const push = separatePositions(impulse.nx, impulse.ny, impulse.overlap);
    if (push.aDx !== 0 || push.aDy !== 0) {
      vehicleA.sprite.x += push.aDx;
      vehicleA.sprite.y += push.aDy;
      bodyA.reset(vehicleA.sprite.x, vehicleA.sprite.y);
    }
    if (push.bDx !== 0 || push.bDy !== 0) {
      vehicleB.sprite.x += push.bDx;
      vehicleB.sprite.y += push.bDy;
      bodyB.reset(vehicleB.sprite.x, vehicleB.sprite.y);
    }
  };

  // ------------------------------------------------------------ 调试

  /**
   * 玩家车的贴图 + 物理配置快照（CR-15 的公平性验收用）。
   *
   * 为什么要有它：`tests/skins.test.ts` 的白名单断言只能守住"皮肤**定义**里没有数值"，
   * 守不住"集成层偷偷把 body 改了"。e2e 会在装备非默认皮肤前后各读一次这个快照，
   * 断言 `textureKey` 变了、**其余字段一字未动** —— 这是"皮肤不碰物理"最直接的机器证据。
   */
  private playerPhysics(): DebugPlayerPhysics {
    const sprite = this.player.sprite;
    const body = this.player.body;
    return {
      textureKey: sprite.texture.key,
      width: sprite.width,
      height: sprite.height,
      displayWidth: sprite.displayWidth,
      displayHeight: sprite.displayHeight,
      bodyRadius: body.radius,
      bodyOffsetX: body.offset.x,
      bodyOffsetY: body.offset.y,
      bodyWidth: body.width,
      bodyHeight: body.height,
      maxVelocityX: body.maxVelocity.x,
      maxVelocityY: body.maxVelocity.y,
      dragX: body.drag.x,
      dragY: body.drag.y,
    };
  }

  private installDebugHelpers(): void {
    this.physics.world.createDebugGraphic();
    this.physics.world.drawDebug = true;

    const points = this.track.centerlinePoints;
    const graphics = this.add.graphics().setDepth(60);
    graphics.lineStyle(1, 0x22ffcc, 0.55);
    graphics.beginPath();
    graphics.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) graphics.lineTo(points[i][0], points[i][1]);
    graphics.strokePath();
  }

  /**
   * 装配调试接口（`window.__F1RACE__`）。
   *
   * 实现整块搬去了 `RaceDebugApi.ts`（不 import Phaser，可单测）。
   * 这里只负责把场景的能力映射成那个模块声明的 `RaceDebugContext` ——
   * 有了这层显式契约，"调试接口依赖了场景什么"变成一份可读的清单，
   * 而不是散落在 175 行对象字面量里的 `this.xxx`。
   */
  private installDebugApi(): void {
    installRaceDebugApi({
      // 场景句柄：e2e 用它读 track / cameras / player.sprite
      // （见 DebugSceneHandle 的说明）。显式只交出这三样，而不是 `this`。
      scene: { track: this.track, cameras: this.cameras, player: this.player },
      director: this.director,
      // ⚠️ 会变的值一律用 getter：这个对象只在 create() 里构造一次，
      //    直接传值会把当场快照固化下来。曾经因此让"切难度"完全失效 ——
      //    changeDifficulty 读到过期的 difficulty，早退不重开，所有车停在原地。
      trackId: () => this.trackId,
      difficulty: () => this.difficulty,
      aiEnabled: () => this.aiEnabled,
      autopilot: () => this.autopilot,
      debugInput: () => this.debugInput,
      peerStatsSnapshot: () => this.peerStatsSnapshot(),
      playerRank: () => this.playerRank,
      ranking: () => this.ranking,
      racers: () => this.racers,
      track: {
        // 只交出 e2e 真正要用的几样（见 RaceDebugContext.track 的说明）。
        // `open` / `laps` 是赛道拓扑（CR-16）：e2e 靠它断言"这张图是单程 1 趟"。
        totalLength: this.track.totalLength,
        open: this.track.isOpen,
        laps: this.track.lapCount,
        isOnTrack: (x: number, y: number) => this.track.isOnTrack(x, y),
        progressAt: (x: number, y: number) => this.track.progressAt(x, y),
        pointAtArc: (arc: number) => this.track.pointAtArc(arc),
      },
      save: this.save,
      ghostSprite: () => this.ghostSprite,
      ghostPlayback: () => this.ghostPlayback,
      ghostGapMs: () => this.ghostGapMs(),
      ghostProgressPx: () => this.ghostRunner.progress,
      ghostRecorded: () => this.ghostRecorded,
      hud: this.hud,
      // --- 车辆皮肤（CR-15）：全部用 getter / 方法，不做值快照
      skins: () => this.skins,
      playerPhysics: () => this.playerPhysics(),
      lotteryEnabled: () => this.lotteryEnabled(),
      lotteryDebugOverride: () => this.lotteryDebug,
      garageVisible: () => this.hud.isGarageVisible,
      openGarage: () => this.openGarage(),
      closeGarage: () => this.closeGarage(),
      equipSkin: (id) => this.equipSkin(id),
      rendererType: this.game.renderer.type,
      fps: () => this.game.loop.actualFps,
      trackLabel: (id) => this.trackLabel(id),
      getMinimapDots: () => this.getMinimapDots(),
      changeDifficulty: (id) => this.changeDifficulty(id),
      changeTrack: (id) => this.changeTrack(id),
      resetRace: () => this.resetRace(),
      pauseRace: () => this.pauseRace(),
      resumeRace: () => this.resumeRace(),
      syncProgressBaseline: () => this.syncProgressBaseline(),
      centerCameraOn: (x, y) => this.cameras.main.centerOn(x, y),
      setDebugInput: (input) => {
        this.debugInput = input;
      },
      setDebugDrift: (enabled) => {
        this.debugDrift = enabled;
      },
      setAutopilot: (enabled) => {
        this.autopilot = enabled ? new AutoPilot() : null;
      },
      setAiEnabled: (enabled) => {
        if (this.aiEnabled === enabled) return;
        this.aiEnabled = enabled;
        this.resetRace();
      },
    });
  }
}

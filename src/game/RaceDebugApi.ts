/**
 * RaceDebugApi.ts
 * `window.__F1RACE__` 调试 / 自动化验收接口（**不 import Phaser**）。
 *
 * 从 `RaceScene.installDebugApi()` 整块搬出来的。搬它的理由不是"让 RaceScene 变短"
 * 那种数字游戏，而是：
 *
 *  1. 它原本是场景里一个 190 行的巨型对象字面量，中间塞着 `getState()` 那个
 *     100 多行的返回语句 —— 场景的**真实结构被它淹没了**，读代码时很难看出
 *     "这个类是装配 + 每帧调度"。
 *  2. 它引用了场景 29 个成员，是场景"什么都能碰"的最大来源。
 *     收成一个 `RaceDebugContext` 接口之后，"调试接口到底依赖什么"变成可读的契约，
 *     而不是散落在 190 行里的 `this.xxx`。
 *
 * 它是**验收体系的地基**：117 项 e2e 里有一大半靠这里的 `cheatTeleport` /
 * `setDifficulty` / `getMinimapDots` / `place` 来构造场景，所以这个文件
 * 用注释标清了每个方法"为什么存在"，改动前先想清楚会不会让某条验收失去手段。
 */

import { GAME_VERSION, MILESTONE } from './constants';
import { getDifficulty } from './Difficulty';
import type { DriveInput } from './InputController';
import type { LapTimerSnapshot } from './LapTimer';
import type { MinimapDot } from './Minimap';
import type { SaveStore } from './SaveStore';
import type { SkinStore } from './SkinStore';
import type { Track } from './Track';
import type { DifficultyId } from './types';

/**
 * `window.__F1RACE__.scene` 暴露的东西。
 *
 * **必须保留 `scene` 这个字段**：e2e 有 10 处直接读
 * `__F1RACE__.scene.track.totalLength` / `.scene.cameras.main` / `.scene.player.sprite`
 * （最后那个用来验"主角保持在屏幕中心"）。
 * 抽这个模块时我一度把它删了 —— 结果 e2e 当场抛
 * `Cannot read properties of undefined (reading 'sprite')`，整条验收链断掉。
 *
 * 类型只列 e2e 真正用到的三样，而不是整个 `RaceScene`：
 * 既避免 `RaceScene ↔ RaceDebugApi` 的循环类型引用，
 * 也把"验收依赖了场景什么"限制在最小面。
 */
export interface DebugSceneHandle {
  readonly track: Track;
  readonly cameras: { readonly main: Phaser.Cameras.Scene2D.Camera };
  /** 玩家车的精灵（e2e 用它验镜头跟随）。 */
  readonly player: { readonly sprite: { x: number; y: number } };
}

/** 状态机（只需要这几个只读量与两个动作）。 */
export interface DebugDirector {
  readonly state: 'countdown' | 'racing' | 'finished';
  readonly paused: boolean;
  beginRacing(): void;
}

/**
 * 参赛者的车辆在调试接口里的投影。
 *
 * 这里把调试接口**需要读的每个量**都显式列出来，而不是用
 * `as unknown as {...}` 去绕类型 —— 那样等于放弃类型检查，
 * 字段改名后会在运行时静默变成 `undefined`（e2e 断言随之失效但不报错）。
 * 列入接口后，字段一旦不匹配，`tsc` 立刻报错。
 */
export interface DebugVehicle {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly speed: number;
  readonly speedKmh: number;
  readonly surfaceFactor: number;
  readonly driftAngle: number;
  readonly isDrifting: boolean;
  readonly lateral: number;
  readonly sprite: { x: number; y: number };
  placeAt(x: number, y: number, heading: number, speed?: number): void;
}

/** 计时器在调试接口里的投影（直接用真实的快照类型，避免影子类型漂移）。 */
export interface DebugTimer {
  readonly snapshot: LapTimerSnapshot;
  /** 设定参考圈（清存档时置 null）。 */
  setReference(checkpointsMs: number[] | null): void;
  /**
   * 把进度基准对齐到指定弧长。
   *
   * `cheatTeleport` 需要它来**人为制造**一次进度跳跃（先对齐、再把基准推回去），
   * 否则连续弧长查询会把"物理上没动却报出大跳变"当成投影错误拒掉。
   * 见 `RaceDebugApi.cheatTeleport` 的说明。
   */
  rebase(arc: number): void;
}

/** 一台参赛车在调试接口里的投影。 */
export interface DebugRacer {
  readonly id: string;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly color: number;
  readonly finishMs: number | null;
  readonly progressPx: number;
  readonly vehicle: DebugVehicle;
  readonly ai: { readonly profile: { speedCapRatio: number }; readonly isRecovering: boolean } | null;
  readonly timer: DebugTimer;
}

/**
 * 玩家车辆的物理配置（CR-15 的公平性验收用）。
 *
 * "皮肤不影响成绩"这条验收有两个层次：
 *   1. **数据层**：`SkinDefinition` 不含任何数值（`tests/skins.test.ts` 的白名单断言守着）；
 *   2. **集成层**：换皮肤之后，玩家车的贴图变了，但**物理配置一个字节都没变**。
 *
 * 这个快照就是第 2 层的机器证据 —— e2e 会在换皮肤前后各读一次并做深比较。
 * 曾经有过"换贴图顺手把 body 尺寸也改了"这类事故（贴图尺寸不同就会），
 * 只靠"跑两圈时间差不多"是抓不住的。
 */
export interface DebugPlayerPhysics {
  /** 当前贴图 key（换皮肤时**应当**变化）。 */
  readonly textureKey: string;
  readonly width: number;
  readonly height: number;
  /** 显示尺寸（缩放后的实际宽高，物理与视觉都以它为准）。 */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Arcade body 的圆形半径。 */
  readonly bodyRadius: number;
  readonly bodyOffsetX: number;
  readonly bodyOffsetY: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly maxVelocityX: number;
  readonly maxVelocityY: number;
  readonly dragX: number;
  readonly dragY: number;
}

/** 皮肤车库状态在调试接口里的投影（CR-15）。 */
export interface DebugSkins {
  readonly owned: string[];
  readonly equipped: string;
  readonly isPersistent: boolean;
  readonly garageVisible: boolean;
}

/** 排名条目。 */
export interface DebugRankingEntry {
  readonly id: string;
  readonly rank: number;
  readonly lapsCompleted: number;
  readonly lapArc: number;
  readonly totalProgressPx: number;
  readonly finished: boolean;
  readonly finishMs: number | null;
  readonly isPlayer: boolean;
}

/**
 * 调试接口需要的场景能力。
 *
 * ⚠️ **所有会变的值都必须是 getter，不能是直接传值。**
 *
 * 这个接口是在 `RaceScene.create()` 里构造一次的，而 `ctx` 是个普通对象字面量 ——
 * 如果写成 `difficulty: this.difficulty`，那个值在构造瞬间就被**拷贝**了，
 * 之后场景改了难度，`ctx.difficulty` 还是老值。
 *
 * 这个坑真的踩了：`changeDifficulty` 拿到的是过期的 `ctx.difficulty`，
 * 于是 `if (this.difficulty === id && ...) return;` 永远成立、直接早退，
 * 比赛不重开、AI 也不动 —— 表现成"切难度后所有车都停在原地"，
 * 而类型检查完全通过（`readonly` 反而让"传了个死值"看起来天经地义）。
 *
 * 只有 `track` / `save` / `hud` / `scene` 这几个**对象引用**可以直接传：
 * 对象本身不换，字段变化能看见。
 */
export interface RaceDebugContext {
  // --- 只读状态（全部用 getter 读当前值）
  readonly director: DebugDirector;
  readonly trackId: () => string;
  readonly difficulty: () => DifficultyId;
  readonly aiEnabled: () => boolean;
  readonly autopilot: () => unknown;
  readonly debugInput: () => DriveInput | null;
  readonly peerStatsSnapshot: () => { topSpeed: number; driftMs: number; wallHits: number };
  readonly playerRank: () => number;
  readonly ranking: () => readonly DebugRankingEntry[];
  readonly racers: () => readonly DebugRacer[];
  readonly track: {
    readonly totalLength: number;
    /** 是否是单程赛道（点对点）。见 `TrackMeta.open`。 */
    readonly open: boolean;
    /** 比赛圈数（由地图元数据决定）。 */
    readonly laps: number;
    isOnTrack(x: number, y: number): boolean;
    progressAt(x: number, y: number): { arc: number; tangent: number };
    pointAtArc(arc: number): { x: number; y: number; tangent: number };
  };
  readonly save: SaveStore;
  // --- 幽灵车
  readonly ghostSprite: () => { readonly x: number; readonly y: number; readonly visible: boolean } | null;
  readonly ghostPlayback: () => { sampleAt(ms: number): { x: number; y: number } | null } | null;
  readonly ghostGapMs: () => number | null;
  readonly ghostProgressPx: () => number;
  readonly ghostRecorded: () => boolean;
  // --- HUD / 渲染
  readonly hud: {
    readonly isResultVisible: boolean;
    readonly isPauseVisible: boolean;
    readonly isLotteryVisible: boolean;
    readonly isLotterySettled: boolean;
    readonly lotteryOutcome: boolean | null;
    /** 抽奖中奖产出的文案（CR-15；未显示时为空串）。 */
    readonly lotterySkinText: string;
    /** 当前生效的中奖率（CR-08 验收：发布默认不得是 0.99）。 */
    readonly lotteryWinRate: number;
    readonly podiumRootElement: { querySelectorAll(sel: string): ArrayLike<{ dataset: Record<string, string | undefined> }>; querySelector(sel: string): unknown };
    playLottery(): void;
    closeLottery(): void;
    showLotterySkin(id: string, isNew: boolean): void;
    hideLotterySkin(): void;
    setLotteryWinRate(winRate: number): void;
    setBestTotal(ms: number | null): void;
    setBestLap(ms: number | null): void;
    /** 切换"圈数 / 进度"文案（单程赛道用，CR-16）。 */
    setLapMode(open: boolean): void;
    renderGarage(): void;
  };
  readonly rendererType: number;
  readonly fps: () => number;
  /** 场景句柄（e2e 要用 track / cameras / player，见 `DebugSceneHandle`）。 */
  readonly scene: DebugSceneHandle;
  // --- 抽奖开关（CR-08）
  /** 抽奖是否开启（发布开关 + 调试覆盖）。 */
  readonly lotteryEnabled: () => boolean;
  /** 是否处于 `?lottery=test` 调试覆盖。 */
  readonly lotteryDebugOverride: () => boolean;
  // --- 车辆皮肤（CR-15）
  readonly skins: () => SkinStore;
  readonly playerPhysics: () => DebugPlayerPhysics;
  readonly garageVisible: () => boolean;
  readonly openGarage: () => void;
  readonly closeGarage: () => void;
  readonly equipSkin: (id: string) => boolean;
  // --- 动作
  readonly trackLabel: (id: string) => string;
  readonly getMinimapDots: () => (MinimapDot & { screenX: number; screenY: number })[];
  readonly changeDifficulty: (id: DifficultyId) => void;
  readonly changeTrack: (id: string) => void;
  readonly resetRace: () => void;
  readonly pauseRace: () => void;
  readonly resumeRace: () => void;
  readonly syncProgressBaseline: () => void;
  readonly centerCameraOn: (x: number, y: number) => void;
  readonly setDebugInput: (input: DriveInput | null) => void;
  readonly setDebugDrift: (enabled: boolean) => void;
  readonly setAutopilot: (enabled: boolean) => void;
  readonly setAiEnabled: (enabled: boolean) => void;
}

/** 暴露给自动化测试 / 调试的接口（window.__F1RACE__）。 */
export interface F1RaceDebugApi {
  version: string;
  milestone: string;
  ready: boolean;
  /**
   * 场景句柄（e2e 用它读赛道几何与相机）。
   *
   * 保留它是**验收体系的要求**，不是调试便利 —— 见 `DebugSceneHandle` 的说明。
   */
  scene: DebugSceneHandle;
  getState: () => Record<string, unknown>;
  setInput: (throttle: number, steer: number) => void;
  setDrift: (enabled: boolean) => void;
  clearInput: () => void;
  setAutopilot: (enabled: boolean) => void;
  setDifficulty: (id: DifficultyId) => void;
  setTrack: (id: string) => void;
  setAiEnabled: (enabled: boolean) => void;
  teleportToProgress: (t: number) => void;
  /** 按世界坐标摆车（可选朝向 / 初速），用于构造碰撞等场景。 */
  place: (x: number, y: number, heading?: number, speed?: number) => void;
  /** 故意不重算进度基准的瞬移：模拟"抄近道"，用于验证无效圈判定。 */
  cheatTeleport: (t: number) => void;
  skipCountdown: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  clearSave: () => void;
  openLottery: () => void;
  closeLottery: () => void;
  getMinimapDots: () => (MinimapDot & { screenX: number; screenY: number })[];
  /** 车库 / 皮肤（CR-15）。 */
  getSkins: () => DebugSkins;
  getPlayerPhysics: () => DebugPlayerPhysics;
  /** 装备一款皮肤（未拥有则不生效，返回 false）。 */
  equipSkin: (id: string) => boolean;
  openGarage: () => void;
  closeGarage: () => void;
}

/**
 * 构造调试接口并挂到 `window.__F1RACE__`。
 *
 * @param ctx 场景提供的能力（见 `RaceDebugContext`）
 * @returns 挂上去的那个对象，方便调用方留引用（也便于测试）
 */
export function installRaceDebugApi(ctx: RaceDebugContext): F1RaceDebugApi {
  const api: F1RaceDebugApi = {
    version: GAME_VERSION,
    milestone: MILESTONE,
    ready: true,
    // 必须暴露 scene：e2e 有 10 处直接读 __F1RACE__.scene.track / .cameras.main
    scene: ctx.scene,

    /**
     * 一次性导出全部可观测状态。
     *
     * 设计约定：**字段是"拍平"的**（玩家位置直接挂顶层，排名单独放 `racers`）。
     * 这样 e2e 里读一条断言不用写 `state().players[0].vehicle.x` 这种长链，
     * 也让"哪条断言依赖哪个字段"一目了然。
     */
    getState: () => {
      const racer = ctx.racers()[0];
      const snapshot = racer.timer.snapshot;
      const ghost = ctx.save.bestGhost;
      const pose = ctx.ghostPlayback() ? ctx.ghostPlayback()!.sampleAt(snapshot.elapsedMs) : null;
      const laps = snapshot.laps;
      const trackId = ctx.trackId();

      return {
        state: ctx.director.state,
        paused: ctx.director.paused,
        lap: snapshot.currentLap,
        lapsCompleted: laps.length,
        raceTimeMs: snapshot.elapsedMs,
        lapTimeMs: snapshot.lapMs,
        lapProgress: snapshot.lapProgress,
        progressT: snapshot.lapProgress,
        totalMs: snapshot.totalMs,
        bestLapMs: snapshot.bestLapMs,
        lapTimesMs: laps.map((lap) => lap.lapMs),
        lapResults: laps,
        bestSectorsMs: snapshot.bestSectorsMs,
        liveDeltaMs: snapshot.liveDeltaMs,
        referenceSource: snapshot.referenceSource,
        currentLapInvalid: snapshot.currentLapInvalid,
        currentLapInvalidReason: snapshot.currentLapInvalidReason,
        // --- M3 漂移
        driftAngle: racer.vehicle.driftAngle,
        isDrifting: racer.vehicle.isDrifting,
        lateral: racer.vehicle.lateral,
        // --- M5 难度 / AI / 排名
        trackId,
        trackName: ctx.trackLabel(trackId),
        difficulty: ctx.difficulty(),
        difficultyLabel: getDifficulty(ctx.difficulty()).label,
        aiCount: ctx.racers().length - 1,
        aiEnabled: ctx.aiEnabled(),
        playerRank: ctx.playerRank(),
        racers: ctx.ranking().map((entry) => {
          const item = ctx.racers().find((r) => r.id === entry.id);
          return {
            id: entry.id,
            name: item?.name ?? entry.id,
            isPlayer: entry.isPlayer,
            rank: entry.rank,
            lapsCompleted: entry.lapsCompleted,
            lapArc: entry.lapArc,
            progressPx: entry.totalProgressPx,
            finished: entry.finished,
            finishMs: entry.finishMs,
            speed: item?.vehicle.speed ?? 0,
            x: item?.vehicle.x ?? 0,
            y: item?.vehicle.y ?? 0,
            heading: item?.vehicle.heading ?? 0,
            speedCapRatio: item?.ai ? item.ai.profile.speedCapRatio : 1,
            isRecovering: item?.ai ? item.ai.isRecovering : false,
          };
        }),
        // --- M4 幽灵车
        ghost: {
          available: ghost !== null,
          samples: ghost ? ghost.frames.length / 3 : 0,
          totalMs: ghost ? ghost.totalMs : null,
          visible: ctx.ghostSprite()?.visible ?? false,
          // 幽灵车没有物理体（REQ-018），这里恒为 false；
          // 保留字段是因为 e2e 有一条断言专门验它 —— 删字段会让那条断言失去手段。
          hasBody: false,
          x: pose ? pose.x : null,
          y: pose ? pose.y : null,
          gapMs: ctx.ghostPlayback() ? ctx.ghostGapMs() : null,
          progressPx: ctx.ghostProgressPx(),
        },
        ghostRecorded: ctx.ghostRecorded(),
        // --- 车辆 / 环境
        speed: racer.vehicle.speed,
        speedKmh: racer.vehicle.speedKmh,
        x: racer.vehicle.x,
        y: racer.vehicle.y,
        heading: racer.vehicle.heading,
        onTrack: ctx.track.isOnTrack(racer.vehicle.x, racer.vehicle.y),
        surfaceFactor: racer.vehicle.surfaceFactor,
        fps: ctx.fps(),
        // --- 存档
        bestTotalMs: ctx.save.bestTotalMs,
        storedBestLapMs: ctx.save.bestLapMs,
        storedBestSectorsMs: ctx.save.bestSectorsMs,
        storedCheckpoints: ctx.save.bestLapCheckpointsMs ? ctx.save.bestLapCheckpointsMs.length : 0,
        history: ctx.save.history,
        historyLength: ctx.save.history.length,
        migratedFromVersion: ctx.save.migratedFromVersion,
        recordsResetForRuleset: ctx.save.recordsResetForRuleset,
        saveVersion: ctx.save.snapshot().version,
        persistent: ctx.save.isPersistent,
        autopilot: ctx.autopilot() !== null,
        resultVisible: ctx.hud.isResultVisible,
        pauseVisible: ctx.hud.isPauseVisible,
        // --- 结算：领奖台 / 过程数据 / 抽奖
        progressStats: ctx.peerStatsSnapshot(),
        podiumRanks: Array.from(ctx.hud.podiumRootElement.querySelectorAll('.podium-slot')).map((el) =>
          Number(el.dataset['rank']),
        ),
        championAnimating: ctx.hud.podiumRootElement.querySelector('.podium-figure.champion') !== null,
        lottery: {
          visible: ctx.hud.isLotteryVisible,
          settled: ctx.hud.isLotterySettled,
          won: ctx.hud.lotteryOutcome,
          /**
           * 中奖产出的皮肤文案（CR-15）。
           *
           * e2e 靠它断言"重复抽到已有皮肤时给出了明确交代，而不是静默吞掉"——
           * 这是 CR-15 验收标准里最容易做成假通过的一条。
           */
          skin: ctx.hud.lotterySkinText,
        },
        // --- 车辆皮肤（CR-15）：抽奖产出 / 车库 / 是否落盘
        skins: {
          owned: [...ctx.skins().snapshot.owned],
          equipped: ctx.skins().equipped,
          isPersistent: ctx.skins().isPersistent,
          garageVisible: ctx.garageVisible(),
        },
        /**
         * 抽奖的**生效**配置（CR-08 验收用）。
         *
         * `enabled` 是发布开关（默认 false），`winRate` 是当前真正用的概率
         * （`?lottery=test` 会把它提成 `TUNING.lottery.testWinRate`）。
         * e2e 靠它断言"发布默认值不是 0.99"以及"调试覆盖确实生效"。
         */
        lotteryConfig: {
          enabled: ctx.lotteryEnabled(),
          debugOverride: ctx.lotteryDebugOverride(),
          winRate: ctx.hud.lotteryWinRate,
        },
        playerTexture: ctx.playerPhysics().textureKey,
        /** 赛道拓扑与圈数（CR-16）：单程赛道跑完一趟即完赛。 */
        trackOpen: ctx.track.open === true,
        trackLaps: ctx.track.laps,
        trackLength: ctx.track.totalLength,
        renderer: ctx.rendererType,
      };
    },

    // --- 输入注入（e2e 用它替代真实键盘，保证可复现）
    setInput: (throttle: number, steer: number) => {
      const input = ctx.debugInput() ?? { throttle: 0, steer: 0, drift: false };
      input.throttle = throttle;
      input.steer = steer;
      ctx.setDebugInput(input);
    },
    setDrift: (enabled: boolean) => ctx.setDebugDrift(enabled),
    clearInput: () => {
      ctx.setDebugInput(null);
      ctx.setDebugDrift(false);
    },
    setAutopilot: (enabled: boolean) => ctx.setAutopilot(enabled),
    setDifficulty: (id: DifficultyId) => ctx.changeDifficulty(id),
    setTrack: (id: string) => ctx.changeTrack(id),
    setAiEnabled: (enabled: boolean) => ctx.setAiEnabled(enabled),

    // --- 瞬移 / 摆位（e2e 用它构造碰撞、抄近道等场景）
    teleportToProgress: (t: number) => {
      const sample = ctx.track.pointAtArc(t * ctx.track.totalLength);
      ctx.racers()[0].vehicle.placeAt(sample.x, sample.y, sample.tangent);
      ctx.centerCameraOn(sample.x, sample.y);
      ctx.syncProgressBaseline();
    },
    place: (x: number, y: number, heading?: number, speed?: number) => {
      const progress = ctx.track.progressAt(x, y);
      ctx.racers()[0].vehicle.placeAt(x, y, heading ?? progress.tangent, speed ?? 0);
      ctx.centerCameraOn(x, y);
      ctx.syncProgressBaseline();
    },
    /**
     * 瞬移到进度 t 处，并**故意不修进度基准** —— 模拟"抄近道"造成的进度跳跃。
     *
     * ⚠️ 实现上必须**先对齐、再人为把基准推回去**，不能只 `place()` 了事。
     * 因为每帧计时现在走的是连续弧长查询（`Track.arcNear`）：车"物理上没动"
     * 却被报出一个几千像素的弧长跳变，会被它判定为投影错误而拒绝
     * —— 于是"抄近道"反而什么都不发生（e2e 一度卡在这里：laps 恒为 0）。
     *
     * 拆成两步之后两边都成立：
     *   1. `syncProgressBaseline()`：车/锚点/计时器基准三者一致（**物理上自洽**）；
     *   2. 再把计时器基准往回挪一个跳变量 —— 于是它下一帧看到的正是
     *      "车向前跳了 jumpPx"，照常判「切弯：赛道进度异常跳跃」。
     */
    cheatTeleport: (t: number) => {
      const sample = ctx.track.pointAtArc(t * ctx.track.totalLength);
      const racer = ctx.racers()[0];
      const before = racer.timer.snapshot.lapProgress * ctx.track.totalLength;
      racer.vehicle.placeAt(sample.x, sample.y, sample.tangent);
      ctx.centerCameraOn(sample.x, sample.y);
      ctx.syncProgressBaseline();
      const after = racer.timer.snapshot.lapProgress * ctx.track.totalLength;
      // 把基准推回去：下一帧的增量就变成整整这一跳（闭环取模由 LapTimer 自己处理）
      racer.timer.rebase(before - (after - before));
    },
    skipCountdown: () => ctx.director.beginRacing(),
    pause: () => ctx.pauseRace(),
    resume: () => ctx.resumeRace(),
    restart: () => ctx.resetRace(),
    clearSave: () => {
      ctx.save.clear();
      for (const racer of ctx.racers()) racer.timer.setReference(null);
      ctx.hud.setBestTotal(null);
      ctx.hud.setBestLap(null);
    },
    openLottery: () => ctx.hud.playLottery(),
    closeLottery: () => ctx.hud.closeLottery(),
    getMinimapDots: () => ctx.getMinimapDots(),

    // --- CR-15 车库 / 皮肤
    getSkins: () => ({
      owned: [...ctx.skins().snapshot.owned],
      equipped: ctx.skins().equipped,
      isPersistent: ctx.skins().isPersistent,
      garageVisible: ctx.garageVisible(),
    }),
    /**
     * 玩家车的贴图 + 物理配置快照。
     *
     * 换了皮肤时 `textureKey` 必须变，**其余字段必须一模一样** ——
     * "皮肤不影响成绩"这条验收就是靠这个深比较落地的（见 `DebugPlayerPhysics`）。
     */
    getPlayerPhysics: () => ctx.playerPhysics(),
    equipSkin: (id: string) => ctx.equipSkin(id),
    openGarage: () => ctx.openGarage(),
    closeGarage: () => ctx.closeGarage(),
  };

  (window as unknown as Record<string, unknown>)['__F1RACE__'] = api;
  return api;
}

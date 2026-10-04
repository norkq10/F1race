/**
 * RaceHudSync.ts
 * 每帧把比赛状态刷进 HUD（**不 import Phaser**，可用假 HUD 做单测）。
 *
 * 抽取理由：这块逻辑以前散在 `RaceScene.updateHud()` / `syncHudBestLap()` /
 * `syncGhostHud()` 里，直接调 HUD 的十几个 setter。它本身是纯映射
 * （"状态 → 显示什么"），却因为长在场景里而完全没有测试 ——
 * 于是"最佳圈优先显示本场最佳、没有有效圈时回落到历史最佳"这种规则
 * 只能靠读代码确认。
 *
 * 现在 HUD 被收成一个窄接口 `HudSurface`：本模块只声明"我需要哪些 setter"，
 * 真实的 `Hud` 类满足它，测试里也可以塞一个只记录调用的假对象。
 */

import type { DifficultyId } from './types';

/**
 * 本模块用到的 HUD 能力（`Hud` 类天然满足）。
 *
 * 刻意只列用到的那些 —— 接口越窄，测试里的假对象越好写，
 * 也越不容易在重构时被迫跟着改。
 */
export interface HudSurface {
  setSpeed(kmh: number): void;
  setLap(lap: number, total: number): void;
  setLapTime(ms: number): void;
  setTotalTime(ms: number): void;
  setSurface(onTrack: boolean): void;
  setFps(fps: number): void;
  setDelta(ms: number | null, source: 'session' | 'history' | null): void;
  setLapValidity(invalid: boolean): void;
  setDrift(drifting: boolean, angle: number): void;
  setBestLap(ms: number | null): void;
  setGhostStatus(gapMs: number | null, available: boolean): void;
  setDifficulty(id: DifficultyId, label: string): void;
  setTrack(id: string, label: string): void;
}

/** 每帧同步所需的最小数据（由场景把 LapTimer 读数拍平后传进来）。 */
export interface HudFrame {
  /** 比赛阶段。 */
  phase: 'countdown' | 'racing' | 'finished';
  /** 玩家车速（km/h）。 */
  speedKmh: number;
  /** 当前圈号（1 基）。 */
  currentLap: number;
  /** 当前圈已用时。 */
  lapMs: number;
  /** 上一圈用时（倒计时期间没有当前圈，用它兜底显示）。 */
  lastLapMs: number | null;
  /** 本场总用时。 */
  elapsedMs: number;
  /** 完赛总时间；未完赛为 null。 */
  totalMs: number | null;
  /** 与参考圈的实时差值。 */
  liveDeltaMs: number | null;
  /** 实时差值的参考来源。 */
  referenceSource: 'session' | 'history' | null;
  /** 本圈是否已判定无效。 */
  currentLapInvalid: boolean;
  /** 本场最佳圈；本场还没有有效圈时为 null。 */
  bestLapMs: number | null;
  /** 是否在赛道上（决定"赛道 / 草地"与减速提示）。 */
  onTrack: boolean;
  /** 是否正在漂移。 */
  drifting: boolean;
  /** 漂移角（弧度）。 */
  driftAngle: number;
}

export interface HudStaticContext {
  totalLaps: number;
  fps: number;
  difficulty: DifficultyId;
  difficultyLabel: string;
  trackId: string;
  trackLabel: string;
  /** 历史最佳圈（存档里的）。 */
  storedBestLapMs: number | null;
}

/**
 * 同步每帧变化的读数。
 *
 * 两个容易搞错的地方，都在这里集中处理：
 *  1. **倒计时期间的圈速显示**：此时 `lapMs` 恒为 0，显示 0 会让玩家以为计时坏了；
 *     所以回落到上一圈用时（第一圈则显示 0，本来也没跑过）。
 *  2. **完赛后的总时间**：要用 `totalMs`（各圈之和），而不是还在走的 `elapsedMs`。
 */
export function syncHudFrame(hud: HudSurface, frame: HudFrame, ctx: HudStaticContext): void {
  const racing = frame.phase === 'racing';
  const finished = frame.phase === 'finished';

  hud.setSpeed(frame.speedKmh);
  hud.setLap(frame.currentLap, ctx.totalLaps);
  hud.setLapTime(racing ? frame.lapMs : (frame.lastLapMs ?? 0));
  hud.setTotalTime(finished ? (frame.totalMs ?? frame.elapsedMs) : frame.elapsedMs);
  hud.setSurface(frame.onTrack);
  hud.setFps(ctx.fps);
  hud.setDelta(racing ? frame.liveDeltaMs : null, racing ? frame.referenceSource : null);
  hud.setLapValidity(racing && frame.currentLapInvalid);
  hud.setDrift(frame.drifting, frame.driftAngle);
}

/**
 * 同步「最佳圈」。
 *
 * 规则（曾经只写在注释里，现在有测试）：**本场最佳优先，没有则回落到历史最佳**，
 * 这样玩家始终有一个可追的目标，而不是看到 `--:--.---`。
 */
export function syncHudBestLap(hud: HudSurface, bestLapMs: number | null, storedBestLapMs: number | null): void {
  hud.setBestLap(bestLapMs ?? storedBestLapMs);
}

/** 同步幽灵车的时间差与"是否可用"。 */
export function syncHudGhost(hud: HudSurface, gapMs: number | null, available: boolean): void {
  hud.setGhostStatus(gapMs, available);
}

/**
 * 重开比赛时把 HUD 复位成"一场新比赛该有的样子"。
 *
 * 单独抽出来是因为它漏一项就会留下上一场的残影（例如上一场的 delta 或
 * "本圈无效"标记还挂在屏幕上）—— 这类 bug 一眼可见但不好测，
 * 集中在一处至少能让人对着清单核对。
 */
export function resetHudForNewRace(hud: HudSurface, ctx: HudStaticContext): void {
  hud.setDifficulty(ctx.difficulty, ctx.difficultyLabel);
  hud.setTrack(ctx.trackId, ctx.trackLabel);
  hud.setLap(1, ctx.totalLaps);
  hud.setLapTime(0);
  hud.setTotalTime(0);
  hud.setDelta(null, null);
  hud.setLapValidity(false);
  hud.setDrift(false, 0);
  hud.setSpeed(0);
  hud.setGhostStatus(null, false);
  hud.setBestLap(ctx.storedBestLapMs);
}

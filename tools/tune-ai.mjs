/**
 * tools\tune-ai.mjs
 * AI 难度调参台：在**真物理 + 真赛道**上跑指定的难度档，输出完赛时间 / 贴墙 / 脱困 / 漂移帧数。
 *
 * 为什么要有它：`TUNING.difficulty` 里那几个数（speedCapRatio / corneringGrip /
 * lookAhead*）互相牵制 —— 单纯把速度上限调高，AI 会在急弯撞得更狠，
 * 圈速反而**变慢**（track4 上实测：normal 58s < hard 67s，hard 是最慢的）。
 * 所以调难度不能靠推理，只能真跑。
 *
 * 用法：
 *   node --import ./tools/ts-register.mjs tools/tune-ai.mjs                     # 全部赛道 × 全部档位
 *   node --import ./tools/ts-register.mjs tools/tune-ai.mjs track4              # 指定赛道
 *   node --import ./tools/ts-register.mjs tools/tune-ai.mjs track4 --sweep      # 扫参数
 *
 * 闭环赛道按 `laps` 圈跑完，单程赛道跑一趟（与 `probe-open-ai.mjs` 同一套判据）。
 */

import { readFileSync } from 'node:fs';
import { AIDriver } from '../src/game/AIDriver.ts';
import { VehicleDynamics } from '../src/game/VehicleDynamics.ts';
import { DIFFICULTIES } from '../src/game/Difficulty.ts';
import { DIFFICULTY_ORDER, TRACK_ORDER } from '../src/game/constants.ts';
import { MetaTrack } from './meta-track.mjs';

const FRAME_MS = 1000 / 60;
const HALF_WIDTH = 2.3 * 32;
const MAX_SECONDS = 300;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const doSweep = process.argv.includes('--sweep');
const trackIds = args.length > 0 ? args : [...TRACK_ORDER];

/** 跑一档 AI，返回统计。`overrides` 用来扫参数（不落盘，只影响本次）。 */
export function runOne(meta, profileInput, seed = 1) {  const track = new MetaTrack(meta, meta.id);
  const total = track.totalLength;
  const profile = { ...profileInput };
  const dynamics = new VehicleDynamics({
    grassFactor: meta.surface.grassFactor ?? meta.surface.grassSpeedFactor,
    grassRecoverSeconds: meta.surface.grassRecoverSeconds,
  });
  const start = track.poseAt(0);
  dynamics.reset(start.heading, 0, 0);
  const car = { x: start.x, y: start.y, heading: start.heading, speed: 0, blocked: false };
  const driver = new AIDriver(profile, seed);
  const out = { throttle: 0, steer: 0, drift: false };

  const laps = meta.open === true ? 1 : (meta.laps ?? 3);
  const target = total * laps;
  let prevArc = track.progressAt(car.x, car.y).arc;
  const wallAt = new Map();
  let travelled = 0;
  let wallFrames = 0;
  let recoveryEntries = 0;
  let driftFrames = 0;
  let wasRecovering = false;
  let finishMs = null;
  let offTrackFrames = 0;
  /** 漂移判定的三个门槛各自被满足了多少帧（用来定位"为什么没漂"）。 */
  const gate = { useDrift: 0, curvature: 0, speed: 0, all: 0 };
  const curvatureThreshold = profile.drift?.curvature ?? 0.0045;
  const speedThreshold = profile.drift?.minSpeed ?? 260;

  for (let i = 0; i < MAX_SECONDS * 60; i++) {
    driver.drive(car, track, FRAME_MS, out);
    if (out.drift) driftFrames += 1;
    if (profile.useDrift === true) {
      gate.useDrift += 1;
      const c = driver.lastCurvatureValue ?? 0;
      const okC = c > curvatureThreshold;
      const okS = Math.abs(car.speed) > speedThreshold;
      if (okC) gate.curvature += 1;
      if (okS) gate.speed += 1;
      if (okC && okS) gate.all += 1;
    }
    const recovering = driver.isRecovering;
    if (recovering && !wasRecovering) recoveryEntries += 1;
    wasRecovering = recovering;

    const clamped = track.constrain(car.x, car.y);
    car.blocked = clamped !== null;
    if (clamped) {
      car.x = clamped.x;
      car.y = clamped.y;
      car.speed = 0;
      dynamics.speed = 0;
      wallFrames += 1;
      const bucket = Math.floor((travelled / target) * 20) * 5;
      wallAt.set(bucket, (wallAt.get(bucket) ?? 0) + 1);
    }

    const lateral = track.progressAt(car.x, car.y).lateralDistance;
    const onTrack = lateral <= HALF_WIDTH;
    if (!onTrack) offTrackFrames += 1;
    dynamics.step(FRAME_MS / 1000, out, onTrack, true);
    car.heading = dynamics.heading;
    car.speed = dynamics.speed;
    car.x += dynamics.velocityX * (FRAME_MS / 1000);
    car.y += dynamics.velocityY * (FRAME_MS / 1000);

    const arc = track.progressAt(car.x, car.y).arc;
    const d = arc - prevArc;
    if (meta.open === true) {
      if (d > 0 && d < total / 2) travelled += d;
    } else {
      const wrapped = d > total / 2 ? d - total : d < -total / 2 ? d + total : d;
      if (wrapped > 0) travelled += wrapped;
    }
    prevArc = arc;

    if (travelled >= target && finishMs === null) {
      finishMs = (i + 1) * FRAME_MS;
      break;
    }
  }

  const hot = [...wallAt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return {
    finished: finishMs !== null,
    seconds: finishMs === null ? null : finishMs / 1000,
    progressPct: (travelled / target) * 100,
    wallFrames,
    recoveryEntries,
    driftFrames,
    offTrackFrames,
    gate,
    hot,
  };
}

/** 把一行结果格式化。 */
export function formatRun(label, r) {
  const status = r.finished ? `${r.seconds.toFixed(2)}s` : `未完（${r.progressPct.toFixed(0)}%）`;
  const hot = r.hot.length > 0 ? `  撞墙@${r.hot.map(([p, n]) => `${p}%:${n}`).join(' ')}` : '';
  return (
    `  ${label.padEnd(26)} ${status.padStart(11)}` +
    `  贴墙 ${String(r.wallFrames).padStart(5)}  脱困 ${String(r.recoveryEntries).padStart(3)}` +
    `  漂移 ${String(r.driftFrames).padStart(4)}  草地 ${String(r.offTrackFrames).padStart(4)}${hot}` +
    (r.gate && r.gate.useDrift > 0 ? `  门槛[曲率${r.gate.curvature} 速度${r.gate.speed} 同时${r.gate.all}]` : '')
  );
}

const metas = trackIds.map((id) => JSON.parse(readFileSync(`public/assets/maps/${id}.meta.json`, 'utf8')));

if (!doSweep) {
  for (const meta of metas) {
    console.log(
      `\n[${meta.id}] ${meta.name}  长度 ${Math.round(meta.centerline.totalLength)}px  ` +
        `${meta.open === true ? '单程 1 趟' : `${meta.laps} 圈`}`,
    );
    for (const id of DIFFICULTY_ORDER) {
      for (const seed of [1, 2]) {
        const r = runOne(meta, DIFFICULTIES[id], seed);
        console.log(formatRun(`${id} seed${seed}`, r));
      }
    }
  }
} else {
  // --- 参数扫描：找出"更快"的组合，而不是靠推理调
  //
  // track4 上"困难反而最慢"的根因：终点前 95% 那个 67px 急弯。
  // 车速几乎完全由 `steerAuthorityLimit()` 决定（`maxSteerRate / (curvature + decay)`），
  // 与 `corneringGrip` 无关 —— 所以调 grip 那一列**毫无效果**（见扫描结果），
  // 真正的杠杆是"**提前多少开始减速**"（`lookAhead*`）与"减速有多狠"。
  const H = DIFFICULTIES.hard;
  const fast = { ...H, speedCapRatio: 1, corneringGrip: 8000 };
  const combos = [
    ['hard 基准', { ...H }],
    ['cap1 grip8000（候选）', fast],
    ['候选 + reaction 30', { ...fast, reactionMs: 30 }],
    ['候选 + reaction 30 + steerGain 3.2', { ...fast, reactionMs: 30, steerGain: 3.2 }],
    ['候选 + reaction 30 + steerGain 3.2 + LA 100/0.35', { ...fast, reactionMs: 30, steerGain: 3.2, lookAheadBase: 100, lookAheadPerSpeed: 0.35 }],
    ['候选 + reaction 30 + steerGain 3.6', { ...fast, reactionMs: 30, steerGain: 3.6 }],
    ['候选 + reaction 30 + 漂移0.004', { ...fast, reactionMs: 30, useDrift: true, drift: { curvature: 0.004, minSpeed: 240, maxAngle: 0.5 } }],
    ['候选 + reaction 30 + 漂移0.003 min200', { ...fast, reactionMs: 30, useDrift: true, drift: { curvature: 0.003, minSpeed: 200, maxAngle: 0.5 } }],
    ['候选 + reaction 30 + 漂移0.002 min180', { ...fast, reactionMs: 30, useDrift: true, drift: { curvature: 0.002, minSpeed: 180, maxAngle: 0.6 } }],
  ];
  for (const meta of metas) {
    console.log(`\n[${meta.id}] ${meta.name}（${meta.open === true ? '单程' : `${meta.laps} 圈`}）参数扫描`);
    for (const [label, profile] of combos) {
      const results = [1, 2, 3].map((seed) => runOne(meta, profile, seed));
      const ok = results.filter((r) => r.finished);
      const avg = ok.length > 0 ? ok.reduce((a, r) => a + r.seconds, 0) / ok.length : null;
      const walls = results.reduce((a, r) => a + r.wallFrames, 0);
      const drift = results.reduce((a, r) => a + r.driftFrames, 0);
      const off = results.reduce((a, r) => a + r.offTrackFrames, 0);
      console.log(
        `  ${label.padEnd(34)} 平均 ${avg === null ? '  ——  ' : `${avg.toFixed(2)}s`}` +
          `  贴墙 ${String(walls).padStart(5)}  漂移 ${String(drift).padStart(5)}  草地 ${String(off).padStart(5)}` +
          `  ${results.map((r) => (r.finished ? r.seconds.toFixed(1) : 'X')).join('/')}`,
      );
    }
  }
}

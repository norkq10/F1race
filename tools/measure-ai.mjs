/**
 * tools/measure-ai.mjs
 * 用**真实物理**（VehicleDynamics）跑 AI，量出每条赛道 / 每档难度的 3 圈用时。
 *
 * 这是调难度参数的标尺：AI 的圈速必须能对着"玩家大概能开到多少"来定，
 * 而不是靠人肉试玩。走廊宽度与 gen-track.mjs 的 HALF_WIDTH 一致，
 * 出界即按撞墙处理（压回边界 + 车速归零 + blocked），和真车撞墙的后果同量级。
 *
 * 运行：
 *   node --import ./tools/ts-register.mjs tools/measure-ai.mjs [赛道id ...]
 *   加 --sweep 会在 track1 上扫一遍参数，用来找"困难档 46~49s"附近的可行区间。
 */

import { readFileSync } from 'node:fs';
import { AIDriver } from '../src/game/AIDriver.ts';
import { TUNING } from '../src/game/constants.ts';
import { DIFFICULTIES } from '../src/game/Difficulty.ts';
import { VehicleDynamics } from '../src/game/VehicleDynamics.ts';
import { CORRIDOR, HALF_WIDTH_TILES, MetaTrack } from './meta-track.mjs';

const FRAME_MS = 1000 / 60;
const TILE = 32;
const SEEDS = [1, 2, 3];
const LAPS = TUNING.race.laps;

function wrapAngle(angle) {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

function arcDelta(from, to, total) {
  let delta = to - from;
  if (delta > total / 2) delta -= total;
  if (delta < -total / 2) delta += total;
  return delta;
}

/** 跑一场：AI 出输入 → VehicleDynamics 积分 → 走廊约束 → 记里程与事件。 */
function run(track, profile, seed, seconds, grassFactor, grassRecover) {
  const dynamics = new VehicleDynamics({ grassFactor, grassRecoverSeconds: grassRecover });
  const start = track.poseAt(0);
  dynamics.reset(start.heading, 0, 0);
  const car = { x: start.x, y: start.y, heading: start.heading, speed: 0, blocked: false };
  const driver = new AIDriver(profile, seed);
  const out = { throttle: 0, steer: 0, drift: false };

  let prevArc = track.progressAt(car.x, car.y).arc;
  let progressPx = 0;
  let recoveryEntries = 0;
  let recoveryFrames = 0;
  let wallFrames = 0;
  let wasRecovering = false;
  const frames = Math.round((seconds * 1000) / FRAME_MS);
  let lapMs = null;

  for (let i = 0; i < frames; i++) {
    driver.drive(car, track, FRAME_MS, out);

    const recovering = driver.isRecovering;
    if (recovering) recoveryFrames += 1;
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
    }

    const onTrack = track.progressAt(car.x, car.y).lateralDistance <= HALF_WIDTH_TILES * TILE;
    dynamics.step(FRAME_MS / 1000, out, onTrack, true);
    car.heading = dynamics.heading;
    car.speed = dynamics.speed;
    // 把侧滑角喂回给 AI：漂移决策要用它（`shouldDrift` 的 driftMaxAngle 闸门）。
    // 少了这一行，真实物理里侧滑角永远被当成 0，困难 AI 的漂移一直触发不了 ——
    // 而圈速看起来完全正常，所以这个漏项非常隐蔽。
    car.driftAngle = dynamics.driftAngle;
    car.x += dynamics.velocityX * (FRAME_MS / 1000);
    car.y += dynamics.velocityY * (FRAME_MS / 1000);

    const progress = track.progressAt(car.x, car.y);
    const delta = arcDelta(prevArc, progress.arc, track.totalLength);
    if (delta > 0) progressPx += delta;
    prevArc = progress.arc;

    if (lapMs === null && progressPx >= track.totalLength * LAPS) lapMs = (i + 1) * (FRAME_MS / 1000);
  }

  return { lapMs, progressPx, recoveryEntries, recoveryFrames, wallFrames, driftFrames: driver.driftFrames };
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const sweep = argv.includes('--sweep');
const ids = argv.filter((value) => !value.startsWith('--'));

function loadMeta(id) {
  const url = new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** 量一条赛道上一档难度的圈速。 */
function measure(track, profile, meta, seedCount = SEEDS.length) {
  const runs = [];
  for (let i = 0; i < seedCount; i++) {
    runs.push(
      run(track, profile, SEEDS[i % SEEDS.length] + Math.floor(i / SEEDS.length) * 7919, 400, meta.surface.grassSpeedFactor, meta.surface.grassRecoverSeconds),
    );
  }
  const done = runs.map((r) => r.lapMs).filter((t) => t !== null);
  return {
    done: done.length,
    total: runs.length,
    best: done.length ? Math.min(...done) : null,
    avg: done.length ? done.reduce((a, b) => a + b, 0) / done.length : null,
    worst: done.length ? Math.max(...done) : null,
    recovery: runs.reduce((a, r) => a + r.recoveryEntries, 0),
    wall: runs.reduce((a, r) => a + r.wallFrames, 0),
    // 漂移帧数：CR-06 的验收标准是"困难 AI 出现漂移状态"。
    // 只看圈速分不出"漂移生效"和"漂移条件压根没触发"，所以必须单独统计。
    drift: runs.reduce((a, r) => a + r.driftFrames, 0),
  };
}

function formatTime(value) {
  return value === null ? '--' : `${value.toFixed(2)}s`;
}

if (sweep) {
  const meta = loadMeta('track1');
  const track = new MetaTrack(meta);
  const goal = track.totalLength * LAPS;
  console.log(`[sweep] track1，${goal.toFixed(0)}px，玩家参考 45.00s（≈502px/s）\n`);
  console.log('  cap   px/s   平均3圈   best     worst   贴墙');
  for (const cap of [0.76, 0.8, 0.83, 0.86, 0.89, 0.92, 0.94, 0.95, 0.96, 0.97]) {
    const profile = { ...DIFFICULTIES.hard, speedCapRatio: cap };
    const stats = measure(track, profile, meta);
    console.log(
      `  ${cap.toFixed(2)}  ${(TUNING.vehicle.maxSpeed * cap).toFixed(0).padStart(4)}` +
        `  ${formatTime(stats.avg).padStart(8)}` +
        `  ${formatTime(stats.best).padStart(7)}` +
        `  ${formatTime(stats.worst).padStart(7)}` +
        `  ${String(stats.wall).padStart(4)}` +
        (stats.done < stats.total ? '  !有未完赛' : ''),
    );
  }
  console.log('');
} else {

const trackIds = ids.length > 0
  ? ids
  : ['track1', 'track3'].filter((id) => {
      try {
        loadMeta(id);
        return true;
      } catch {
        return false;
      }
    });

console.log(`[measure-ai] 每档 ${SEEDS.length} 个 seed × ${LAPS} 圈，走廊半宽 ${CORRIDOR.toFixed(1)}px`);
for (const id of trackIds) {
  const meta = loadMeta(id);
  const track = new MetaTrack(meta);
  console.log(
    `\n== ${id} == 长度 ${track.totalLength.toFixed(0)}px，${LAPS} 圈 ${(track.totalLength * LAPS).toFixed(0)}px`,
  );
  for (const [key, profile] of Object.entries(DIFFICULTIES)) {
    const stats = measure(track, profile, meta);
    console.log(
      `  ${key.padEnd(6)} cap=${(TUNING.vehicle.maxSpeed * profile.speedCapRatio).toFixed(0)}px/s grip=${profile.corneringGrip}` +
        ` 用时 ${stats.done}/${stats.total} 完赛` +
        ` best=${formatTime(stats.best)}` +
        ` avg=${formatTime(stats.avg)}` +
        ` worst=${formatTime(stats.worst)}` +
        ` 平均车速 ${stats.avg === null ? '--' : ((track.totalLength * LAPS) / stats.avg).toFixed(0) + 'px/s'}` +
        ` 脱困 ${stats.recovery} 次 / 贴墙 ${stats.wall} 帧` +
        ` / 漂移 ${stats.drift} 帧`,
    );
  }
}
}

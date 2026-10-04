/**
 * tools/probe-curvature.mjs
 * 量出 AI 在整圈里**实际看到的**前方曲率分布。
 *
 * 为什么需要它：`TUNING.ai.driftCurvature`（漂移触发阈值）必须落在真实曲率范围内，
 * 否则漂移条件永远不触发 —— 而圈速看起来完全正常，是个很隐蔽的失效。
 * 赛道几何上的"最急弯半径 124px"（曲率 0.0081）不等于 AI 测到的曲率，
 * 因为 AI 用前视点估算（见 `AIDriver` 的 `look` 计算），会把急弯削平。
 *
 * 运行：node --import ./tools/ts-register.mjs tools/probe-curvature.mjs
 */

import { readFileSync } from 'node:fs';
import { AIDriver } from '../src/game/AIDriver.ts';
import { TUNING } from '../src/game/constants.ts';
import { getDifficulty } from '../src/game/Difficulty.ts';
import { MetaTrack } from './meta-track.mjs';

const CORRIDOR = 61.6;
const FRAME_MS = 1000 / 60;
const SECONDS = 70;

function loadMeta(id) {
  return JSON.parse(readFileSync(new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url), 'utf8'));
}

/** 采样整圈里的曲率，返回分位数。 */
function sampleCurvature(track, profile, seed) {
  const start = track.poseAt(0);
  const car = { x: start.x, y: start.y, heading: start.heading, speed: 0, blocked: false, driftAngle: 0 };
  const driver = new AIDriver(profile, seed);
  const out = { throttle: 0, steer: 0, drift: false };

  const values = [];
  const speeds = [];
  const frames = Math.round((SECONDS * 1000) / FRAME_MS);
  for (let i = 0; i < frames; i++) {
    driver.drive(car, track, FRAME_MS, out);
    values.push(driver.lastCurvature);
    speeds.push(Math.abs(car.speed));
    // 用简化积分推着走：这里只关心曲率与速度，不需要完整物理
    const dt = FRAME_MS / 1000;
    car.speed += (out.throttle > 0 ? 700 : -500) * dt;
    car.speed = Math.max(0, Math.min(TUNING.vehicle.maxSpeed, car.speed));
    const steerRate = out.steer * 3.0 * Math.min(1, car.speed / 120);
    car.heading += steerRate * dt;
    car.x += Math.cos(car.heading) * car.speed * dt;
    car.y += Math.sin(car.heading) * car.speed * dt;
    const p = track.progressAt(car.x, car.y);
    if (p.lateralDistance > CORRIDOR) {
      // 撞走廊就贴回去，模拟约束
      const constrained = track.constrain(car.x, car.y);
      if (constrained) {
        car.x = constrained.x;
        car.y = constrained.y;
        car.speed *= 0.3;
      }
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const maxSpeedAtPeak = Math.max(...speeds);
  return {
    max: sorted[sorted.length - 1],
    p999: q(0.999),
    p99: q(0.99),
    p95: q(0.95),
    median: q(0.5),
    maxSpeed: maxSpeedAtPeak,
    // 有多少帧同时满足"曲率够大 且 速度够高"——这才是漂移真正能触发的帧数
    framesOverThreshold: values.filter((c, i) => c > TUNING.ai.driftCurvature && speeds[i] > TUNING.ai.driftMinSpeed).length,
    totalFrames: frames,
  };
}

const trackIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = trackIds.length > 0 ? trackIds : ['track1', 'track3'];

console.log(`[probe-curvature] 当前阈值 driftCurvature=${TUNING.ai.driftCurvature} driftMinSpeed=${TUNING.ai.driftMinSpeed}`);
console.log('（赛道几何最急弯：track1 124px → 曲率 0.0081；track3 137px → 0.0073）\n');

for (const id of ids) {
  const meta = loadMeta(id);
  const track = new MetaTrack(meta);
  console.log(`== ${id} ==`);
  for (const diff of ['easy', 'normal', 'hard']) {
    const profile = getDifficulty(diff);
    for (const seed of [13, 990, 1967]) {
      const r = sampleCurvature(track, profile, seed);
      console.log(
        `  ${diff.padEnd(6)} seed=${String(seed).padStart(4)} 曲率 max=${r.max.toFixed(5)} p99.9=${r.p999.toFixed(5)}` +
          ` p99=${r.p99.toFixed(5)} p95=${r.p95.toFixed(5)} 中位=${r.median.toFixed(5)}` +
          ` 顶速=${r.maxSpeed.toFixed(0)}px/s` +
          ` 可漂移帧=${r.framesOverThreshold}/${r.totalFrames}`,
      );
    }
  }
  console.log('');
}

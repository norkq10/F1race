/**
 * tools/probe-open-ai.mjs
 * 在**单程**赛道上放 AI 跑一趟，看它能不能跑完、撞不撞墙。
 *
 * ## 为什么不能直接用 measure-ai.mjs
 *
 * `measure-ai.mjs` 是按**闭环**写的：它数"跑了多少圈"、按 `arc % total`
 * 判断进度。把开放赛道喂进去，它会当成"绕圈绕了 3 遍"，
 * 于是报出「贴墙 17013 帧 / 脱困 952 次」这种数字 —— 那是**工具在错误赛道拓扑上
 * 跑出来的假结果**，不是赛道有问题。
 *
 * 本工具只跑**一趟**：从起点出发，直到沿路里程达到 `totalLength` 为止。
 *
 * 用法：
 *   node --import ./tools/ts-register.mjs tools/probe-open-ai.mjs track4
 */

import { readFileSync } from 'node:fs';
import { AIDriver } from '../src/game/AIDriver.ts';
import { VehicleDynamics } from '../src/game/VehicleDynamics.ts';
import { DIFFICULTIES } from '../src/game/Difficulty.ts';
import { DIFFICULTY_ORDER } from '../src/game/constants.ts';
import { MetaTrack } from './meta-track.mjs';

const FRAME_MS = 1000 / 60;
const HALF_WIDTH = 2.3 * 32;

const id = process.argv[2] ?? 'track4';
const meta = JSON.parse(readFileSync(`public/assets/maps/${id}.meta.json`, 'utf8'));
const track = new MetaTrack(meta, id);
const total = track.totalLength;
console.log(`[probe] ${id}（${meta.name}）开放路径，长度 ${total.toFixed(0)}px，格子 ${meta.grid.width}×${meta.grid.height}`);

for (const difficulty of DIFFICULTY_ORDER) {
  const profile = DIFFICULTIES[difficulty];
  for (let seed = 0; seed < 3; seed++) {
    const dynamics = new VehicleDynamics({
      grassFactor: meta.surface.grassSpeedFactor,
      grassRecoverSeconds: meta.surface.grassRecoverSeconds,
    });
    const start = track.poseAt(0);
    dynamics.reset(start.heading, 0, 0);
    const car = { x: start.x, y: start.y, heading: start.heading, speed: 0, blocked: false };
    const driver = new AIDriver(profile, seed + 1);
    const out = { throttle: 0, steer: 0, drift: false };

    // 沿路里程：用相邻帧弧长的**有符号增量**累加（开放路径不绕回）
    let prevArc = track.progressAt(car.x, car.y).arc;
    // 记录每次贴墙发生在赛道的哪个位置（弧长百分比）——
    // "困难档撞了 1000 帧"本身没有可操作性，要知道**撞在哪个弯**才能改。
    const wallAt = new Map();
    let travelled = 0;
    let wallFrames = 0;
    let recoveryEntries = 0;
    let wasRecovering = false;
    let finishMs = null;
    const maxFrames = 60 * 240; // 4 分钟上限
    /** 每帧 AI **自己测到的**曲率，用来标定漂移阈值（几何曲率会明显偏小）。 */
    const curvatures = [];
    let driftFramesReal = 0;

    for (let i = 0; i < maxFrames; i++) {
      driver.drive(car, track, FRAME_MS, out);
      curvatures.push(driver.lastCurvatureValue ?? 0);
      if (out.drift) driftFramesReal += 1;
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
        // 按 5% 的弧长粒度归桶
        const bucket = Math.floor((travelled / total) * 20) * 5;
        wallAt.set(bucket, (wallAt.get(bucket) ?? 0) + 1);
      }

      const onTrack = track.progressAt(car.x, car.y).lateralDistance <= HALF_WIDTH;
      dynamics.step(FRAME_MS / 1000, out, onTrack, true);
      car.heading = dynamics.heading;
      car.speed = dynamics.speed;
      car.x += dynamics.velocityX * (FRAME_MS / 1000);
      car.y += dynamics.velocityY * (FRAME_MS / 1000);

      const arc = track.progressAt(car.x, car.y).arc;
      // 开放路径：只累加正向增量，忽略倒车与抖动
      const d = arc - prevArc;
      if (d > 0 && d < total / 2) travelled += d;
      prevArc = arc;
      // 到终点就立刻收工 —— 运行时也该在这儿结束比赛。
      // 不停下来的话，AI 会继续往前开、撞上路的尽头，
      // 于是"贴墙帧数"全落在终点附近（实测 95% 那一桶），看着像赛道有问题。
      if (travelled >= total && finishMs === null) {
        finishMs = (i + 1) * FRAME_MS;
        break;
      }
    }

    const status = finishMs !== null ? `完赛 ${(finishMs / 1000).toFixed(2)}s` : `未跑完（${(travelled / total * 100).toFixed(0)}%）`;
    const sorted = [...curvatures].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    console.log(
      `  ${difficulty.padEnd(7)} seed${seed}  ${status.padEnd(18)}` +
        ` 贴墙 ${String(wallFrames).padStart(5)} 帧  脱困 ${String(recoveryEntries).padStart(4)} 次  ` +
        `漂移 ${String(driftFramesReal).padStart(4)} 帧  曲率 p50 ${q(0.5).toFixed(4)} p95 ${q(0.95).toFixed(4)} p99 ${q(0.99).toFixed(4)} max ${q(0.9999).toFixed(4)}`,
    );
    if (wallAt.size > 0) {
      const hot = [...wallAt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      console.log(`        撞墙位置（弧长%）：` + hot.map(([pct, n]) => `${pct}%:${n}帧`).join('  '));
    }
  }
}

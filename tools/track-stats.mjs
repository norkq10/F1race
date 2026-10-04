/**
 * tools/track-stats.mjs
 * 量一条赛道中心线的几何：长度、最小转弯半径、以及按车辆转向能力反推的"过弯速度上限"。
 *
 * 新赛道必须按这个标尺设计：最小半径太小就会变成"AI 和玩家都得爬过去的死弯"。
 * 转向能力上限公式与 AIDriver.steerAuthorityLimit 同源。
 *
 * 运行：node --import ./tools/ts-register.mjs tools/track-stats.mjs [赛道id ...]
 */

import { readFileSync } from 'node:fs';
import { TUNING } from '../src/game/constants.ts';

const ids = process.argv.slice(2);
const trackIds = ids.length > 0 ? ids : ['track1', 'track3'];

/** 按转向能力反推的过弯速度上限（与 AIDriver.steerAuthorityLimit 同源）。 */
function steerAuthorityLimit(curvature) {
  const V = TUNING.vehicle;
  if (curvature <= 1e-6) return Number.POSITIVE_INFINITY;
  const decay = (V.maxSteerRate * V.highSpeedSteerLoss) / V.maxSpeed;
  return V.maxSteerRate / (curvature + decay);
}

function wrapAngle(angle) {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

for (const id of trackIds) {
  const url = new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url);
  const meta = JSON.parse(readFileSync(url, 'utf8'));
  const points = meta.centerline.points;
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];

  /** 某处切线。 */
  const tangentAt = (arc) => {
    let s = arc % total;
    if (s < 0) s += total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    const dx = points[lo + 1][0] - points[lo][0];
    const dy = points[lo + 1][1] - points[lo][1];
    return Math.atan2(dy, dx);
  };

  // 用 ±8px 的切线差量曲率（局部、抗噪），再按 AIDriver 的 look 尺度复核
  const samples = [];
  const step = 6;
  for (let arc = 0; arc < total; arc += step) {
    const d = 8;
    const turn = Math.abs(wrapAngle(tangentAt(arc + d) - tangentAt(arc - d)));
    const curvature = turn / (2 * d);
    samples.push({ arc, curvature, radius: curvature > 1e-9 ? 1 / curvature : Infinity });
  }
  samples.sort((a, b) => b.curvature - a.curvature);
  const worst = samples[0];

  // 按 AIDriver 实际用的尺度（look = 70 + v*0.9，取 v=300）复核：AI 看到的曲率比局部更平缓
  const look = 70 + 300 * 0.9;
  let worstAi = { curvature: 0, arc: 0 };
  for (let arc = 0; arc < total; arc += 15) {
    const a = Math.abs(wrapAngle(tangentAt(arc + look * 0.2) - tangentAt(arc + look * 0.2 - look * 0.2)));
    const b = Math.abs(wrapAngle(tangentAt(arc + look * 0.6) - tangentAt(arc + look * 0.2)));
    const c = Math.abs(wrapAngle(tangentAt(arc + look) - tangentAt(arc + look * 0.6)));
    const curvature = Math.max(a, b, c) / Math.max(1, look * 0.4);
    if (curvature > worstAi.curvature) worstAi = { curvature, arc };
  }

  // 半径 < 120px 的"死弯"占比
  const tight = samples.filter((s) => s.radius < 120).length;

  console.log(`\n== ${id} ==`);
  console.log(`  长度        : ${total.toFixed(0)}px（${(total / 32).toFixed(0)} 瓦片）`);
  console.log(`  采样点      : ${points.length}`);
  console.log(
    `  最急弯(局部): 曲率 ${worst.curvature.toFixed(5)} = 半径 ${worst.radius.toFixed(0)}px` +
      ` @ arc ${worst.arc.toFixed(0)}`,
  );
  console.log(`  该弯转向上限: ${steerAuthorityLimit(worst.curvature).toFixed(0)}px/s`);
  console.log(
    `  最急弯(AI尺度): 曲率 ${worstAi.curvature.toFixed(5)} = 半径 ${(1 / worstAi.curvature).toFixed(0)}px` +
      ` → 上限 ${steerAuthorityLimit(worstAi.curvature).toFixed(0)}px/s`,
  );
  console.log(`  半径<120px 占比: ${((tight / samples.length) * 100).toFixed(2)}%`);
}

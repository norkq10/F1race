/**
 * tools/measure-track-shape.mjs
 * 量一条控制点表（瓦片坐标）的**几何形状指标**：最急弯半径、最近间距、周长。
 *
 * ## 为什么单独做这个工具
 *
 * `check-tracks.mjs` 只在生成成功后才有东西可量，而它的报错是"最急弯 5px@16704"
 * 这种**单一数字**，看不出"是哪里急、急成什么样"。调形状时需要的是分布：
 * 半径的分位数、最急的几处分别在哪个弧长位置。
 *
 * 用法：
 *   node tools/measure-track-shape.mjs track4
 *   node tools/measure-track-shape.mjs --file tools/dragon-points.json
 */

import { readFileSync } from 'node:fs';
import { TRACKS } from './gen-track.mjs';

const TILE = 32;

const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
let points;
let label;

if (fileIdx >= 0) {
  points = JSON.parse(readFileSync(args[fileIdx + 1], 'utf8'));
  label = args[fileIdx + 1];
} else {
  const id = args.find((a) => !a.startsWith('--')) ?? 'track4';
  const track = TRACKS.find((t) => t.id === id);
  if (!track || !track.controlPoints) {
    console.error(`[shape] 找不到带 controlPoints 的赛道 ${id}`);
    process.exit(1);
  }
  points = track.controlPoints;
  label = `${id}（${track.name}）`;
}

/** Catmull-Rom 采样（与生成器同款）。 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 *
      (2 * p1[0] +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

const n = points.length;
const PER = 12;
const curve = [];
for (let i = 0; i < n; i++) {
  const p0 = points[(i - 1 + n) % n];
  const p1 = points[i];
  const p2 = points[(i + 1) % n];
  const p3 = points[(i + 2) % n];
  for (let k = 0; k < PER; k++) curve.push(catmullRom(p0, p1, p2, p3, k / PER));
}

// 周长
let total = 0;
const cum = [0];
for (let i = 0; i < curve.length; i++) {
  const a = curve[i];
  const b = curve[(i + 1) % curve.length];
  total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  cum.push(total);
}

// 曲率半径（世界像素）。用间隔 SPAN 的三点外接圆，SPAN 越大越平滑（抗噪）。
function radiiFor(span) {
  const out = [];
  for (let i = 0; i < curve.length; i++) {
    const a = curve[(i - span + curve.length) % curve.length];
    const b = curve[i];
    const c = curve[(i + span) % curve.length];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]) * TILE;
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]) * TILE;
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]) * TILE;
    const area = (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2) * TILE * TILE;
    out.push(area > 1e-9 ? (ab * bc * ca) / (4 * area) : Number.POSITIVE_INFINITY);
  }
  return out;
}

console.log(`[shape] ${label}`);
console.log(`  控制点 ${n} 个，采样 ${curve.length} 点，周长 ${(total * TILE).toFixed(0)}px`);
console.log('  曲率半径（世界像素）—— 换不同的测量窗口看稳定性：');
for (const span of [2, 4, 8, 16, 32]) {
  const r = radiiFor(span);
  const finite = r.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p) => finite[Math.min(finite.length - 1, Math.floor(finite.length * p))] ?? Number.POSITIVE_INFINITY;
  console.log(
    `    span=${String(span).padStart(2)}：min ${finite[0].toFixed(0).padStart(5)}  p1 ${q(0.01).toFixed(0).padStart(5)}  ` +
      `p5 ${q(0.05).toFixed(0).padStart(5)}  中位 ${q(0.5).toFixed(0).padStart(5)}`,
  );
}

// 最急的几处（用中等窗口，兼顾稳定与定位准）
const r8 = radiiFor(8);
const worst = [];
for (let i = 0; i < curve.length; i++) worst.push({ i, r: r8[i] });
worst.sort((a, b) => a.r - b.r);
console.log('  最急的 8 处（span=8）：');
const shown = [];
for (const w of worst) {
  if (shown.some((s) => Math.abs(s.i - w.i) < 30)) continue;
  shown.push(w);
  const frac = ((cum[w.i] / total) * 100).toFixed(1);
  console.log(
    `    弧长 ${frac.padStart(5)}%  半径 ${w.r.toFixed(0).padStart(5)}px  ` +
      `控制点附近 #${Math.round((w.i / PER) % n)}  世界 (${(curve[w.i][0] * TILE).toFixed(0)}, ${(curve[w.i][1] * TILE).toFixed(0)})`,
  );
  if (shown.length >= 8) break;
}

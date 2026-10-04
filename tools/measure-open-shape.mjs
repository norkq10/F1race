/**
 * tools/measure-open-shape.mjs
 * 量一条**开放**控制点表（单程赛道）的几何：最急弯半径分布、自交检查、长度。
 *
 * `measure-track-shape.mjs` 是给闭环用的（Catmull-Rom 首尾相接）。
 * 开放路径的端点处理不同（不能把首尾连起来），所以单独一个。
 */

import { TRACKS } from './gen-track.mjs';

const TILE = 32;
// 注意：`process.argv[1]` 是**脚本路径**，所以要跳过它，
// 只在前两个之后的参数里找赛道 id。不加 slice 的话会把脚本路径当 id
// （报错信息里会看到 "D:\node.js\node.exe" 这种莫名其妙的东西）。
const id = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'track4';
const track = TRACKS.find((t) => t.id === id);
if (!track || !track.controlPoints) {
  console.error(`[shape] 找不到带 controlPoints 的赛道 ${id}`);
  process.exit(1);
}
const pts = track.controlPoints;
const n = pts.length;

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

// --- 开放路径：两端各重复端点作为"虚拟邻居"（切线自然）
const PER = 12;
const curve = [];
for (let i = 0; i < n - 1; i++) {
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n - 1, i + 2)];
  for (let k = 0; k < PER; k++) curve.push(catmullRom(p0, p1, p2, p3, k / PER));
}
curve.push(pts[n - 1]);

let total = 0;
const cum = [0];
for (let i = 1; i < curve.length; i++) {
  total += Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]);
  cum.push(total);
}
console.log(`[shape] ${id}（${track.name}）`);
console.log(`  控制点 ${n} 个（**开放路径**），采样 ${curve.length} 点，长度 ${(total * TILE).toFixed(0)}px`);
console.log(`  起 (${pts[0]}) → 终 (${pts[n - 1]})`);

// --- 曲率半径
function radiiFor(span) {
  const out = [];
  for (let i = 0; i < curve.length; i++) {
    const ai = Math.max(0, i - span);
    const ci = Math.min(curve.length - 1, i + span);
    const a = curve[ai];
    const b = curve[i];
    const c = curve[ci];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]) * TILE;
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]) * TILE;
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]) * TILE;
    const area = (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2) * TILE * TILE;
    out.push(area > 1e-9 ? (ab * bc * ca) / (4 * area) : Number.POSITIVE_INFINITY);
  }
  return out;
}

console.log('  曲率半径（世界像素，换窗口看稳定性）：');
for (const span of [2, 4, 8, 16]) {
  const r = radiiFor(span).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (p) => r[Math.min(r.length - 1, Math.floor(r.length * p))];
  console.log(
    `    span=${String(span).padStart(2)}：min ${r[0].toFixed(0).padStart(5)}  p1 ${q(0.01).toFixed(0).padStart(5)}  ` +
      `p5 ${q(0.05).toFixed(0).padStart(5)}  中位 ${q(0.5).toFixed(0).padStart(5)}`,
  );
}

// --- 自交检查：非相邻折线段两两求最近距离
let worst = { d: Number.POSITIVE_INFINITY };
for (let i = 0; i < curve.length; i++) {
  for (let j = i + 12; j < curve.length; j++) {
    const d = Math.hypot(curve[i][0] - curve[j][0], curve[i][1] - curve[j][1]);
    if (d < worst.d) worst = { d, i, j };
  }
}
console.log(
  `  最近的非相邻点间距：${(worst.d * TILE).toFixed(0)}px ` +
    `（弧长位置 ${((cum[worst.i] / total) * 100).toFixed(1)}% 与 ${((cum[worst.j] / total) * 100).toFixed(1)}%）` +
    ` ${worst.d * TILE < 145 ? '⚠️ 低于 4.5 瓦片下限' : '✅ 达标'}`,
);

// --- 最急的几处
const r8 = radiiFor(8);
const worstR = [];
for (let i = 0; i < curve.length; i++) worstR.push({ i, r: r8[i] });
worstR.sort((a, b) => a.r - b.r);
console.log('  最急的 6 处（span=8）：');
const shown = [];
for (const w of worstR) {
  if (shown.some((s) => Math.abs(s.i - w.i) < 24)) continue;
  shown.push(w);
  console.log(
    `    弧长 ${((cum[w.i] / total) * 100).toFixed(1).padStart(5)}%  半径 ${w.r.toFixed(0).padStart(5)}px  ` +
      `世界 (${(curve[w.i][0] * TILE).toFixed(0)}, ${(curve[w.i][1] * TILE).toFixed(0)})`,
  );
  if (shown.length >= 6) break;
}

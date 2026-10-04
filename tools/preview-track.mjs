/**
 * tools/preview-track.mjs
 * 直接从**控制点**渲染中心线预览图（不经过生成器 / 不需要先通过自检）。
 *
 * ## 为什么需要它（这是前 7 轮失败的真正教训）
 *
 * `gen-track.mjs` 会先跑几何自检，不自检通过就不写文件 —— 于是"没通过"的时候
 * **根本没有图可看**，只能盯着一串数字（最急弯 7px、最近间距 0.06 瓦片）猜形状哪里不对。
 * 我上一次就是这么盲调了 7 轮控制点。
 *
 * 这个工具跳过自检，直接把 Catmull-Rom 曲线画出来，并且可以叠加比对照：
 *  - 曲线（白）
 *  - 控制点（青）
 *  - 出发方向箭头（黄）
 *  - 可选：一条参考折线（品红），用来叠加"从草图描出来的原始点"
 *
 * 用法：
 *   node tools/preview-track.mjs track4
 *   node tools/preview-track.mjs track4 --ref <trace.json>   # 叠加参考折线
 *
 * 输出：`tools/screenshots/centerline-<id>.png`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PixelCanvas } from './png.mjs';
import { TRACKS } from './gen-track.mjs';

/**
 * 与 gen-track.mjs 同款的 Catmull-Rom（保证预览与生成一致）。
 *
 * `closed=false` 时两端各"重复端点"当虚拟邻居 —— 这样首尾的切线自然，
 * 而且**不会**画出一条从终点回到起点的假线段（开放路径最容易看错的地方）。
 */
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

/** 走一圈（或一趟）控制点，返回曲线上的采样点。 */
function sampleCurve(points, perSegment = 24, closed = true) {
  const n = points.length;
  const out = [];
  const at = (i) => points[Math.min(n - 1, Math.max(0, i))];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = closed ? points[(i - 1 + n) % n] : at(i - 1);
    const p1 = points[i];
    const p2 = closed ? points[(i + 1) % n] : points[i + 1];
    const p3 = closed ? points[(i + 2) % n] : at(i + 2);
    for (let k = 0; k < perSegment; k++) out.push(catmullRom(p0, p1, p2, p3, k / perSegment));
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/** 估算每个采样点处的曲率半径（px）。用间隔 `span` 的三点外接圆。 */
function curvatureRadii(curve, tilePx, span = 6, closed = true) {
  const n = curve.length;
  const radii = [];
  const at = (i) => curve[Math.min(n - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    const a = closed ? curve[(i - span + n) % n] : at(i - span);
    const b = curve[i];
    const c = closed ? curve[(i + span) % n] : at(i + span);
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    const r = area > 1e-9 ? (ab * bc * ca) / (4 * area) : Number.POSITIVE_INFINITY;
    radii.push(r * tilePx);
  }
  return radii;
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--')) ?? 'track4';
const refIndex = args.indexOf('--ref');
const refPath = refIndex >= 0 ? args[refIndex + 1] : null;

const track = TRACKS.find((t) => t.id === id);
if (!track) {
  console.error(`[preview] 找不到赛道 ${id}。可用：${TRACKS.map((t) => t.id).join(', ')}`);
  process.exit(1);
}
if (!track.controlPoints) {
  console.error(`[preview] ${id} 用的是 centerlineTiles，不是 controlPoints —— 本工具只画控制点版本。`);
  process.exit(1);
}

const pts = track.controlPoints;
const TILE = 32;
const MARGIN = 6; // 瓦片
const grid = track.grid;

const W = grid.width;
const H = grid.height;
const PX_PER_TILE = 6; // 预览图缩放：每瓦片 6 像素
const OW = W * PX_PER_TILE;
const OH = H * PX_PER_TILE;

const canvas = new PixelCanvas(OW, OH);
// 背景：草绿
canvas.fillRect(0, 0, OW, OH, [42, 66, 44]);
// 10 瓦片网格
for (let x = 0; x <= W; x += 10) {
  canvas.fillRect(x * PX_PER_TILE, 0, 1, OH, [54, 82, 56]);
}
for (let y = 0; y <= H; y += 10) {
  canvas.fillRect(0, y * PX_PER_TILE, OW, 1, [54, 82, 56]);
}

const toPx = (p) => [p[0] * PX_PER_TILE, p[1] * PX_PER_TILE];

// --- 参考折线（从草图描出来的原始点）：品红
if (refPath) {
  const raw = JSON.parse(readFileSync(refPath, 'utf8'));
  for (let i = 0; i < raw.length; i++) {
    const a = toPx(raw[i]);
    const b = toPx(raw[(i + 1) % raw.length]);
    drawLine(canvas, a, b, [255, 0, 200]);
  }
}

// --- 曲线：白
// `open: true` 的赛道是**单程**：不能把终点连回起点（那会画出一条假线段，
// 让人以为赛道有那一段路 —— 我在"漂移龙"上就被它误导过一次）。
const closed = track.open !== true;
const curve = sampleCurve(pts, 24, closed);
const segCount = closed ? curve.length : curve.length - 1;
for (let i = 0; i < segCount; i++) {
  drawLine(canvas, toPx(curve[i]), toPx(curve[(i + 1) % curve.length]), [235, 235, 235]);
}

// --- 曲率过急的地方标红（半径 < 100px）
const radii = curvatureRadii(curve, TILE, 6, closed);
let tight = 0;
for (let i = 0; i < curve.length; i++) {
  if (radii[i] < 100) {
    tight++;
    const p = toPx(curve[i]);
    canvas.fillRect(Math.round(p[0]) - 1, Math.round(p[1]) - 1, 3, 3, [255, 60, 60]);
  }
}

// --- 控制点：青
pts.forEach((p, i) => {
  const q = toPx(p);
  canvas.fillRect(Math.round(q[0]) - 1, Math.round(q[1]) - 1, 3, 3, [80, 240, 240]);
  if (i === (track.startIndex ?? 0)) {
    canvas.fillRect(Math.round(q[0]) - 4, Math.round(q[1]) - 4, 9, 9, [255, 220, 40]);
  }
  // 开放路径：把终点也标出来（绿方块），否则看不出哪儿结束
  if (!closed && i === pts.length - 1) {
    canvas.fillRect(Math.round(q[0]) - 4, Math.round(q[1]) - 4, 9, 9, [80, 255, 120]);
  }
});

// --- 出发方向箭头（黄）
const si = track.startIndex ?? 0;
const a0 = pts[si];
const a1 = pts[(si + 1) % pts.length];
const dir = [a1[0] - a0[0], a1[1] - a0[1]];
const dl = Math.hypot(dir[0], dir[1]) || 1;
const tip = [a0[0] + (dir[0] / dl) * 14, a0[1] + (dir[1] / dl) * 14];
drawLine(canvas, toPx(a0), toPx(tip), [255, 220, 40]);
drawLine(canvas, toPx(tip), toPx([tip[0] - (dir[0] / dl) * 5 - (dir[1] / dl) * 3, tip[1] - (dir[1] / dl) * 5 + (dir[0] / dl) * 3]), [255, 220, 40]);
drawLine(canvas, toPx(tip), toPx([tip[0] - (dir[0] / dl) * 5 + (dir[1] / dl) * 3, tip[1] - (dir[1] / dl) * 5 - (dir[0] / dl) * 3]), [255, 220, 40]);

mkdirSync('tools/screenshots', { recursive: true });
const out = `tools/screenshots/centerline-${id}.png`;
canvas.save(out);

console.log(`[preview] ${id}（${track.name}）→ ${out}`);
console.log(`  控制点 ${pts.length} 个，曲线采样 ${curve.length} 点，grid ${W}×${H}`);
console.log(`  出发方向：控制点 #${si} → #${(si + 1) % pts.length}，朝向 (${dir[0].toFixed(1)}, ${dir[1].toFixed(1)})`);
console.log(`  半径 < 100px 的采样点：${tight} / ${curve.length}（标红）`);
if (tight > 0) {
  const worst = Math.min(...radii);
  const at = radii.indexOf(worst);
  console.log(`  最急弯 ${worst.toFixed(0)}px @ 曲线点 ${at}，世界坐标约 (${(curve[at][0] * TILE).toFixed(0)}, ${(curve[at][1] * TILE).toFixed(0)})`);
}

/** 简单的 Bresenham 画线（把线段栅格化到 canvas）。 */
function drawLine(canvas, a, b, color) {
  let [x0, y0] = [Math.round(a[0]), Math.round(a[1])];
  const [x1, y1] = [Math.round(b[0]), Math.round(b[1])];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 5000; guard++) {
    canvas.fillRect(x0, y0, 1, 1, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

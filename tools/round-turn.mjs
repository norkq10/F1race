/**
 * tools/round-turn.mjs
 * 把「漂移龙」右侧回折的**顶端点**替换成一段**显式半圆**。
 *
 * ## 为什么必须换做法（前三次失败的原因）
 *
 * 实测：回折前后两条腿的中心线相距 **10.6 格 = 338px**，
 * 也就是说**画面上有足够空间**做一个半径 169px 的半圆（远大于 100px 下限）。
 *
 * 但实际最急弯只有 57px。原因不是空间不够，而是**几何写法**：
 * 顶端只有 1 个控制点（`[169.7, 16]`）要独自承担 84° 转向，
 * Catmull-Rom 在那里必然捏出尖角。把腿平移、把顶端往东推都改不了这一点
 * （实测 57 → 60 → 58px，几乎不动）。
 *
 * 半圆的曲率是**摊在一串点**上的：只要按弧长均匀撒点，就天然平滑。
 *
 * ## 做法
 *
 * 1. 按**路径顺序**找回折入口 P 与出口 Q
 *    （判据：x 在右侧、y 在上半区，且 P 在 Q 之前）；
 * 2. 圆心 = PQ 中点，半径 = |PQ|/2；
 * 3. 从 P 到 Q 走**朝外**的那半个圆，按固定点距撒点；
 * 4. 用这些点替换掉 P 与 Q 之间的原有控制点。
 *
 * ⚠️ 上一版翻车的点：用"全局 x 最大的点"当顶端 —— 结果抓到了整张图
 * **右下角**那个弯（它的 x 更大）。所以这里改成按 x/y 区域 + 路径顺序来找。
 */

import { readFileSync, writeFileSync } from 'node:fs';

const GEN = 'tools/gen-track.mjs';
let text = readFileSync(GEN, 'utf8');

const start = text.indexOf('const TRACK4_CONTROL_POINTS = [');
const end = text.indexOf('\n];', start) + 3;
const rows = [...text.slice(start, end).matchAll(/\[(-?[\d.]+), (-?[\d.]+)\],/g)].map((m) => [
  Number(m[1]),
  Number(m[2]),
]);
console.log(`[round] 读出 ${rows.length} 个点`);

// --- 找"回折区"的所有点：最右侧一竖（x > xMin）且在上半区（y < yMax）
const X_MIN = Number(process.argv[2] ?? 150);
const Y_MAX = Number(process.argv[3] ?? 40);
const idxs = [];
rows.forEach((p, i) => {
  if (p[0] > X_MIN && p[1] < Y_MAX) idxs.push(i);
});
if (idxs.length < 3) {
  console.error(`[round] 回折区只找到 ${idxs.length} 个点，放宽 X_MIN / Y_MAX`);
  process.exit(1);
}
const iFirst = idxs[0];
const iLast = idxs[idxs.length - 1];
const P = rows[iFirst];
const Q = rows[iLast];
console.log(`[round] 回折区 #${iFirst}..#${iLast}（${idxs.length} 个点）`);
console.log(`[round] 入口 P #${iFirst} = [${P}]`);
console.log(`[round] 出口 Q #${iLast} = [${Q}]`);

const cx = (P[0] + Q[0]) / 2;
const cy = (P[1] + Q[1]) / 2;
const R = Math.hypot(Q[0] - P[0], Q[1] - P[1]) / 2;
console.log(`[round] 圆心 (${cx.toFixed(1)}, ${cy.toFixed(1)})，半径 ${R.toFixed(1)} 格 = ${(R * 32).toFixed(0)}px`);

const aP = Math.atan2(P[1] - cy, P[0] - cx);
const aQ = Math.atan2(Q[1] - cy, Q[0] - cx);
let d = aQ - aP;
while (d > Math.PI) d -= 2 * Math.PI;
while (d < -Math.PI) d += 2 * Math.PI;

// 两个候选半圆（+d 与 -(2π−d)）的中点，选**x 更大**的那个（回折朝外鼓）
const clampPi = (a) => {
  let v = a;
  while (v > Math.PI) v -= 2 * Math.PI;
  while (v < -Math.PI) v += 2 * Math.PI;
  return v;
};
const midA = aP + d / 2;
const altD = d > 0 ? d - 2 * Math.PI : d + 2 * Math.PI;
const midB = aP + altD / 2;
const ax = cx + Math.cos(midA) * R;
const bx = cx + Math.cos(midB) * R;
const useD = ax >= bx ? d : altD;
console.log(
  `[round] 两个候选半圆中点 x：${ax.toFixed(1)}（差 ${((d * 180) / Math.PI).toFixed(0)}°）` +
    ` vs ${bx.toFixed(1)}（差 ${((altD * 180) / Math.PI).toFixed(0)}°）→ 取 ${ax >= bx ? '前' : '后'}者`,
);

const POINT_SPACING = Number(process.argv[4] ?? 4); // 格
const arcLen = Math.abs(useD) * R;
const steps = Math.max(3, Math.round(arcLen / POINT_SPACING));
const arcPoints = [];
for (let k = 1; k < steps; k++) {
  const a = aP + (useD * k) / steps;
  arcPoints.push([
    Math.round((cx + Math.cos(a) * R) * 10) / 10,
    Math.round((cy + Math.sin(a) * R) * 10) / 10,
  ]);
}
console.log(
  `[round] 半圆撒 ${arcPoints.length} 个点（弧长 ${arcLen.toFixed(1)} 格，点距 ${(arcLen / steps).toFixed(1)} 格）`,
);

// --- 替换：保留 P，去掉 P..Q 之间原有的点，插入半圆点，再接 Q 之后
const out = rows.slice(0, iFirst + 1).concat(arcPoints, rows.slice(iLast));
console.log(`[round] 控制点 ${rows.length} → ${out.length}`);

const lines = out.map((p) => `  [${p[0]}, ${p[1]}],`);
text = text.slice(0, start) + `const TRACK4_CONTROL_POINTS = [\n${lines.join('\n')}\n];` + text.slice(end);

const gm = text.match(/(id: 'track4',[\s\S]*?)grid: \{ width: (\d+), height: (\d+) \}/);
if (gm) {
  const w = Math.max(Number(gm[2]), Math.ceil(Math.max(...out.map((p) => p[0])) + 10));
  const h = Math.max(Number(gm[3]), Math.ceil(Math.max(...out.map((p) => p[1])) + 10));
  text = text.replace(
    /(id: 'track4',[\s\S]*?)grid: \{ width: \d+, height: \d+ \}/,
    `$1grid: { width: ${w}, height: ${h} }`,
  );
  console.log(`[round] grid → ${w}×${h}`);
}

writeFileSync(GEN, text, 'utf8');
console.log('[round] 已写回');

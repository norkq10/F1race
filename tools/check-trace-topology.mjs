/**
 * tools/check-trace-topology.mjs
 * 检查 `sketch-centerline.mjs` 跟踪出的中心线**是否是简单闭曲线**（不自交）。
 *
 * ## 为什么需要
 *
 * 生成器报"最急弯 5px + 最近间距 0.10 瓦片"，这两个症状同时出现在**同一处**，
 * 通常意味着路径在那里**自己碰自己** —— 但"自己碰自己"有两种完全不同的原因：
 *
 *  a. 中心线有尖角（等距重采样后相邻点仍在同处）；
 *  b. 跟踪算法在道路"腰"部（两条腿很靠近的地方）**跳到了另一条腿上**，
 *     于是整条路径变成 8 字形：在交叉处，路径上**相距很远的两点**在空间上重合。
 *
 * 两者要修的地方完全不同，所以先量清楚：
 * 对路径上每一对 (i, j)，算"空间距离"与"路径上弧长距离"。
 * 空间近但弧长远的，就是自交。
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const tracePath = process.argv[2] ?? 'tools/dragon-trace.json';

// 让 sketch-centerline 把跟踪结果落盘（若还没有）
if (!readFileSync) throw new Error('unreachable');
let trace;
try {
  trace = JSON.parse(readFileSync(tracePath, 'utf8'));
} catch {
  console.error(`[topo] 读不到 ${tracePath} —— 先跑 node tools/sketch-centerline.mjs <sketch> --dump ${tracePath}`);
  process.exit(1);
}

const n = trace.length;
console.log(`[topo] 中心线 ${n} 个点`);

// 弧长
const cum = [0];
for (let i = 0; i < n; i++) {
  const a = trace[i];
  const b = trace[(i + 1) % n];
  cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
const total = cum[n];
console.log(`[topo] 周长 ${total.toFixed(0)}px`);

// 找"空间近但弧长远"的点对
const NEAR = 30; // 空间阈值（px）：小于路宽的一半，认为重叠
const FAR = 200; // 弧长阈值（px）：超过这个弧长还靠得这么近，就是自交
const hits = [];
for (let i = 0; i < n; i++) {
  for (let j = i + 1; j < n; j++) {
    const dx = trace[j][0] - trace[i][0];
    const dy = trace[j][1] - trace[i][1];
    const d = Math.hypot(dx, dy);
    if (d > NEAR) continue;
    const arc = Math.abs(cum[j] - cum[i]);
    const arcWrap = Math.min(arc, total - arc);
    if (arcWrap < FAR) continue;
    hits.push({ i, j, d, arc: arcWrap, a: trace[i], b: trace[j] });
  }
}

if (hits.length === 0) {
  console.log('[topo] ✅ 没有发现自交：这是一条简单闭曲线');
} else {
  // 按弧长位置聚类，避免把同一个交叉点报成上千条
  hits.sort((p, q) => p.arc - q.arc);
  const clusters = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h.arc - last.arc < 150) {
      last.items.push(h);
      last.arc = (last.arc + h.arc) / 2;
      if (h.d < last.minD) last.minD = h.d;
    } else {
      clusters.push({ arc: h.arc, minD: h.d, items: [h] });
    }
  }
  console.log(`[topo] ⚠️ 发现 ${hits.length} 对自交邻近点，聚成 ${clusters.length} 处：`);
  for (const c of clusters) {
    const h = c.items[0];
    console.log(
      `  弧长 ${c.arc.toFixed(0)}px / ${total.toFixed(0)}px 处：` +
        `点 #${h.i}(${h.a[0]},${h.a[1]}) ≈ 点 #${h.j}(${h.b[0]},${h.b[1]})，` +
        `最近 ${c.minD.toFixed(1)}px（跨 ${c.items.length} 对）`,
    );
  }
}

// 顺带：找相邻点里"过近"的（等距重采样应当避免，若出现说明采样有 bug）
let tooClose = 0;
let minAdj = Number.POSITIVE_INFINITY;
for (let i = 0; i < n; i++) {
  const a = trace[i];
  const b = trace[(i + 1) % n];
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d < 1) tooClose++;
  if (d < minAdj) minAdj = d;
}
console.log(`[topo] 相邻点：最小间距 ${minAdj.toFixed(1)}px，< 1px 的有 ${tooClose} 处`);

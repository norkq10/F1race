/**
 * tools/sketch-centerline.mjs
 * 从手绘草图（黑笔画在浅色背景上）**算法提取**道路中心线，并渲染成游戏用的地图。
 *
 * ## 为什么需要它（这是本项目最该早点想到的一步）
 *
 * 前两次尝试都是"用肉眼在草图上读点、再把点敲成控制点" —— 结果：
 *  - 读数有 ±20px 误差，而画的形状对误差非常敏感；
 *  - 笔画中心线在**交叉 / 靠近**的地方肉眼根本分不清，我连续两次把
 *    "两条腿"描成了"三条腿"，生成出自我交叉的赛道。
 *
 * 更好的办法：**把描点这件事交给算法**。
 *
 *  1. 二值化（深色像素 = 道路）；
 *  2. 对每个像素算"到最近背景的距离"（距离变换）—— 笔画**中心线**上的点
 *     距离最大，正好等于笔画半宽；
 *  3. 从草图上标记的起点出发，沿"距离场脊线"跟踪一圈，得到中心线折线；
 *  4. 按弧长等距重采样 → 直接产出控制点表。
 *
 * 这样"形状"完全来自玩家的图，我只负责把参数（比例 / 路宽）说清楚。
 *
 * ## 用法
 *
 *   node tools/sketch-centerline.mjs <sketch.png> --out tools/screenshots/sketch-centerline.png
 *
 * 需要解码 PNG。本仓库 `tools/png.mjs` 只有编码器，所以这里用 Node 内置的
 * `zlib` 手写一个**只支持非隔行 RGBA/RGB 8bit** 的最小解码器（够读本项目的 PNG）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PixelCanvas } from './png.mjs';

// ---------------------------------------------------------------- PNG 解码

/**
 * 最小 PNG 解码器：支持 8bit、非隔行、颜色类型 0/2/4/6（灰度 / RGB / 灰度+A / RGBA）。
 * 只为本工具服务 —— 不追求完整实现，遇到不支持的就明确报错而不是猜。
 */
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit，实际 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + a) & 0xff;
          break;
        case 2:
          v = (v + b) & 0xff;
          break;
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = (v + pr) & 0xff;
          break;
        }
        default:
          throw new Error(`未知 PNG 过滤器 ${filter}`);
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

// ---------------------------------------------------------------- 距离变换

/**
 * 两遍扫描的倒角距离变换（chamfer 3-4），返回每个像素到最近"背景"的近似距离
 * （单位是 1/3 像素）。只用整数运算，快且够准。
 *
 * @param isRoad 判断某像素是不是道路的谓词
 */
function distanceTransform(width, height, isRoad) {
  const INF = 1 << 28;
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = isRoad(i % width, (i / width) | 0) ? INF : 0;

  // 前向
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y > 0) {
        best = Math.min(best, d[i - width] + 3);
        if (x > 0) best = Math.min(best, d[i - width - 1] + 4);
        if (x < width - 1) best = Math.min(best, d[i - width + 1] + 4);
      }
      if (x > 0) best = Math.min(best, d[i - 1] + 3);
      d[i] = best;
    }
  }
  // 后向
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (d[i] === 0) continue;
      let best = d[i];
      if (y < height - 1) {
        best = Math.min(best, d[i + width] + 3);
        if (x > 0) best = Math.min(best, d[i + width - 1] + 4);
        if (x < width - 1) best = Math.min(best, d[i + width + 1] + 4);
      }
      if (x < width - 1) best = Math.min(best, d[i + 1] + 3);
      d[i] = best;
    }
  }
  return d;
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
if (!src) {
  console.error('用法: node tools/sketch-centerline.mjs <sketch.png>');
  process.exit(1);
}

const img = decodePng(readFileSync(src));
const { width: W, height: H, channels, data } = img;

/** 灰度（0..255）。 */
const gray = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const o = i * channels;
  if (channels >= 3) gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  else gray[i] = data[o];
}

// --- 阈值：道路是深色。
//     用 Otsu 自动定阈值，免得对不同草图手调。
const hist = new Array(256).fill(0);
for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
let sumAll = 0;
for (let v = 0; v < 256; v++) sumAll += v * hist[v];
let sumB = 0;
let wB = 0;
let bestVar = -1;
let threshold = 128;
for (let v = 0; v < 256; v++) {
  wB += hist[v];
  if (wB === 0) continue;
  const wF = gray.length - wB;
  if (wF === 0) break;
  sumB += v * hist[v];
  const mB = sumB / wB;
  const mF = (sumAll - sumB) / wF;
  const between = wB * wF * (mB - mF) * (mB - mF);
  if (between > bestVar) {
    bestVar = between;
    threshold = v;
  }
}

const isDark = (x, y) => gray[y * W + x] < threshold;

// 统计深色像素：确认草图是"深色道路 on 浅色背景"
let darkCount = 0;
for (let i = 0; i < gray.length; i++) if (gray[i] < threshold) darkCount++;
console.log(`[sketch] ${src} ${W}×${H}，Otsu 阈值 ${threshold}，深色像素 ${((darkCount / (W * H)) * 100).toFixed(1)}%`);

const dist = distanceTransform(W, H, isDark);

// --- 笔画半宽 = 距离场的最大值（在笔画中心线上取到）
let maxDist = 0;
for (let i = 0; i < dist.length; i++) if (dist[i] > maxDist) maxDist = dist[i];
const strokeHalfWidth = maxDist / 3; // chamfer 3-4 的单位是 1/3 像素
console.log(`[sketch] 笔画半宽约 ${strokeHalfWidth.toFixed(1)}px（全宽 ${(strokeHalfWidth * 2).toFixed(0)}px）`);

// --- 起点：图上**红色**标记。找红色像素的重心。
let rx = 0;
let ry = 0;
let rn = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * channels;
    const r = data[o];
    const g = channels >= 3 ? data[o + 1] : r;
    const b = channels >= 3 ? data[o + 2] : r;
    if (r > 150 && g < 100 && b < 100) {
      rx += x;
      ry += y;
      rn++;
    }
  }
}
console.log(
  rn > 0
    ? `[sketch] 红色起点标记：${rn} 像素，重心 (${(rx / rn).toFixed(0)}, ${(ry / rn).toFixed(0)})`
    : '[sketch] 未找到红色标记（不影响中心线提取，但起跑线位置要另定）',
);

// --- 输出：把"距离场脊线"画出来给人看（这一步是为了**肉眼确认**提取对不对）
mkdirSync('tools/screenshots', { recursive: true });
const out = new PixelCanvas(W, H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const dv = dist[i] / 3;
    if (!isDark(x, y)) {
      out.fillRect(x, y, 1, 1, [30, 34, 38]);
    } else {
      // 越靠近中心线越亮 —— 脊线会呈现为一条亮线
      const t = strokeHalfWidth > 0 ? Math.min(1, dv / strokeHalfWidth) : 0;
      const c = Math.round(40 + 215 * t);
      out.fillRect(x, y, 1, 1, [c, c, Math.round(c * 0.6)]);
    }
  }
}
const outPath = 'tools/screenshots/sketch-distance.png';
out.save(outPath);
console.log(`[sketch] 距离场（亮 = 靠近中心线）→ ${outPath}`);

// ---------------------------------------------------------------- 脊线跟踪
//
// 思路：道路中心线 = 距离场的**脊线**（局部极大）。
// 从起点出发做 BFS，每一步只在"脊线像素"上走，并且**不允许回头**
// （记录来路方向，禁止 150° 以上的掉头）—— 这样能沿着一圈走完，
// 不会在交叉口拐错弯。
//
// 交叉口（两条腿靠得很近处）是这套方法的弱点：那里脊线会连成一片。
// 所以最后**必须叠加渲染人工确认**，不能只看数字。

/** 判断某像素是否在脊线上（距离接近笔画半宽）。 */
const ridgeThreshold = strokeHalfWidth * 0.72;
const onRidge = (x, y) => {
  if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
  const d = dist[y * W + x] / 3;
  if (d < ridgeThreshold) return false;
  // 局部极大：比 8 邻域里至少一个方向明显更靠内
  const d4 = dist[y * W + x];
  return (
    d4 >= dist[(y - 1) * W + x] &&
    d4 >= dist[(y + 1) * W + x] &&
    d4 >= dist[y * W + x - 1] &&
    d4 >= dist[y * W + x + 1]
  );
};

let ridgeCount = 0;
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (onRidge(x, y)) ridgeCount++;
console.log(`[sketch] 脊线像素 ${ridgeCount} 个（阈值 ${ridgeThreshold.toFixed(1)}px）`);

/**
 * 用"最远点对"把道路切成两半，各自求一条**加权最短路**，拼成完整闭环。
 *
 * 为什么用最远点对：沿着一个闭环，**互相距离最远的一对点**近似把它分成两个半环。
 * 于是只要在两个半环上各求一条最短路，拼起来就是整圈 —— 不需要判断
 * "在分叉口该往哪拐"，也不会因为一步走错就整体跑偏。
 *
 * 为什么不用纯脊线（局部极大）搜索：脊线像素**不连通**（笔画粗细有起伏，
 * "局部极大"会断成一段段），BFS 走不过去。改成在整个道路掩膜上搜索，
 * 但把"越靠中心代价越低"编进 cost：
 *
 *     cost(像素) = 1 + K / (1 + 到边界距离)
 *
 * 这样最短路会**自然贴着中心线走**（那是代价最低的走廊），
 * 同时允许跨过脊线的小缺口。K 取笔画半宽的若干倍，越大越贴近中心。
 */
function traceCycle() {
  const K = strokeHalfWidth * 6;

  /** 在道路掩膜上跑 Dijkstra（8 邻接，对角代价 ×1.414）。 */
  function shortestPath(from, to, banned) {
    const size = W * H;
    const distTo = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
    const prev = new Int32Array(size).fill(-1);
    const start = from[1] * W + from[0];
    const goal = to[1] * W + to[0];
    distTo[start] = 0;

    // 简单二叉堆
    const heap = [[0, start]];
    const push = (item) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let s = i;
          if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
          if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
          if (s === i) break;
          [heap[s], heap[i]] = [heap[i], heap[s]];
          i = s;
        }
      }
      return top;
    };

    while (heap.length > 0) {
      const [d, cur] = pop();
      if (d > distTo[cur]) continue;
      if (cur === goal) break;
      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
          const ni = ny * W + nx;
          if (!isDark(nx, ny)) continue;
          if (banned && banned.has(ni)) continue;
          const dv = dist[ni] / 3;
          // 越靠中心代价越低；离开中心会迅速变贵，于是路径被"拉"到脊线上
          const stepCost = (dx !== 0 && dy !== 0 ? 1.414 : 1) * (1 + K / (1 + dv));
          const nd = d + stepCost;
          if (nd < distTo[ni]) {
            distTo[ni] = nd;
            prev[ni] = cur;
            push([nd, ni]);
          }
        }
      }
    }
    if (!Number.isFinite(distTo[goal])) return null;
    const path = [];
    for (let i = goal; i >= 0; i = prev[i]) {
      path.push([i % W, (i / W) | 0]);
      if (i === start) break;
    }
    return path.reverse();
  }

  // 最远点对：为省时间，在**粗采样**的道路像素上找（每 4px 取一个）
  const samples = [];
  for (let y = 2; y < H - 2; y += 4) {
    for (let x = 2; x < W - 2; x += 4) {
      if (isDark(x, y)) samples.push([x, y]);
    }
  }
  let A = samples[0];
  let B = samples[0];
  let bestD = -1;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const dx = samples[j][0] - samples[i][0];
      const dy = samples[j][1] - samples[i][1];
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        A = samples[i];
        B = samples[j];
      }
    }
  }
  console.log(
    `[sketch] 最远点对（示意）：(${A[0]},${A[1]}) ↔ (${B[0]},${B[1]})，间距 ${Math.sqrt(bestD).toFixed(0)}px`,
  );

  // 把 A、B 吸附到最近的脊线像素，作为两条半环的端点
  const snap = (p) => {
    let best = p;
    let bd = Number.POSITIVE_INFINITY;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (!onRidge(x, y)) continue;
        const d = (x - p[0]) ** 2 + (y - p[1]) ** 2;
        if (d < bd) {
          bd = d;
          best = [x, y];
        }
      }
    }
    return best;
  };
  const sA = snap(A);
  const sB = snap(B);
  console.log(`[sketch] 吸附到脊线后：A(${sA[0]},${sA[1]}) B(${sB[0]},${sB[1]})`);

  const first = shortestPath(sA, sB, null);
  if (!first) return { error: '在道路掩膜上找不到 A→B 的路径（掩膜可能被阈值切断了）' };
  // 把第一条路径的**中间点**禁掉，逼第二条走另一边
  const banned = new Set();
  for (let i = 4; i < first.length - 4; i++) {
    const [x, y] = first[i];
    // 禁掉一个 3×3 小方块，避免第二条紧贴着第一条回来
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) banned.add((y + dy) * W + (x + dx));
  }
  const second = shortestPath(sA, sB, banned);
  if (!second) return { error: '找不到第二个半环（第一条路径把路堵死了，可试着减小禁用它）' };

  const cycle = first.concat(second.slice(1, -1).reverse());
  return { cycle, A: sA, B: sB, firstLen: first.length, secondLen: second.length };
}

const traced = traceCycle();
if (!traced || traced.error) {
  console.error(`[sketch] 脊线跟踪失败：${traced?.error ?? '未知原因'}`);
  process.exit(1);
}
let trace = traced.cycle;
console.log(
  `[sketch] 闭环解出：${trace.length} 个像素点（两条半圆 ${traced.firstLen} + ${traced.secondLen}）`,
);

// --- 接缝处理（**这一步不做的话生成器必报"最急弯 5px"**）
//
// 最远点对的端点由算法挑，跟"起跑线在哪"无关，于是拼接处常常留下
// 一小段**重叠**：路径在缝合点附近走了两遍几乎相同的像素。
// 对曲线来说那是一个 180° 发夹 —— 等距重采样会把两个重合点都留下，
// Catmull-Rom 在那里折出 5px 半径。
//
// 做法：找出所有"相邻点距离 < 3px"的位置（就是重叠段），
// 把环**旋转**到最后一次重叠之后开始 —— 接缝落在路径起点，不再影响形状。
function trimSeam(cycle) {
  const n = cycle.length;
  let lastPinch = -1;
  for (let i = 0; i < n; i++) {
    const a = cycle[i];
    const b = cycle[(i + 1) % n];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) lastPinch = i;
  }
  if (lastPinch < 0) return { cycle, trimmed: 0 };
  const rotated = cycle.slice(lastPinch + 1).concat(cycle.slice(0, lastPinch + 1));
  return { cycle: rotated, trimmed: lastPinch + 1 };
}
const seam = trimSeam(trace);
trace = seam.cycle;
console.log(
  seam.trimmed > 0
    ? `[sketch] 已旋转去掉接缝重叠 ${seam.trimmed} 个点（否则曲线在缝合处会折成发夹）`
    : '[sketch] 没有发现接缝重叠',
);

// --- 把起点对齐到**红色标记**（起跑线），并让它落在直道上
//
// 起点决定出发方向。如果起点正好落在弯上，`startIndex` 指向的那个控制点
// 与下一个点之间会是一个斜向，发车格就歪了。
if (rn > 0) {
  const redX = rx / rn;
  const redY = ry / rn;
  let nearest = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < trace.length; i++) {
    const d = (trace[i][0] - redX) ** 2 + (trace[i][1] - redY) ** 2;
    if (d < bestD) {
      bestD = d;
      nearest = i;
    }
  }
  trace = trace.slice(nearest).concat(trace.slice(0, nearest));
  console.log(
    `[sketch] 起点已对齐红点：像素 (${redX.toFixed(0)}, ${redY.toFixed(0)})，` +
      `吸附到 (${trace[0][0]}, ${trace[0][1]})，偏移 ${Math.sqrt(bestD).toFixed(0)}px`,
  );
}

// --- 闭合性检查：首尾应当贴在一起
const closedGap = Math.hypot(trace[0][0] - trace[trace.length - 1][0], trace[0][1] - trace[trace.length - 1][1]);
console.log(`[sketch] 首尾间距 ${closedGap.toFixed(0)}px`);
if (closedGap > 6) {
  console.log(
    `[sketch] ⚠️ 首尾没贴合（差 ${closedGap.toFixed(0)}px）—— 生成时会被当成一段额外短路，` +
      `在那里折出尖角。检查上面的阈值是否把道路切断了。`,
  );
}

/**
 * Ramer–Douglas–Peucker 简化闭合折线。
 *
 * 为什么需要：跟踪结果是**每像素一个点**（4000+ 个，相邻点 1px）。
 * 生成器要为每个控制点跑自检，点数太慢；而且 1px 的点距远小于
 * 笔画半宽（27px），里面全是锯齿噪声。
 *
 * 简化到 `tolerance` 像素的误差以内，能把 4000 点压到一两百点，
 * 形状几乎不变（容差取笔画半宽的 1/5 左右比较安全）。
 */
function simplifyClosed(points, tolerance) {
  const n = points.length;
  if (n < 8) return points;
  // 闭合折线：先固定两个"最远点"作为两端，各自简化
  let aIdx = 0;
  let bIdx = 0;
  let bestD = -1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = (points[j][0] - points[i][0]) ** 2 + (points[j][1] - points[i][1]) ** 2;
      if (d > bestD) {
        bestD = d;
        aIdx = i;
        bIdx = j;
      }
    }
  }
  if (aIdx > bIdx) [aIdx, bIdx] = [bIdx, aIdx];

  const seg1 = points.slice(aIdx, bIdx + 1);
  const seg2 = points.slice(bIdx).concat(points.slice(0, aIdx + 1));

  const rdp = (pts, tol) => {
    if (pts.length < 3) return pts.slice();
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dx = last[0] - first[0];
    const dy = last[1] - first[1];
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i];
      const d =
        len > 1e-9
          ? Math.abs(dy * p[0] - dx * p[1] + last[0] * first[1] - last[1] * first[0]) / len
          : Math.hypot(p[0] - first[0], p[1] - first[1]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD <= tol) return [first, last];
    const left = rdp(pts.slice(0, idx + 1), tol);
    const right = rdp(pts.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  };

  const s1 = rdp(seg1, tolerance);
  const s2 = rdp(seg2, tolerance);
  // 拼起来（去掉重复端点）
  return s1.slice(0, -1).concat(s2.slice(0, -1));
}

const simplified = simplifyClosed(trace, Math.max(2, strokeHalfWidth * 0.22));
console.log(
  `[sketch] 简化：${trace.length} → ${simplified.length} 点` +
    `（RDP 容差 ${Math.max(2, strokeHalfWidth * 0.22).toFixed(1)}px，远小于笔画半宽 ${strokeHalfWidth.toFixed(0)}px）`,
);


// --- 叠加渲染：蓝线 = 跟踪出的中心线。**必须肉眼看这条线是否贴合脊线**
const overlay = new PixelCanvas(W, H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const dv = dist[i] / 3;
    const t = strokeHalfWidth > 0 ? Math.min(1, dv / strokeHalfWidth) : 0;
    const c = isDark(x, y) ? Math.round(40 + 150 * t) : 30;
    overlay.fillRect(x, y, 1, 1, [c, c, c]);
  }
}
for (let i = 0; i < trace.length; i++) {
  const [x0, y0] = trace[i];
  const [x1, y1] = trace[(i + 1) % trace.length];
  drawLine(overlay, x0, y0, x1, y1, [80, 200, 255]);
}
overlay.fillRect(Math.round(rx / rn) - 5, Math.round(ry / rn) - 5, 11, 11, [255, 60, 60]);
const overlayPath = 'tools/screenshots/sketch-trace.png';
overlay.save(overlayPath);
console.log(`[sketch] 中心线叠加（蓝线 = 跟踪结果）→ ${overlayPath}`);

// 可选：把跟踪结果落盘，供 check-trace-topology.mjs 做拓扑检查
const dumpIndex = args.indexOf('--dump');
if (dumpIndex >= 0) {
  const dumpPath = args[dumpIndex + 1] ?? 'tools/dragon-trace.json';
  writeFileSync(dumpPath, JSON.stringify(trace), 'utf8');
  console.log(`[sketch] 中心线原始点 → ${dumpPath}`);
}

// ---------------------------------------------------------------- 输出控制点
//
// 跟踪出来的折线有 4000+ 个像素点（每像素一个），太密了：
// 生成器要为每个控制点做自检，点数太多会非常慢，而且没有必要。
// 按弧长**等距重采样**成几十~一百多个控制点即可。

/** 按弧长等距重采样一条闭合折线。 */
function resampleClosed(points, spacing) {
  const m = points.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const a = points[i];
    const b = points[(i + 1) % m];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[m];
  const count = Math.max(8, Math.round(total / spacing));
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (seg < m - 1 && target >= cum[seg + 1]) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const u = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = points[seg];
    const b = points[(seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return { points: out, total };
}

const scaleArg = (() => {
  const i = args.indexOf('--scale');
  return i >= 0 ? Number(args[i + 1]) : 8;
})();
const spacingArg = (() => {
  const i = args.indexOf('--spacing');
  return i >= 0 ? Number(args[i + 1]) : 10;
})();

const resampled = resampleClosed(simplified, spacingArg * scaleArg);
// 转瓦片并取整到 0.1
let tiles = resampled.points.map(([x, y]) => [
  Math.round((x / scaleArg) * 10) / 10,
  Math.round((y / scaleArg) * 10) / 10,
]);

// --- 把重采样的**相位**对齐到红色起跑线
//
// 为什么必须做：重采样是从折线的第 0 个点开始计数的。如果第 0 个点不在
// 起跑线上，那么 `startIndex` 指到中间某个点时，"闭合那一小段"就落在
// 起跑线附近**不该有接缝的地方** —— 生成出来的赛道会在那里出现一段
// 长直连线（预览图上表现为一条突兀的直线），而不是沿路走。
//
// 做法：旋转点列，让离红点最近的那个控制点变成 #0。
if (rn > 0) {
  const redX = rx / rn;
  const redY = ry / rn;
  let nearest = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tiles.length; i++) {
    const d = (tiles[i][0] * scaleArg - redX) ** 2 + (tiles[i][1] * scaleArg - redY) ** 2;
    if (d < bestD) {
      bestD = d;
      nearest = i;
    }
  }
  tiles = tiles.slice(nearest).concat(tiles.slice(0, nearest));
  console.log(
    `[sketch] 重采样相位已对齐红点：旋转 ${nearest} 个点，` +
      `#0 距红点 ${Math.sqrt(bestD).toFixed(0)}px`,
  );
}

const xs = tiles.map((p) => p[0]);
const ys = tiles.map((p) => p[1]);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

// 起跑点：取离红点最近的控制点索引
const redX = rn > 0 ? rx / rn : minX * scaleArg;
const redY = rn > 0 ? ry / rn : minY * scaleArg;
let startIndex = 0;
let startBest = Number.POSITIVE_INFINITY;
tiles.forEach((p, i) => {
  const d = (p[0] * scaleArg - redX) ** 2 + (p[1] * scaleArg - redY) ** 2;
  if (d < startBest) {
    startBest = d;
    startIndex = i;
  }
});

// 绕行方向：用相邻两点的叉积和判断整体走向（草图是顺时针）
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
const area = signedArea(tiles);

console.log('');
console.log(`[sketch] 等距重采样：${tiles.length} 个控制点（间距 ${spacingArg} 瓦片，${scaleArg}px/瓦片）`);
console.log(`[sketch] 包围盒 x[${minX.toFixed(1)}, ${maxX.toFixed(1)}] y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
console.log(`[sketch] 建议 grid: { width: ${Math.ceil(maxX + 10)}, height: ${Math.ceil(maxY + 10)} }`);
console.log(
  `[sketch] 起跑点：控制点 #${startIndex}（离红点 ${Math.sqrt(startBest).toFixed(0)}px），` +
    `绕行方向 ${area > 0 ? '顺时针（屏幕上）' : '逆时针（屏幕上）'}`,
);
console.log('');
console.log('const TRACK4_CONTROL_POINTS = [');
tiles.forEach((p, i) => {
  const tag = i === startIndex ? '  // <- 起跑区（startIndex）' : '';
  console.log(`  [${p[0]}, ${p[1]}],${tag}`);
});
console.log('];');
console.log('');
console.log(`（startIndex: ${startIndex}）`);

/** Bresenham 画线。 */
function drawLine(canvas, x0, y0, x1, y1, color) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const ex = Math.round(x1);
  const ey = Math.round(y1);
  const ddx = Math.abs(ex - x);
  const ddy = Math.abs(ey - y);
  const sx = x < ex ? 1 : -1;
  const sy = y < ey ? 1 : -1;
  let err = ddx - ddy;
  for (let guard = 0; guard < 6000; guard++) {
    canvas.fillRect(x, y, 1, 1, color);
    if (x === ex && y === ey) break;
    const e2 = 2 * err;
    if (e2 > -ddy) {
      err -= ddy;
      x += sx;
    }
    if (e2 < ddx) {
      err += ddx;
      y += sy;
    }
  }
}

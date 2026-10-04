/**
 * tools/sketch-open-path.mjs
 * 从手绘草图提取**开放路径**（单程赛道）的中心线。
 *
 * 与 `sketch-centerline.mjs`（闭环版）的区别：
 *  - 闭环版用"最远点对切两半 + 双向最短路"拼成一圈；
 *  - 开放版只要从**起点红标**到**终点红标**求一条最短路即可，简单得多，
 *    也不会碰到"接缝"问题。
 *
 * 输出：等距重采样后的控制点表（瓦片坐标），可直接粘进 gen-track.mjs。
 *
 * 用法：
 *   node tools/sketch-open-path.mjs tools/sketch-dragon2.png
 *   node tools/sketch-open-path.mjs tools/sketch-dragon2.png --scale 8 --spacing 8
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PixelCanvas } from './png.mjs';

// ---------------------------------------------------------------- PNG 解码（与 sketch-centerline 同款）

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0) throw new Error('只支持 8bit 非隔行');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
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
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

function distanceTransform(width, height, isRoad) {
  const INF = 1 << 28;
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = isRoad(i % width, (i / width) | 0) ? INF : 0;
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
  console.error('用法: node tools/sketch-open-path.mjs <sketch.png>');
  process.exit(1);
}
const scaleArg = (() => {
  const i = args.indexOf('--scale');
  return i >= 0 ? Number(args[i + 1]) : 8;
})();
const spacingArg = (() => {
  const i = args.indexOf('--spacing');
  return i >= 0 ? Number(args[i + 1]) : 8;
})();

const img = decodePng(readFileSync(src));
const { width: W, height: H, channels, data } = img;

const gray = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const o = i * channels;
  gray[i] = channels >= 3 ? Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) : data[o];
}
const isDark = (x, y) => x >= 0 && y >= 0 && x < W && y < H && gray[y * W + x] < 127;

let darkCount = 0;
for (let i = 0; i < gray.length; i++) if (gray[i] < 127) darkCount++;
console.log(`[open] ${src} ${W}×${H}，深色像素 ${((darkCount / (W * H)) * 100).toFixed(1)}%`);

const dist = distanceTransform(W, H, isDark);
let maxDist = 0;
for (let i = 0; i < dist.length; i++) if (dist[i] > maxDist) maxDist = dist[i];
const strokeHalfWidth = maxDist / 3;
console.log(`[open] 路宽约 ${(strokeHalfWidth * 2).toFixed(0)}px（半宽 ${strokeHalfWidth.toFixed(1)}px）`);

// --- 找红色标记（可能有多个：起点 / 终点），按 x 排序
const reds = [];
const seen = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (seen[i]) continue;
    const o = i * channels;
    const r = data[o];
    const g = channels >= 3 ? data[o + 1] : r;
    const b = channels >= 3 ? data[o + 2] : r;
    if (!(r > 150 && g < 100 && b < 100)) continue;
    // 洪水填充这一坨红
    let sx = 0;
    let sy = 0;
    let n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const cur = stack.pop();
      const cx = cur % W;
      const cy = (cur / W) | 0;
      sx += cx;
      sy += cy;
      n++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ni = ny * W + nx;
          if (seen[ni]) continue;
          const no = ni * channels;
          const nr = data[no];
          const ng = channels >= 3 ? data[no + 1] : nr;
          const nb = channels >= 3 ? data[no + 2] : nr;
          if (nr > 150 && ng < 100 && nb < 100) {
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    reds.push({ x: sx / n, y: sy / n, n });
  }
}
reds.sort((a, b) => a.y - b.y);
console.log(
  `[open] 红色标记 ${reds.length} 处：` +
    reds.map((r) => `(${r.x.toFixed(0)},${r.y.toFixed(0)} n=${r.n})`).join(' '),
);
if (reds.length < 2) {
  console.error('[open] 需要两处红色标记（起点 + 终点）才能确定单程方向');
  process.exit(1);
}
// 起点取最上面那个（草图上起点在左上），终点取最下面
const START = reds[0];
const FINISH = reds[reds.length - 1];
console.log(`[open] 起点 (${START.x.toFixed(0)},${START.y.toFixed(0)}) → 终点 (${FINISH.x.toFixed(0)},${FINISH.y.toFixed(0)})`);

/**
 * 在道路掩膜上求加权最短路（与闭环版同款：越靠中心代价越低）。
 * 起点/终点都吸附到最近的路面像素。
 */
function snapToRoad(p) {
  let best = null;
  for (let r = 0; r < 40 && !best; r++) {
    for (let dy = -r; dy <= r && !best; dy++) {
      for (let dx = -r; dx <= r && !best; dx++) {
        const x = Math.round(p.x) + dx;
        const y = Math.round(p.y) + dy;
        if (isDark(x, y)) best = [x, y];
      }
    }
  }
  return best;
}
const sA = snapToRoad(START);
const sB = snapToRoad(FINISH);
if (!sA || !sB) {
  console.error('[open] 起点或终点吸附不到路面');
  process.exit(1);
}

const K = strokeHalfWidth * 6;
function shortestPath(from, to) {
  const size = W * H;
  const distTo = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(size).fill(-1);
  const start = from[1] * W + from[0];
  const goal = to[1] * W + to[0];
  distTo[start] = 0;
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
        if (!isDark(nx, ny)) continue;
        const ni = ny * W + nx;
        const dv = dist[ni] / 3;
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

const raw = shortestPath(sA, sB);
if (!raw) {
  console.error('[open] 找不到起点到终点的路径 —— 路可能被阈值切断了');
  process.exit(1);
}
let total = 0;
for (let i = 1; i < raw.length; i++) total += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
console.log(`[open] 中心线 ${raw.length} 点，长度 ${total.toFixed(0)}px`);

// --- 简化（RDP）+ 等距重采样
function rdp(pts, tol) {
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
  return rdp(pts.slice(0, idx + 1), tol).slice(0, -1).concat(rdp(pts.slice(idx), tol));
}
const simplified = rdp(raw, Math.max(2, strokeHalfWidth * 0.2));
console.log(`[open] 简化：${raw.length} → ${simplified.length} 点`);

function resampleOpen(points, spacing) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const totalLen = cum[cum.length - 1];
  const count = Math.max(2, Math.round(totalLen / spacing));
  const out = [];
  let seg = 0;
  for (let k = 0; k <= count; k++) {
    const target = (totalLen * k) / count;
    while (seg < points.length - 2 && target >= cum[seg + 1]) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const u = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = points[seg];
    const b = points[seg + 1];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return { points: out, total: totalLen };
}
const resampled = resampleOpen(simplified, spacingArg * scaleArg);
const tiles = resampled.points.map(([x, y]) => [
  Math.round((x / scaleArg) * 10) / 10,
  Math.round((y / scaleArg) * 10) / 10,
]);

const xs = tiles.map((p) => p[0]);
const ys = tiles.map((p) => p[1]);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

console.log('');
console.log(`[open] 等距重采样：${tiles.length} 个控制点（间距 ${spacingArg} 瓦片，${scaleArg}px/瓦片）`);
console.log(`[open] 包围盒 x[${minX.toFixed(1)}, ${maxX.toFixed(1)}] y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
console.log(`[open] 建议 grid: { width: ${Math.ceil(maxX + 10)}, height: ${Math.ceil(maxY + 10)} }`);
console.log('');
console.log('const TRACK4_CONTROL_POINTS = [');
tiles.forEach((p, i) => {
  const tag = i === 0 ? '  // <- 起点' : i === tiles.length - 1 ? '  // <- 终点' : '';
  console.log(`  [${p[0]}, ${p[1]}],${tag}`);
});
console.log('];');
console.log('（这是**开放路径**：startIndex 固定为 0，终点是最后一个点）');
console.log('');
console.log(
  '注意：**不能**用一段圆弧把起终点连起来凑成闭环 —— 这条路自己会从两个端点之间穿过，' +
    '任何闭合弧都会和它交叉。单程就是单程，必须让引擎支持开放路径。',
);

// 落盘原始中心线供拓扑检查
writeFileSync('tools/dragon2-trace.json', JSON.stringify(raw), 'utf8');
console.log('[open] 中心线原始点 → tools/dragon2-trace.json');

// 叠加图
mkdirSync('tools/screenshots', { recursive: true });
const ov = new PixelCanvas(W, H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dv = dist[y * W + x] / 3;
    const t = Math.min(1, dv / strokeHalfWidth);
    const c = isDark(x, y) ? Math.round(40 + 150 * t) : 30;
    ov.fillRect(x, y, 1, 1, [c, c, c]);
  }
}
for (let i = 0; i < raw.length; i++) {
  const [x0, y0] = raw[i];
  const [x1, y1] = raw[(i + 1) % raw.length];
  drawLine(ov, x0, y0, x1, y1, [80, 200, 255]);
}
ov.fillRect(Math.round(START.x) - 6, Math.round(START.y) - 6, 13, 13, [80, 255, 80]);
ov.fillRect(Math.round(FINISH.x) - 6, Math.round(FINISH.y) - 6, 13, 13, [255, 80, 80]);
ov.save('tools/screenshots/sketch-open-trace.png');
console.log('[open] 跟踪叠加图（绿=起点 红=终点）→ tools/screenshots/sketch-open-trace.png');

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
  for (let g = 0; g < 8000; g++) {
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

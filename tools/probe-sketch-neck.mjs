/**
 * tools/probe-sketch-neck.mjs
 * 探测手绘草图在"腰部"（两条路靠得很近的地方）到底是**两条分开的路**，
 * 还是**合并成一团**（= 两条路在那儿真的交叠 / 交叉）。
 *
 * ## 为什么这件事必须先搞清楚
 *
 * 生成器报"最近间距 0.03 瓦片"，有两种完全不同的原因：
 *
 *  a. **中心线提取走错了**：道路本身没问题，是我在窄颈处跳到了另一条腿上；
 *  b. **草图本身就是个 8 字形**：那两条路在图上真的交叠，中心线确实自交。
 *
 * (a) 可以修提取算法；(b) 只能改设计。二者要做的决定完全不同。
 *
 * 判据：沿**竖直扫描线**看道路掩膜有几段连续区间。
 *  - 每个 y 都恰好 1 段 → 没有交叉（是"两条平行路"被画得太近，或路本身很宽）
 *  - 某些 y 出现 2 段 → 那个高度上确实有两条独立的路
 *  - 出现 3 段以上 → 那里有交叠（8 字形）
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

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

const src = process.argv[2] ?? 'tools/sketch-dragon.png';
const img = decodePng(readFileSync(src));
const { width: W, height: H, channels, data } = img;

const gray = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const o = i * channels;
  gray[i] = channels >= 3 ? Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) : data[o];
}
const isDark = (x, y) => gray[y * W + x] < 127;

// --- 逐条竖直扫描线统计道路段数
console.log(`[neck] ${src} ${W}×${H}`);
console.log('   y | 段数 | 各段范围（x 起-止, 宽度）');
let multi = 0;
const rowsWithIssues = [];
for (let y = 0; y < H; y += 10) {
  const runs = [];
  let start = -1;
  for (let x = 0; x < W; x++) {
    const d = isDark(x, y);
    if (d && start < 0) start = x;
    if (!d && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, W - 1]);
  // 合并被抗锯齿切碎的小段（< 3px）
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= 3) last[1] = r[1];
    else merged.push([...r]);
  }
  const solid = merged.filter((r) => r[1] - r[0] >= 3);
  if (solid.length >= 2) {
    multi++;
    if (rowsWithIssues.length < 30) {
      rowsWithIssues.push(
        `  ${String(y).padStart(4)} |  ${solid.length}   | ` +
          solid.map((r) => `[${r[0]}-${r[1]} w${r[1] - r[0] + 1}]`).join(' '),
      );
    }
  }
  if (y % 100 === 0) {
    console.log(
      `  ${String(y).padStart(4)} |  ${solid.length}   | ` + solid.map((r) => `[${r[0]}-${r[1]}]`).join(' '),
    );
  }
}
console.log('');
console.log(`[neck] 有 ${multi} 条扫描线（每 10px 一条）出现 ≥2 段道路。`);
if (rowsWithIssues.length > 0) {
  console.log('[neck] 出现多段的行（最多列 30 条）：');
  for (const r of rowsWithIssues) console.log(r);
}

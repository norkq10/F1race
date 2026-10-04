/**
 * tools/apply-dragon.mjs
 * 把 `sketch-centerline.mjs` 从草图提取出的控制点，写进 `gen-track.mjs`。
 *
 * 做成独立脚本而不是一行 shell 命令：内联命令里的 `$1` 之类的正则替换
 * 会被 PowerShell 当成变量展开（本项目已经因此踩过好几次）。
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const GEN = 'tools/gen-track.mjs';
const SKETCH = process.argv[2] ?? 'tools/sketch-dragon2.png';
const scale = process.argv[3] ?? '8';
const spacing = process.argv[4] ?? '8';
// 第二版草图是**开放路径**（单程），走 open-path 工具；不加 --open 则按闭环处理
const open = process.argv.includes('--open');

const tool = open ? 'tools/sketch-open-path.mjs' : 'tools/sketch-centerline.mjs';
const extra = open ? '' : ` --dump tools/dragon-trace.json`;

const out = execSync(`node ${tool} ${SKETCH} --scale ${scale} --spacing ${spacing}${extra}`, {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const block = out.match(/const TRACK4_CONTROL_POINTS = \[[\s\S]*?\n\];/);
const siMatch = out.match(/（startIndex: (\d+)）/);
const gridMatch = out.match(/建议 grid: \{ width: (\d+), height: (\d+) \}/);
if (!block || !gridMatch || (!open && !siMatch)) {
  console.error('[apply] 解析输出失败');
  console.error(out.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
// 开放路径的起点固定是 #0
const startIndex = open ? 0 : Number(siMatch[1]);
const gridW = Number(gridMatch[1]);
const gridH = Number(gridMatch[2]);

let text = readFileSync(GEN, 'utf8');

// --- 替换控制点表
const start = text.indexOf('const TRACK4_CONTROL_POINTS = [');
if (start < 0) {
  console.error('[apply] gen-track.mjs 里找不到 TRACK4_CONTROL_POINTS');
  process.exit(1);
}
const end = text.indexOf('\n];', start) + 3;
text = text.slice(0, start) + block[0] + text.slice(end);

// --- 替换 grid / startIndex（只动 track4 那一段）
const track4Start = text.indexOf("id: 'track4'");
if (track4Start < 0) {
  console.error("[apply] gen-track.mjs 里找不到 track4");
  process.exit(1);
}
// track4 条目到下一个 '},' 结尾
const track4End = text.indexOf('\n  },', track4Start) + 5;
let section = text.slice(track4Start, track4End);
section = section
  .replace(/grid: \{ width: \d+, height: \d+ \}/, `grid: { width: ${gridW}, height: ${gridH} }`)
  .replace(/startIndex: \d+/, `startIndex: ${startIndex}`);
text = text.slice(0, track4Start) + section + text.slice(track4End);

writeFileSync(GEN, text, 'utf8');

const pointCount = (block[0].match(/\[/g) ?? []).length - 0;
console.log(`[apply] 已写入 ${pointCount} 个控制点，grid ${gridW}×${gridH}，startIndex ${startIndex}`);
console.log(out.split('\n').filter((l) => l.includes('[sketch]')).join('\n'));

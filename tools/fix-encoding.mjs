/**
 * tools/fix-encoding.mjs
 * 修复被"用 GBK 读 UTF-8 文件、再按 UTF-8 写回"弄坏的源码文件。
 *
 * 损坏链路（真踩过两次，都发生在用 PowerShell 的 Get-Content / Set-Content 改文件时）：
 *   原始 UTF-8 字节 --(按系统 ANSI 代码页 GBK 解码)--> 乱码字符串 --(按 UTF-8 编码)--> 落在磁盘上
 * 因为 GBK 解码时会把多字节 UTF-8 序列"吃"成一个个汉字，换行符有时也会被吃掉，
 * 所以文件里还会出现"两行粘在一起"的现象。
 *
 * 逆变换：把当前文本按 GBK 编码回字节，再按 UTF-8 解码，就能还原出原文。
 * GBK 是双射的（没有替换字符），所以只要文件里没有 U+FFFD 就能完整还原。
 *
 * 用法：node tools/fix-encoding.mjs <文件> [<文件> ...]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：node tools/fix-encoding.mjs <文件> [...]');
  process.exit(1);
}

for (const file of files) {
  const current = readFileSync(file, 'utf8');
  if (current.includes('\uFFFD')) {
    console.error(`[fix-encoding] ${file} 含替换字符 U+FFFD，信息已丢失，拒绝改写。`);
    process.exitCode = 1;
    continue;
  }

  // 当前文本 → GBK 字节 → UTF-8 文本
  const gbkBytes = Buffer.from(current, 'latin1'); // 占位：真正的 GBK 编码在下面用 TextEncoder 替代
  void gbkBytes;

  // Node 没有内置 GBK 编码器，所以用"查表反推"的方式：
  // 先用 TextDecoder('gbk') 建立一个 字节→字符 的映射，再反过来查。
  const table = new Map();
  const decoder = new TextDecoder('gbk', { fatal: false });
  const buf = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      buf[0] = lead;
      buf[1] = trail;
      const ch = decoder.decode(buf);
      if (ch.length === 1 && ch !== '\uFFFD') table.set(ch, [lead, trail]);
    }
  }
  for (let b = 0x00; b <= 0x7f; b++) {
    table.set(String.fromCharCode(b), [b]);
  }

  const out = [];
  let missing = 0;
  for (const ch of current) {
    const pair = table.get(ch);
    if (!pair) {
      // 不在 GBK 表里（例如本来就该是 ASCII 之外的原生字符）：原样保留
      out.push(ch);
      missing++;
      continue;
    }
    for (const b of pair) out.push(b);
  }

  const bytes = Buffer.from(out);
  const fixed = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (fixed.includes('\uFFFD')) {
    console.error(`[fix-encoding] ${file} 还原后仍含 U+FFFD，说明不是这一种损坏，拒绝改写。`);
    process.exitCode = 1;
    continue;
  }

  writeFileSync(file, fixed, 'utf8');
  console.log(
    `[fix-encoding] ${file} 已还原（${current.length} 字符，查表未命中的字符 ${missing} 个）`,
  );
}

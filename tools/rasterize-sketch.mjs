/**
 * tools/rasterize-sketch.mjs
 * 把任意浏览器能显示的手绘草图（WebP / JPEG / …）转成 **PNG**。
 *
 * ## 为什么需要
 *
 * `sketch-open-path.mjs` 里那个最小 PNG 解码器只支持 PNG
 * （8bit、非隔行、灰度/RGB/RGBA）。玩家发来的草图有时是 WebP，
 * 直接喂进去会报 "不是 PNG 文件"。
 *
 * 本仓库已经有 playwright（e2e 用），所以不引入新依赖：
 * 用一个 headless 浏览器把图画到 canvas 上再导出 PNG。
 *
 * 用法：
 *   node tools/rasterize-sketch.mjs <输入> <输出.png>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node tools/rasterize-sketch.mjs <输入图片> <输出.png>');
  process.exit(1);
}

const buf = readFileSync(input);
const ext = input.slice(input.lastIndexOf('.') + 1).toLowerCase();
const mime =
  ext === 'webp'
    ? 'image/webp'
    : ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'gif'
        ? 'image/gif'
        : 'image/png';

const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    // 先铺白底：透明背景的草图（PNG/WebP 常见）在后续二值化里会被当成"深色"
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return { data: canvas.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight };
  }, dataUrl);

  const base64 = result.data.slice(result.data.indexOf(',') + 1);
  writeFileSync(output, Buffer.from(base64, 'base64'));
  console.log(`[rasterize] ${input} (${mime}) ${result.w}×${result.h} → ${output}`);
} finally {
  await browser.close();
}

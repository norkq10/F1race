/**
 * tools/preview-assets.mjs
 * 把占位素材放大后拼成一张预览图，方便人工检查像素画是否正确。
 * 产出：tools/out/preview.png
 *
 * 运行：node tools/preview-assets.mjs
 */

import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { PixelCanvas } from './png.mjs';

/** 解码本仓库自产的 PNG（8bit RGBA、filter 0）。 */
function decodePNG(file) {
  const buf = readFileSync(file);
  let pos = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const dest = Buffer.from(out.buffer, y * stride, stride);
    const srcStart = y * (stride + 1) + 1;
    raw.copy(dest, 0, srcStart, srcStart + stride);
  }
  return { width: w, height: h, data: out };
}

function scale(img, s) {
  const c = new PixelCanvas(img.width * s, img.height * s);
  for (let y = 0; y < img.height * s; y++) {
    for (let x = 0; x < img.width * s; x++) {
      const sx = Math.floor(x / s);
      const sy = Math.floor(y / s);
      const i = (sy * img.width + sx) * 4;
      c.set(x, y, [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]);
    }
  }
  return c;
}

const SCALE = 5;
const GAP = 24;

/**
 * 瓦片集拉成一长条在预览图里会被压得看不清，所以按每行 8 张拆成多行摆放。
 * （当前是 8 张草地瓦片，正好一行；perRow 保留参数化是为了将来加瓦片不用改这里。）
 */
const TILES_PER_ROW = 8;

function layoutTilesheet(img, scale, perRow) {
  const tileSize = 32;
  const count = Math.round(img.width / tileSize);
  const rows = Math.ceil(count / perRow);
  const cell = tileSize * scale;
  const sheet = new PixelCanvas(perRow * cell, rows * cell);
  sheet.clear([28, 30, 36]);
  for (let i = 0; i < count; i++) {
    const srcX = i * tileSize;
    const destX = (i % perRow) * cell;
    const destY = Math.floor(i / perRow) * cell;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const si = (y * img.width + srcX + x) * 4;
        if (img.data[si + 3] === 0) continue;
        const color = [img.data[si], img.data[si + 1], img.data[si + 2], img.data[si + 3]];
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            sheet.set(destX + x * scale + sx, destY + y * scale + sy, color);
          }
        }
      }
    }
  }
  return sheet;
}

const tiles = layoutTilesheet(decodePNG('public/assets/tiles/tileset_placeholder.png'), SCALE, TILES_PER_ROW);
const carFiles = ['car_player', 'car_ai', 'car_ghost'];
const cars = carFiles.map((n) => scale(decodePNG(`public/assets/cars/${n}_placeholder.png`), SCALE));

const carsWidth = cars.reduce((a, c) => a + c.width, 0) + GAP * (cars.length - 1);
const width = Math.max(tiles.width, carsWidth);
const height = tiles.height + GAP + Math.max(...cars.map((c) => c.height));

const sheet = new PixelCanvas(width, height);
sheet.clear([28, 30, 36]);
sheet.blit(tiles, 0, 0);
let x = 0;
for (const car of cars) {
  sheet.blit(car, x, tiles.height + GAP);
  x += car.width + GAP;
}
sheet.save('tools/out/preview.png');
console.log(`[preview-assets] tools/out/preview.png (${width}x${height}, ${SCALE}x)`);

/**
 * tools/png.mjs
 * F1race 占位素材生成器使用的极小 PNG 编码器 (RGBA / 8bit / 无压缩滤波)。
 * 只用 node 内置 zlib，避免引入任何第三方依赖。
 */

import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 把 RGBA 像素缓冲编码为 PNG。
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度必须为 width*height*4
 * @returns {Buffer}
 */
export function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 简易像素画布，坐标原点在左上角。 */
export class PixelCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4); // 默认全透明
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return this;
    const i = (y * this.width + x) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = color.length > 3 ? color[3] : 255;
    return this;
  }

  fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
    }
    return this;
  }

  /** 用颜色填充整张画布（含 alpha 覆盖）。 */
  clear(color) {
    return this.fillRect(0, 0, this.width, this.height, color);
  }

  /** 把另一张画布叠加到 (dx,dy)，仅写入非全透明像素。 */
  blit(src, dx, dy) {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        if (src.data[i + 3] === 0) continue;
        this.set(dx + x, dy + y, [
          src.data[i],
          src.data[i + 1],
          src.data[i + 2],
          src.data[i + 3],
        ]);
      }
    }
    return this;
  }

  toPNG() {
    return encodePNG(this.width, this.height, this.data);
  }

  save(file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, this.toPNG());
    return file;
  }
}

/** 确定性 PRNG，保证每次生成的占位素材完全一致。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 颜色微调（用于生成像素噪点）。 */
export function shade(color, amount) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(color[0] + amount), clamp(color[1] + amount), clamp(color[2] + amount), color.length > 3 ? color[3] : 255];
}

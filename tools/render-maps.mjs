/**
 * tools/render-maps.mjs
 * 把每条赛道的瓦片地图（ground + track + decor 层）渲染成一张缩略总览图，
 * 并叠加中心线采样点，用来肉眼检查赛道形状、起跑线位置与走线是否合理。
 *
 * 运行：node tools/render-maps.mjs [赛道id ...]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { TRACKS } from './gen-track.mjs';
import { PixelCanvas } from './png.mjs';

const TILE = 32;
const SCALE = 4; // 每个瓦片画成 4x4 像素
const OUT_DIR = 'tools/screenshots';

/** 与 gen-assets.mjs 一致的配色（缩略图用同一套看起来才像游戏内） */
const COLORS = {
  1: [64, 124, 60], // grassA
  2: [50, 104, 50], // grassB
  3: [78, 78, 86], // asphalt
  4: [198, 52, 46], // kerb
  5: [226, 226, 226], // startline
  6: [122, 128, 138], // wall
  7: [34, 86, 42], // tree
  8: [26, 26, 30], // tire
};

const ids = process.argv.slice(2);
// 默认渲染**全部**已登记的赛道（从生成器取清单，避免这里再手写一份会漂移的列表）
const trackIds = ids.length > 0 ? ids : TRACKS.map((t) => t.id);

mkdirSync(OUT_DIR, { recursive: true });

for (const id of trackIds) {
  const map = JSON.parse(readFileSync(`public/assets/maps/${id}.json`, 'utf8'));
  const meta = JSON.parse(readFileSync(`public/assets/maps/${id}.meta.json`, 'utf8'));
  const W = map.width;
  const H = map.height;

  const canvas = new PixelCanvas(W * SCALE, H * SCALE);
  const layers = Object.fromEntries(map.layers.map((l) => [l.name, l.data]));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      // 从上到下合成：ground → track → decor → walls
      for (const name of ['ground', 'track', 'decor', 'walls']) {
        const gid = layers[name][idx];
        if (!gid) continue;
        const color = COLORS[gid] ?? [255, 0, 255];
        canvas.fillRect(x * SCALE, y * SCALE, SCALE, SCALE, color);
      }
    }
  }

  // 叠加中心线（黄色）与起跑线位置（亮青）
  const pts = meta.centerline.points;
  for (const [wx, wy] of pts) {
    const px = Math.round(wx / TILE) * 1;
    const py = Math.round(wy / TILE) * 1;
    canvas.fillRect(px * SCALE, py * SCALE, 2, 2, [255, 214, 64]);
  }
  const startX = Math.round(meta.start.x / TILE);
  const startY = Math.round(meta.start.y / TILE);
  canvas.fillRect(startX * SCALE - 4, startY * SCALE - 4, 8, 8, [0, 255, 255]);

  const file = `${OUT_DIR}/map-${id}.png`;
  canvas.save(file);
  console.log(
    `[render-maps] ${id}（${meta.name}）-> ${file}  ${W}x${H} 瓦片，` +
      `中心线 ${Math.round(meta.centerline.totalLength)}px，采样 ${pts.length} 点`,
  );
}

/** 把每条赛道写进一张对照表，方便一眼比较长度与最急弯。 */
const rows = trackIds.map((id) => {
  const meta = JSON.parse(readFileSync(`public/assets/maps/${id}.meta.json`, 'utf8'));
  return { id, name: meta.name, length: meta.centerline.totalLength, grid: meta.grid };
});
writeFileSync(`${OUT_DIR}/map-summary.json`, JSON.stringify(rows, null, 2));

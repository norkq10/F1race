/**
 * tools/gen-assets.mjs
 * 生成 F1race 全部程序化像素占位素材（PNG），可被同名正式素材直接替换。
 *
 * 命名规范见 docs/placeholder-assets.md：
 *   public/assets/<类别>/<名称>_placeholder.png
 *
 * 运行：node tools/gen-assets.mjs
 */

import { PixelCanvas, mulberry32, shade } from './png.mjs';

const TILE = 32;
const OUT_TILES = 'public/assets/tiles/tileset_placeholder.png';
const OUT_CARS = (name) => `public/assets/cars/${name}_placeholder.png`;

// ---------------------------------------------------------------- 调色板

const GRASS_A = [64, 124, 60];
const GRASS_B = [50, 104, 50];
const ASPHALT = [78, 78, 86];
const KERB_RED = [198, 52, 46];
const KERB_WHITE = [232, 228, 218];
const LINE_WHITE = [226, 226, 226];
const LINE_DARK = [40, 40, 46];
const WALL_BODY = [122, 128, 138];
const WALL_HI = [170, 176, 186];
const WALL_LO = [78, 82, 92];
const WALL_EDGE = [46, 48, 56];

// ---------------------------------------------------------------- 瓦片

function tileGrass(base, seed) {
  const c = new PixelCanvas(TILE, TILE);
  const rnd = mulberry32(seed);
  c.clear(base);
  // 像素噪点，避免大片纯色
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const r = rnd();
      if (r < 0.16) c.set(x, y, shade(base, -14));
      else if (r < 0.3) c.set(x, y, shade(base, 12));
    }
  }
  // 几簇草叶
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(rnd() * (TILE - 3)) + 1;
    const y = Math.floor(rnd() * (TILE - 4)) + 2;
    const col = shade(base, 22);
    c.set(x, y, col).set(x, y - 1, col).set(x + 1, y - 1, col);
  }
  return c;
}

function tileAsphalt() {
  const c = new PixelCanvas(TILE, TILE);
  const rnd = mulberry32(9917);
  c.clear(ASPHALT);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const r = rnd();
      if (r < 0.2) c.set(x, y, shade(ASPHALT, -10));
      else if (r < 0.32) c.set(x, y, shade(ASPHALT, 9));
    }
  }
  return c;
}

function tileKerb() {
  const c = new PixelCanvas(TILE, TILE);
  const rnd = mulberry32(4242);
  const cell = 16; // 红白方块交替，任何朝向下都能读出"路肩"
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const check = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const base = check ? KERB_RED : KERB_WHITE;
      c.set(x, y, rnd() < 0.1 ? shade(base, -12) : base); // 轻微脏化，避免呆板
    }
  }
  return c;
}

function tileStartLine() {
  const c = new PixelCanvas(TILE, TILE);
  const cell = 8;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const check = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      c.set(x, y, check ? LINE_WHITE : LINE_DARK);
    }
  }
  return c;
}

function tileWall() {
  const c = new PixelCanvas(TILE, TILE);
  c.clear(WALL_BODY);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (y < 5) c.set(x, y, WALL_HI);
      else if (y > TILE - 6) c.set(x, y, WALL_LO);
    }
  }
  for (let x = 0; x < TILE; x++) {
    c.set(x, 0, WALL_EDGE).set(x, TILE - 1, WALL_EDGE);
  }
  for (let y = 0; y < TILE; y++) {
    c.set(0, y, WALL_EDGE).set(TILE - 1, y, WALL_EDGE);
  }
  // 每 16px 一条竖缝，形成护栏分块
  for (let y = 1; y < TILE - 1; y++) {
    c.set(16, y, WALL_EDGE);
  }
  return c;
}

function tileTree() {
  const c = new PixelCanvas(TILE, TILE);
  // 树干
  c.fillRect(14, 22, 4, 10, [74, 52, 32]);
  // 树冠
  const canopy = [34, 86, 42];
  const mid = [46, 110, 52];
  const hi = [66, 140, 66];
  const shape = [
    [12, 4, 8], [10, 6, 12], [8, 8, 16], [7, 10, 18], [6, 12, 20], [6, 16, 20], [7, 20, 18], [9, 24, 14],
  ];
  for (const [x, y, w] of shape) c.fillRect(x, y, w, 4, canopy);
  for (const [x, y, w] of shape) c.fillRect(x + 1, y, w - 2, 2, mid);
  c.fillRect(10, 8, 6, 4, hi);
  c.fillRect(9, 14, 4, 3, hi);
  c.fillRect(17, 12, 5, 3, hi);
  return c;
}

function tileTire() {
  const c = new PixelCanvas(TILE, TILE);
  const drawTire = (cx, cy) => {
    c.fillRect(cx, cy, 14, 8, [26, 26, 30]);
    c.fillRect(cx, cy + 1, 14, 2, [58, 58, 64]);
    c.fillRect(cx + 3, cy + 3, 8, 3, [16, 16, 18]);
    c.fillRect(cx + 1, cy, 12, 1, [44, 44, 50]);
  };
  drawTire(9, 20);
  drawTire(9, 12);
  drawTire(9, 4);
  return c;
}
/**
 * 瓦片集。
 *
 * 索引顺序就是 Tiled 的 gid（从 1 开始），**必须**和 tools/gen-track.mjs 里的 T 表一致。
 */
const TILE_ORDER = ['grassA', 'grassB', 'asphalt', 'kerb', 'startline', 'wall', 'tree', 'tire'];

function buildTileset(file) {
  const tiles = [
    tileGrass(GRASS_A, 1301),
    tileGrass(GRASS_B, 7702),
    tileAsphalt(),
    tileKerb(),
    tileStartLine(),
    tileWall(),
    tileTree(),
    tileTire(),
  ];
  const sheet = new PixelCanvas(TILE * tiles.length, TILE);
  tiles.forEach((t, i) => sheet.blit(t, i * TILE, 0));
  sheet.save(file);

  /** gid 表（1 基），供 gen-track.mjs 引用。 */
  const gids = {};
  TILE_ORDER.forEach((name, i) => {
    gids[name] = i + 1;
  });
  return { file, count: tiles.length, tileSize: TILE, gids };
}

// ---------------------------------------------------------------- 车辆

/**
 * 生成一张 28x42 的俯视像素赛车（车头朝上 / 北方）。
 * @param {string} file
 * @param {{body:number[], dark:number[], light:number[], accent:number[]}} c
 */
function buildCar(file, c) {
  const W = 28;
  const H = 42;
  const cv = new PixelCanvas(W, H);
  const tire = [40, 40, 46];
  const tireHi = [78, 78, 86];

  const wheel = (x, y, w, h) => {
    cv.fillRect(x, y, w, h, tire);
    cv.fillRect(x, y, w, 1, tireHi);
  };

  // 尾翼
  cv.fillRect(1, 37, 26, 5, c.dark);
  cv.fillRect(2, 36, 24, 2, c.body);
  cv.fillRect(1, 41, 26, 1, [18, 18, 22]);

  // 后轮
  wheel(0, 27, 6, 11);
  wheel(22, 27, 6, 11);

  // 车体主体（侧箱）
  cv.fillRect(6, 18, 16, 16, c.body);
  cv.fillRect(6, 18, 16, 2, c.light);
  cv.fillRect(6, 32, 16, 2, c.dark);
  cv.fillRect(6, 18, 2, 16, c.dark);
  cv.fillRect(20, 18, 2, 16, c.dark);

  // 座舱
  cv.fillRect(11, 13, 6, 13, [32, 34, 40]);
  cv.fillRect(12, 14, 4, 4, [96, 104, 120]);
  cv.fillRect(13, 15, 2, 2, c.accent);

  // 前鼻锥
  cv.fillRect(11, 8, 6, 6, c.body);
  cv.fillRect(12, 5, 4, 4, c.body);
  cv.fillRect(12, 5, 4, 1, c.light);

  // 前轮
  wheel(0, 9, 5, 9);
  wheel(23, 9, 5, 9);

  // 前翼
  cv.fillRect(1, 2, 26, 4, c.dark);
  cv.fillRect(1, 2, 26, 2, c.body);

  // 车身中线条纹
  cv.fillRect(13, 6, 2, 12, c.accent);
  cv.fillRect(12, 34, 4, 3, c.accent);

  cv.save(file);
  return file;
}

const CAR_PALETTES = {
  car_player: {
    body: [206, 42, 40],
    dark: [140, 26, 26],
    light: [242, 96, 88],
    accent: [246, 246, 240],
  },
  car_ai: {
    body: [44, 92, 214],
    dark: [26, 56, 146],
    light: [96, 146, 244],
    accent: [246, 246, 240],
  },
  car_ghost: {
    body: [110, 226, 226],
    dark: [58, 150, 152],
    light: [186, 250, 250],
    accent: [246, 246, 240],
  },
};

/**
 * 玩家皮肤配色（CR-15）。
 *
 * 键必须与 `src/game/Skins.ts` 的 `assetSuffix` 一一对应 ——
 * 改这里必须同步改那边，否则车库会指向不存在的贴图。
 *
 * 每款只换颜色，**形状完全一致**：皮肤不能带来任何性能差异，
 * 连"看起来更小"的错觉都不该有（28×42 的像素布局与默认款逐位相同，
 * 因为都走同一个 `buildCar`）。
 */
const SKIN_PALETTES = {
  default: {
    body: [206, 42, 40],
    dark: [140, 26, 26],
    light: [242, 96, 88],
    accent: [246, 246, 240],
  },
  red: {
    body: [232, 32, 28],
    dark: [150, 16, 14],
    light: [255, 104, 92],
    accent: [255, 236, 120],
  },
  blue: {
    body: [28, 78, 208],
    dark: [14, 44, 132],
    light: [88, 140, 246],
    accent: [220, 232, 255],
  },
  carbon: {
    body: [44, 46, 52],
    dark: [22, 23, 27],
    light: [92, 96, 106],
    accent: [196, 200, 210],
  },
  ghost: {
    body: [214, 232, 240],
    dark: [150, 172, 184],
    light: [248, 253, 255],
    accent: [186, 236, 255],
  },
  gold: {
    body: [214, 168, 42],
    dark: [146, 106, 14],
    light: [252, 222, 118],
    accent: [120, 82, 12],
  },
};

/** 玩家皮肤贴图路径：`public/assets/cars/player_<skinId>.png`。 */
const OUT_SKINS = (suffix) => `public/assets/cars/player_${suffix}.png`;

// ---------------------------------------------------------------- main

const written = [];
const tileset = buildTileset(OUT_TILES);
written.push(tileset.file);
for (const [name, palette] of Object.entries(CAR_PALETTES)) {
  written.push(buildCar(OUT_CARS(name), palette));
}
// CR-15：每款皮肤一张贴图。数量少、体积小，BootScene 一次性全载入，
// 切皮肤就不用再走一遍加载流程（也不会出现"换皮肤黑一帧"）。
for (const [suffix, palette] of Object.entries(SKIN_PALETTES)) {
  written.push(buildCar(OUT_SKINS(suffix), palette));
}

console.log('[gen-assets] 已生成占位素材：');
for (const f of written) console.log('  - ' + f);
console.log(`[gen-assets] 瓦片集 ${tileset.count} 张`);
console.log(
  `[gen-assets] 皮肤贴图 ${Object.keys(SKIN_PALETTES).length} 张：${Object.keys(SKIN_PALETTES).join(' / ')}`,
);
console.log('  gid 表：' + Object.entries(tileset.gids).map(([k, v]) => `${k}=${v}`).join(' '));

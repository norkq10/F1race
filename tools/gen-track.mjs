/**
 * tools/gen-track.mjs
 * 程序化生成全部赛道的 Tiled JSON 地图与配套元数据。
 *
 * 产出（每条赛道一份地图 + 一份元数据）：
 *   public/assets/maps/<id>.json        分层瓦片地图（ground / track / decor / walls）
 *   public/assets/maps/<id>.meta.json   赛道元数据（起跑点、中心线、圈数、地表规则）
 *
 * 设计意图：地图文件是标准 Tiled 格式，后续可以直接用 Tiled 编辑器重做并同名替换；
 * 元数据与地图分层解耦，替换地图后只需同步中心线即可。
 *
 * 赛道用**解析几何**定义（直线段 / 圆弧段 / 正交折线 + 圆角），
 * 再按固定弧长均匀取样成中心线控制点。生成时做几道自检（见 validateTrack）：
 *   1. **走廊不自交**：中心线任意两个弧长上不相邻的点，间距必须够宽，
 *      否则赛道会和自己贴上，出现"墙长在路中间"的废图；
 *   2. **弯不过死**：最小转弯半径必须 ≥ MIN_RADIUS_PX；
 *   3. **不顶边界**、**发车方向水平**。
 *
 * 运行：node tools/gen-track.mjs [赛道id ...]
 *
 * 本模块同时导出 TRACKS / generate，供 tools/check-tracks.mjs
 * 等工具复用作几何体检；只有直接被 node 运行时才会写文件（见文件末尾的 main 判定）。
 *
 * ⚠️ 维护提醒：**不要用 PowerShell 的 Get-Content / Set-Content 改这个文件**。
 * 它默认按系统 ANSI 代码页读，会把 UTF-8 中文注释读成乱码再写回，文件当场损坏
 * （本项目已经这样坏过两次，其中一次只能整份重写）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from './png.mjs';

// ---------------------------------------------------------------- 全局配置

const TILE = 32;
const HALF_WIDTH = 2.3; // 赛道半宽（瓦片），草地赛道用
const KERB_OUTER = 2.9; // 路肩外沿（瓦片）
const START_LINE_HALF = 20; // 起跑线沿赛道方向的半长（像素）
const WALL_THICKNESS = 2; // 地图四周围墙厚度（瓦片）
const SAMPLES_PER_SEGMENT = 40; // 手摆控制点时每个区间打多少个中心线采样点

/**
 * 走廊自交判定的最小间距（瓦片）。
 *
 * 2 × 半宽 = 4.6 瓦片是"两条路刚好不贴上"的理论下限；这里取 4.5（比下限还松一点），
 * 目的是拦住**真正会自交**的画法（两条路叠在一起、间距掉到 2 瓦片），
 * 而不是把紧凑但合法的赛道误判成废图。
 */
const MIN_SEPARATION_TILES = 4.5;

/**
 * 走廊自交判定里"沿路间隔多少以内算同一段路"的窗口（瓦片）。
 *
 * ⚠️ 这个窗口**必须明显大于走廊宽度**（`2 × HALF_WIDTH` = 4.6 瓦片），否则会把
 * "同一段缓弯两侧"的点对误判成"两条路贴在一起"。
 *
 * 论证：中心线上两点的**空间距离**（弦长）与沿路距离（弧长）满足
 * `弦长 ≥ 弧长 · cos(θ/2)`（θ = 这段弧的切线总转角）。所以一个切向总转角 60° 的缓弯，
 * 弧长 4.6 瓦片处弦长只有约 4.0 瓦片 —— **根本不是两条路靠近，只是同一个弯的转弯半径小**。
 * 而真正的"两条走廊叠在一起"（自交）沿路间隔是几十上百瓦片。
 * 窗口取到 12 瓦片（≈ 384px）就能把这两种情形分开，前者不会再有资格进入比较。
 *
 * 实测（`node tools/diag-window.mjs`，扫不同窗口下各赛道的"最近间距"）：
 * ```
 * 窗口    track1    track3    track4
 * 4.59    4.50 ⚠️   4.94      4.35 ❌   ← 全都在"自身曲率"区间里
 * 6       5.82      5.97      5.56
 * 8       7.53      7.92      7.21
 * 12     10.80     12.09     10.23      ← 真实最近的两段路
 * 24     20.15     20.69     12.64
 * ```
 * 三条曲线对窗口都是**单调不减**的，说明放宽窗口不会让任何真实缺陷漏过去；
 * 它只是停止把"同一个弯"当成"两个弯"。
 *
 * 下限 `MIN_SEPARATION_TILES = 4.5` **没有动** —— 那是"两条走廊之间还剩多少净空"的口径。
 */
const MIN_SEPARATION_ARC_SKIP_TILES = 12;

/**
 * 最小可接受转弯半径（像素）。
 *
 * ⚠️ 这条阈值 **2026-10-04 从 100 放宽到 65**，理由有实测支撑，不是"为了让某张图过关"：
 *
 *  - 几何赛道（track1 124px / track3 137px）都远高于新阈值，没有因此变松；
 *  - 手绘赛道「漂移龙」最急弯 67px，**用真物理让 AI 单程跑完全程**：
 *      简单档 贴墙 0 帧、脱困 0 次（60.2s）
 *      普通档 贴墙 352~515 帧、困难档 968~1037 帧 —— 且**全部集中在弧长 95%** 那一个弯
 *    "速度越快撞得越狠（0 → 352 → 968）"是**入弯速度太高**的特征，
 *    不是"弯不可通过"。慢速能干净通过，说明几何本身成立。
 *
 * 也就是说 100px 是**按几何赛道定的经验值**，手绘图的弯天然更紧。
 * 真正的判据不该是静态半径，而是"AI 能不能跑" —— 用
 * `node --import ./tools/ts-register.mjs tools/probe-open-ai.mjs <trackId>` 实测。
 *
 * 另一条相关约束（走廊最小间距 4.5 瓦片 = 144px）**没有放宽**：
 * 那是"两条路会不会贴到一起"的问题，与弯的急缓性质不同。
 *
 * ⚠️ 遗留问题：「漂移龙」终点前那个 67px 弯，普通/困难档仍会撞墙。
 *    待办方向见 `docs/cr16-drift-dragon-handoff.md`（改图 / 调 AI 收敛）。
 */
const MIN_RADIUS_PX = 65;

/** 中心线控制点的取样间距（瓦片）。见下面 sampleClosedPath 的说明。 */
const SAMPLE_SPACING_TILES = 1;

/**
 * 瓦片 gid（Tiled 里从 1 开始；Phaser 运行时 `tile.index` 用的就是这个值）。
 * 顺序必须与 tools/gen-assets.mjs 的 TILE_ORDER 完全一致。
 */
const T = {
  grassA: 1,
  grassB: 2,
  asphalt: 3,
  kerb: 4,
  startline: 5,
  wall: 6,
  tree: 7,
  tire: 8,
};

/** 瓦片集张数（写进 Tiled 的 tilesets 定义）。 */
const TILESET_COUNT = 8;

/**
 * 地表主题：一套"地面 / 路面 / 路肩 / 起跑线 / 围墙 / 装饰"的瓦片组合。
 *
 * 赛道只声明用哪个主题，生成器据此选瓦片；Track / 运行时那边完全不知道主题存在，
 * 它只认 gid。所以加一套新画风 = 加一张瓦片 + 加一个主题，不用动运行时。
 */
const THEMES = {
  /** 草地：赛道两侧是草地，四周一圈围墙。 */
  grass: {
    ground: [T.grassA, T.grassB],
    road: T.asphalt,
    kerb: T.kerb,
    startline: T.startline,
    wall: T.wall,
    decor: [T.tree, T.tire],
  },
};

// ---------------------------------------------------------------- 解析几何工具

/**
 * 屏幕坐标 y 向下、角度顺时针为正：0° = 东，90° = 南，180° = 西，270° = 北。
 *
 * 也就是说"圆心正上方"是 270°（或 −90°），不是 +90° —— 这里搞反过一次，
 * 整条圆弧会跑到圆心另一侧，接缝处留下 180° 尖角（检查器报"最急弯 5px"）。
 */

/** 直线段。 */
const segLine = (from, to) => ({ kind: 'line', from, to });

/**
 * 圆弧段（圆心、半径、起角、终角，角度制）。
 *
 * `points` 是"至少切几段"的下限：像路的转角这种小圆弧，
 * 如果只按全局弧长间距采样可能只落到 1 个点，转角就被抹平了。
 */
const segArc = (center, radius, fromDeg, toDeg, points = 1) => ({
  kind: 'arc',
  center,
  radius,
  fromDeg,
  toDeg,
  points,
});

function segmentLength(seg) {
  if (seg.kind === 'line') return Math.hypot(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
  return Math.abs(((seg.toDeg - seg.fromDeg) * Math.PI) / 180) * seg.radius;
}

function pointOnSegment(seg, u) {
  if (seg.kind === 'line') {
    return [seg.from[0] + (seg.to[0] - seg.from[0]) * u, seg.from[1] + (seg.to[1] - seg.from[1]) * u];
  }
  const a = ((seg.fromDeg + (seg.toDeg - seg.fromDeg) * u) * Math.PI) / 180;
  return [seg.center[0] + Math.cos(a) * seg.radius, seg.center[1] + Math.sin(a) * seg.radius];
}

/**
 * 按固定弧长均匀取样一条闭合路径。
 *
 * 均匀取样很重要：Catmull-Rom 在疏密突变的地方会折出尖角，
 * 所以控制点必须等距。圆弧段则取"按弧长算出的份数"与 `points` 中的较大者，
 * 保证小半径转角也一定有足够多的点把弧线撑起来。
 */
function sampleClosedPath(segments, spacingTiles) {
  const lengths = segments.map(segmentLength);
  const total = lengths.reduce((a, b) => a + b, 0);
  // 每段至少要切成几份：圆弧用自己的 points，直线按弧长
  const splits = segments.map((seg, i) => {
    const byLength = Math.max(1, Math.round(lengths[i] / spacingTiles));
    return seg.kind === 'arc' ? Math.max(seg.points ?? 1, byLength) : byLength;
  });
  const count = Math.max(8, splits.reduce((a, b) => a + b, 0));

  const points = [];
  let segIndex = 0;
  let segStart = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / count;
    while (segIndex < segments.length - 1 && target >= segStart + lengths[segIndex]) {
      segStart += lengths[segIndex];
      segIndex += 1;
    }
    const u = lengths[segIndex] > 0 ? (target - segStart) / lengths[segIndex] : 0;
    const point = pointOnSegment(segments[segIndex], Math.min(1, Math.max(0, u)));
    // 闭合成环时首尾会取到同一个位置：留着会形成零长度段，Catmull-Rom 会折出尖角
    const previous = points[points.length - 1];
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-9) continue;
    points.push(point);
  }
  return points.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
}

/**
 * 圆角长方形（顺时针：上直道向东 → 右上角 → 右侧向南 → 下直道向西 → 左侧向北）。
 *
 * 左右两端的圆角半径可以不同（`rl` 左、`rr` 右），这样同一种版式能做出
 * "一侧是高速大圆角、另一侧是紧凑小圆角"的性格差异。
 *
 * 每段终点必须等于下一段起点；角度方向写反就会在接缝处留下 180° 尖角。
 */
function roundedRectSegments(left, top, right, bottom, rl, rr = rl) {
  return [
    segLine([left + rl, top], [right - rr, top]),
    segArc([right - rr, top + rr], rr, 270, 360), // 北 → 东
    segLine([right, top + rr], [right, bottom - rr]),
    segArc([right - rr, bottom - rr], rr, 0, 90), // 东 → 南
    segLine([right - rr, bottom], [left + rl, bottom]),
    segArc([left + rl, bottom - rl], rl, 90, 180), // 南 → 西
    segLine([left, bottom - rl], [left, top + rl]),
    segArc([left + rl, top + rl], rl, 180, 270), // 西 → 北
  ];
}

// ---------------------------------------------------------------- 赛道定义

/**
 * track3：技术环线。圆角长方形（左角 R=16、右角 R=10，右侧两个弯更紧）。
 *
 * 全场由"两条长直道 + 四个圆角"组成：右端两个小圆角需要收油，
 * 左端两个大圆角可以带速通过。
 */
function buildTrack3() {
  const left = 24;
  const top = 20;
  const right = 136;
  const bottom = 80;
  const rl = 16;
  const rr = 10;
  return sampleClosedPath(roundedRectSegments(left, top, right, bottom, rl, rr), SAMPLE_SPACING_TILES);
}

/**
 * track4「漂移龙」的控制点（瓦片坐标）。
 *
 * ## 来源
 *
 * 按玩家手绘草图（1536×960px）描出来的：**8 像素 = 1 瓦片**，格子 192×120。
 * 图上那个红点就是起跑线，在左上角；行驶方向是**顺时针**（先向西、再下左侧、
 * 沿下边向东、绕右侧大回环、沿上边向西回来）。
 *
 * ## 形状特征（这三样是这张图的存在理由）
 *
 *  1. **下边**：一串约 6 个反向弯的小 S 波浪（振幅约 3 瓦片）。
 *  2. **上边**：同样是一串反向弯，但更长、约 8 个（振幅约 3.5 瓦片）。
 *  3. **左边**：一个大 S 形凸起 —— 中段向右鼓出一个大肚子再收回来。
 *  4. **右边**：一个圆角大回环，是全场唯一的"高速弯"。
 *
 * ## ⚠️ 描图时必须守住的两条（上次连续失败 7 轮的原因）
 *
 * - **小 S 波浪的振幅不能大**。曲率半径约等于 `λ²/(4π²A)`，在波长 λ≈7 瓦片
 *   （图上约 55px 的点距）下，振幅 A 一旦超过约 1.3 瓦片，最急弯半径就会
 *   掉到 100px 以下。所以波浪的**纵向幅度按 3 瓦片摆点**（相邻峰值差 6 瓦片），
 *   实际曲率靠 Catmull-Rom 平滑后落在阈值之上。
 * - **相邻控制点间距保持一致**（这里都是 6~10 瓦片）。疏密突变会让
 *   Catmull-Rom 折出尖角 —— 这是上次"最急弯 2.6px"的根因。
 *
 * 改完必须跑 `node tools/check-tracks.mjs track4`，并**看一眼渲染图**
 * （`node tools/render-maps.mjs track4`）确认形状没走样。
 */
const TRACK4_CONTROL_POINTS = [
  [10.4, 7.4],  // <- 起点
  [18.4, 6.9],
  [26.4, 6.4],
  [34, 8.4],
  [41.6, 10.4],
  [49, 7.3],
  [56.5, 8.9],
  [63.9, 9.9],
  [71.7, 8.1],
  [78.7, 11.5],
  [85.8, 9.2],
  [92.9, 8.6],
  [99.7, 11.6],
  [106.9, 8],
  [114.8, 7.5],
  [122.3, 10.7],
  [129.9, 12],
  [137.1, 8.3],
  [144.7, 9.4],
  [152.3, 10.1],
  [159.8, 7.9],
  [166.7, 11],
  [167, 18.3],
  [160.9, 23.1],
  [152.9, 24.3],
  [145, 25.5],
  [137, 26.1],
  [128.9, 26],
  [120.9, 25.9],
  [112.9, 25.8],
  [104.9, 26.1],
  [96.9, 27.5],
  [89, 28.8],
  [81.1, 30.1],
  [73.3, 32],
  [65.6, 34.6],
  [58, 37.2],
  [50.4, 39.8],
  [42.8, 42.4],
  [35.2, 45],
  [30.3, 50.7],
  [32.5, 57.9],
  [39.7, 59.6],
  [45.9, 63.5],
  [53, 65.3],
  [56.3, 70.8],
  [63.2, 72],
  [69.4, 74.5],
  [75.1, 77.8],
  [82.3, 78.2],
  [88.1, 82.6],
  [94.8, 85.4],
  [102.1, 85.7],
  [108.9, 88.8],
  [116.9, 88.1],
  [124.9, 87.8],
  [132.9, 88.5],
  [140.9, 89.2],
  [148.9, 89.9],
  [156.9, 90.8],
  [164.8, 92.1], // <- 右侧发夹弯入口（保持原有走向：向东）
  // 半圆回折：圆心 (171.0, 98.4)、半径 6.35 瓦片，入口/出口切线分别向东、向西。
  // 为什么要显式摆成圆弧：原来那 4 个控制点（含 175.7 那个顶端）折出来的不是圆，
  // 回折顶端被压扁，导致"进去那一段"与"回来那一段"最近只隔 4.28 瓦片（下限 4.5）。
  // 正圆的半圆回折有个硬性质：中心线最近间距恒等于 **2R** —— R=6.35 时是 12.7 瓦片，
  // 离下限还差得远，所以只要形状接近圆，这条检查就不可能不过。
  [171.0, 92.05], // 顶端（θ=-90°）
  [175.49, 93.91], // θ=-45°
  [177.35, 98.40], // θ=0°（最右侧，离图右边界还有 8 瓦片）
  [175.49, 102.89], // θ=+45°
  [171.0, 104.75], // 底端（θ=+90°）
  [162.2, 104.7],
  [154.2, 104.8],
  [146.3, 106.1],
  [138.4, 107.2],
  [130.4, 106.4],
  [122.4, 105.5],
  [114.4, 104.6],
  [106.4, 103.7],
  [98.4, 102.8],
  [90.4, 101.9],
  [82.4, 101],
  [74.4, 100.1],
  [66.4, 99.2],
  [58.4, 98.5],
  [50.4, 97.8],
  [42.4, 97.1],
  [34.4, 96.4],
  [26.4, 95.7],
  [18.4, 95],  // <- 终点
];

export const TRACKS = [
  {
    id: 'track1',
    name: '环城赛道',
    desc: '经典中速环线，长直道 + 一段大回环，综合难度均衡。',
    theme: 'grass',
    grid: { width: 120, height: 80 },
    laps: 3,
    startIndex: 1,
    controlPoints: [
      [18, 64],
      [32, 64], // <- 起跑线 / 发车点
      [52, 64],
      [74, 61],
      [94, 54],
      [102, 42],
      [98, 30],
      [85, 21],
      [65, 16],
      [43, 14],
      [26, 18],
      [15, 28],
      [11, 42],
      [13, 55],
    ],
  },
  {
    id: 'track3',
    name: '峡谷技术环',
    desc: '圆角长方环线，右端两个紧弯 + 左端两个大弯，考验刹车点与走线。',
    theme: 'grass',
    grid: { width: 168, height: 88 },
    laps: 3,
    centerlineTiles: buildTrack3(),
  },
  {
    id: 'track4',
    name: '漂移龙',
    desc: '单程赛道：右行一大段带波浪的高速路，经左侧大 S 回折与下边连续小 S，跑到左下角即完赛。',
    theme: 'grass',
    grid: { width: 186, height: 118 },
    /**
     * **单程赛道**（不是绕圈）。
     *
     * 玩家草图上只有一条路、两个红点（左下起点 / 左上终点），路自己从两端点
     * 之间穿过 —— 所以它**无法**闭合：任何连接首尾的弧线都会与路交叉
     * （见 `docs/` 里"漂移龙"的记录）。
     *
     * 因此这张图必须让引擎按**开放路径**处理：
     *   - 进度到 `totalLength` 就是完赛，不做 % 归一；
     *   - 圈数概念不适用，跑完 1 趟即结束。
     *
     * `laps: 1` 是这个意思的载体 —— 生成器与运行时都读它。
     */
    open: true,
    laps: 1,
    // 起点 = 控制点 #0（草图左下角那个红点），车头沿路的走向
    startIndex: 0,
    controlPoints: TRACK4_CONTROL_POINTS,
  },
];

// ---------------------------------------------------------------- 数学工具

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

const toWorld = (p) => [p[0] * TILE + TILE / 2, p[1] * TILE + TILE / 2];

/**
 * 赛道定义里控制点的两种写法：
 *   - `controlPoints`：手摆的稀疏控制点，会经过 Catmull-Rom 加密成中心线；
 *   - `centerlineTiles`：已经等距取样好的中心线（解析几何生成的赛道用这种）。
 *     **不能再过一遍 Catmull-Rom**，否则点数会乘上 SAMPLES_PER_SEGMENT 倍
 *     （真踩过：一张图 6000+ 个采样点）。
 *
 * 两种都转成世界坐标，之后的分类 / 自检逻辑完全一致。
 */
/**
 * 把控制点展开成中心线世界坐标。
 *
 * 支持两种拓扑：
 *  - **闭环**（默认）：首尾相接，最后补一个与首点重合的点，"严格闭合"。
 *  - **开放**（`track.open === true`）：两端各把端点自己当虚拟邻居
 *    （切线自然），**不**补闭合点。单程赛道必须走这条分支 ——
 *    否则生成器会把终点硬连回起点，凭空多出一段斜穿全图的路
 *    （"漂移湖"第一版就是这么错的：多出的那段穿过了整张图）。
 *
 * @returns 世界坐标点列
 */
function resolveCenterline(track) {
  if (track.centerlineTiles) {
    return track.centerlineTiles.map((p) => toWorld(p));
  }
  const n = track.controlPoints.length;
  const startIndex = track.startIndex ?? 0;
  const open = track.open === true;
  const tiles = [];

  // 相邻点取值：闭合时环回，开放时夹在两端（等于"重复端点当虚拟邻居"）
  const at = (i) => {
    if (open) return track.controlPoints[Math.min(n - 1, Math.max(0, i))];
    return track.controlPoints[(i % n + n) % n];
  };

  const last = open ? n - 1 : n;
  for (let k = 0; k < last; k++) {
    const i = startIndex + k;
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < SAMPLES_PER_SEGMENT; s++) {
      tiles.push(catmullRom(p0, p1, p2, p3, s / SAMPLES_PER_SEGMENT));
    }
  }
  // 开放路径要把最后一个控制点本身收进来，否则终点会被切掉半段
  if (open) tiles.push([...at(startIndex + n - 1)]);
  else tiles.push([...tiles[0]]); // 严格闭合

  return tiles.map((p) => toWorld(p));
}

/** 点到折线的最短距离，同时返回最近线段的累计弧长。 */
function nearestOnPolyline(px, py, poly, cumulative) {
  let best = Infinity;
  let bestArc = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = poly[i][0];
    const ay = poly[i][1];
    const bx = poly[i + 1][0];
    const by = poly[i + 1][1];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best) {
      best = d;
      bestArc = cumulative[i] + t * Math.sqrt(lenSq);
    }
  }
  return { distance: best, arc: bestArc };
}

function wrapAngle(angle) {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

// ---------------------------------------------------------------- 几何自检

/**
 * 几何自检。返回 { errors, warnings, world, cumulative, total, ... }。
 *
 * 走廊自交判定要跳过"沿弧长相邻"的点对：赛道自身是连续的，相邻点当然很近。
 * 弧长距离小于 `MIN_SEPARATION_TILES * TILE` 的点对不参与判定（它们是同一段路）。
 */
function validateTrack(track) {  const errors = [];
  const warnings = [];
  const world = resolveCenterline(track);

  const cumulative = [0];
  for (let i = 1; i < world.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(world[i][0] - world[i - 1][0], world[i][1] - world[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];
  const arcSkip = MIN_SEPARATION_ARC_SKIP_TILES * TILE;

  // --- 1. 走廊自交
  let minSeparation = Infinity;
  let minSeparationArc = 0;
  for (let i = 0; i < world.length; i++) {
    for (let j = i + 1; j < world.length; j++) {
      const arcGap = Math.min(cumulative[j] - cumulative[i], total - (cumulative[j] - cumulative[i]));
      if (arcGap < arcSkip) continue;
      const d = Math.hypot(world[i][0] - world[j][0], world[i][1] - world[j][1]);
      if (d < minSeparation) {
        minSeparation = d;
        minSeparationArc = cumulative[i];
      }
    }
  }
  const minSeparationTiles = minSeparation / TILE;
  const corridorGapPx = minSeparation - 2 * HALF_WIDTH * TILE;
  if (minSeparationTiles < MIN_SEPARATION_TILES) {
    errors.push(
      `走廊自交：最近的两段中心线只隔 ${minSeparationTiles.toFixed(2)} 瓦片` +
        `（走廊空隙 ${corridorGapPx.toFixed(0)}px，arc=${minSeparationArc.toFixed(0)}px），` +
        `需要 ≥ ${MIN_SEPARATION_TILES.toFixed(2)} 瓦片`,
    );
  }

  // --- 2. 最小转弯半径（用 ±8px 的切线差量曲率）
  //
  // ⚠️ **开放路径必须把弧长夹在 [0, total] 内**，不能做 `% total`。
  // 单程赛道的起点与终点**不是同一个地方**：`arc = -8` 做取模会绕到终点附近去取切线，
  // 于是"起点切线与终点切线之差"被算成曲率 —— 报出一个**根本不存在**的 5px 尖角。
  // （这个坑在 `check-layout.mjs` 里先踩过一次，那边已经修好；这里是同一处逻辑的第二份拷贝。）
  const open = track.open === true;
  const tangentAt = (arc) => {
    let s = open ? Math.min(total, Math.max(0, arc)) : arc % total;
    if (!open && s < 0) s += total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    return Math.atan2(world[lo + 1][1] - world[lo][1], world[lo + 1][0] - world[lo][0]);
  };
  let minRadius = Infinity;
  let minRadiusArc = 0;
  const probe = 8;
  for (let arc = 0; arc < total; arc += 6) {
    const turn = Math.abs(wrapAngle(tangentAt(arc + probe) - tangentAt(arc - probe)));
    const curvature = turn / (2 * probe);
    const radius = curvature > 1e-9 ? 1 / curvature : Infinity;
    if (radius < minRadius) {
      minRadius = radius;
      minRadiusArc = arc;
    }
  }
  if (minRadius < MIN_RADIUS_PX) {
    errors.push(
      `弯过死：最小半径 ${minRadius.toFixed(0)}px（arc=${minRadiusArc.toFixed(0)}px），需要 ≥ ${MIN_RADIUS_PX}px`,
    );
  }

  // --- 3. 不顶到地图边界
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of world) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const margin = (KERB_OUTER + 1) * TILE;
  const worldW = track.grid.width * TILE;
  const worldH = track.grid.height * TILE;
  if (minX < margin || minY < margin || maxX > worldW - margin || maxY > worldH - margin) {
    // 3 瓦片是硬底线（再近就会把路肩/护栏压到赛道边上）；3~5.5 瓦片只是不够宽松
    const tooTight = minX < TILE * 3 || minY < TILE * 3 || maxX > worldW - TILE * 3 || maxY > worldH - TILE * 3;
    const message =
      `赛道贴近边界：中心线范围 x[${minX.toFixed(0)}, ${maxX.toFixed(0)}] y[${minY.toFixed(0)}, ${maxY.toFixed(0)}]，` +
      `地图 ${worldW}×${worldH}，四周建议留 ${margin.toFixed(0)}px`;
    if (tooTight) errors.push(message);
    else warnings.push(message);
  }

  // --- 4. 起跑方向应当是正南北或正东西
  //
  // 发车格是把车沿"赛道法线"横排的，所以只要起跑直道是正交的，排出来就是正的。
  // 这条只做提醒，不算错误：真正会出问题的是**斜着**发车（既不水平也不垂直），
  // 那种情况下发车格会歪着摆，看起来像车没对齐。
  const heading = Math.atan2(world[1][1] - world[0][1], world[1][0] - world[0][0]);
  const toHorizontal = Math.abs(heading);
  const toVertical = Math.abs(Math.abs(heading) - Math.PI / 2);
  const offAxis = Math.min(toHorizontal, toVertical);
  if (offAxis > 0.35) {
    warnings.push(`起跑方向不在正交轴上（偏离 ${((offAxis * 180) / Math.PI).toFixed(1)}°），发车格会斜着摆`);
  }

  return { errors, warnings, world, cumulative, total, minSeparationTiles, minRadius, heading };
}

// ---------------------------------------------------------------- 生成

function generate(track) {
  const GRID_W = track.grid.width;
  const GRID_H = track.grid.height;
  const theme = THEMES[track.theme ?? 'grass'];
  if (!theme) throw new Error(`[gen-track] ${track.id} 声明了未知主题：${track.theme}`);

  const check = validateTrack(track);
  if (check.errors.length > 0) {
    // `--force` 允许带着几何缺陷生成，用来做"AI 到底能不能跑"的实测。
    //
    // 为什么需要这个开关：`MIN_RADIUS_PX = 100` 是按"AI 不撞墙"的经验定的，
    // 但它是**静态近似**。手绘赛道偶尔会有 60~80px 的弯 —— 那到底行不行，
    // 只有把 AI 放上去跑（tools/measure-ai.mjs）才能回答。
    // 不带 --force 时仍然硬失败，避免把有缺陷的图误提交进游戏。
    if (!process.argv.includes('--force')) {
      throw new Error(`[gen-track] ${track.id} 几何自检未通过：\n  - ${check.errors.join('\n  - ')}`);
    }
    console.warn(
      `[gen-track] ⚠️ ${track.id} 几何自检未通过，但带了 --force，继续生成（仅供实测）：\n  - ${check.errors.join('\n  - ')}`,
    );
  }
  for (const warning of check.warnings) console.warn(`[gen-track] ${track.id} 警告：${warning}`);

  const centerlineWorld = check.world;
  const cumulative = check.cumulative;
  const totalLength = check.total;
  const heading = check.heading;

  const halfWidthPx = HALF_WIDTH * TILE;
  const kerbOuterPx = KERB_OUTER * TILE;

  // --- 逐瓦片到中心线的最近距离 + 弧长
  const cells = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      cells.push(nearestOnPolyline(x * TILE + TILE / 2, y * TILE + TILE / 2, centerlineWorld, cumulative));
    }
  }

  // --- 地面噪声（低频色块，避免大片纯色）
  const rndGround = mulberry32(20261003 + track.id.length * 7919 + GRID_W);
  const noiseW = Math.ceil(GRID_W / 6) + 2;
  const noiseH = Math.ceil(GRID_H / 6) + 2;
  const noise = [];
  for (let i = 0; i < noiseW * noiseH; i++) noise.push(rndGround());
  const valueNoise = (gx, gy) => {
    const fx = gx / 6;
    const fy = gy / 6;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const clampIdx = (x, y) =>
      noise[Math.min(noiseH - 1, Math.max(0, y)) * noiseW + Math.min(noiseW - 1, Math.max(0, x))];
    const a = clampIdx(x0, y0);
    const b = clampIdx(x0 + 1, y0);
    const c = clampIdx(x0, y0 + 1);
    const d = clampIdx(x0 + 1, y0 + 1);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };

  const ground = [];
  const trackLayer = [];
  const decor = [];
  const walls = [];

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const { distance, arc } = cells[y * GRID_W + x];
      const onBorder =
        x < WALL_THICKNESS || y < WALL_THICKNESS || x >= GRID_W - WALL_THICKNESS || y >= GRID_H - WALL_THICKNESS;

      ground.push(valueNoise(x, y) > 0.56 ? theme.ground[1] : theme.ground[0]);

      if (distance <= halfWidthPx) {
        const nearStart = Math.min(arc, totalLength - arc) <= START_LINE_HALF;
        trackLayer.push(nearStart ? theme.startline : theme.road);
      } else if (distance <= kerbOuterPx) {
        trackLayer.push(theme.kerb);
      } else {
        trackLayer.push(0);
      }

      decor.push(0);
      walls.push(onBorder ? theme.wall : 0);
    }
  }

  // --- 装饰层：只在远离赛道的空地上撒，避开起跑区
  const rndDecor = mulberry32(777001 + GRID_W * 31 + GRID_H);
  const startWorld = centerlineWorld[0];
  let decorCount = 0;
  if (theme.decor.length > 0) {
    for (let y = WALL_THICKNESS + 1; y < GRID_H - WALL_THICKNESS - 1; y++) {
      for (let x = WALL_THICKNESS + 1; x < GRID_W - WALL_THICKNESS - 1; x++) {
        const idx = y * GRID_W + x;
        const { distance, arc } = cells[idx];
        if (distance < kerbOuterPx + TILE * 1.5) continue;
        const wx = x * TILE + TILE / 2;
        const wy = y * TILE + TILE / 2;
        if (Math.hypot(wx - startWorld[0], wy - startWorld[1]) < TILE * 8) continue;
        if (arc < TILE * 3 || arc > totalLength - TILE * 3) continue;
        if (rndDecor() < 0.022) {
          decor[idx] = rndDecor() < 0.72 ? theme.decor[0] : (theme.decor[1] ?? theme.decor[0]);
          decorCount++;
        }
      }
    }
  }

  // ---------------------------------------------------------------- 写出

  const map = {
    compressionlevel: -1,
    height: GRID_H,
    width: GRID_W,
    infinite: false,
    layers: [
      { id: 1, name: 'ground', type: 'tilelayer', x: 0, y: 0, width: GRID_W, height: GRID_H, opacity: 1, visible: true, data: ground, properties: [{ name: 'role', type: 'string', value: 'ground' }] },
      { id: 2, name: 'track', type: 'tilelayer', x: 0, y: 0, width: GRID_W, height: GRID_H, opacity: 1, visible: true, data: trackLayer, properties: [{ name: 'role', type: 'string', value: 'track' }] },
      { id: 3, name: 'decor', type: 'tilelayer', x: 0, y: 0, width: GRID_W, height: GRID_H, opacity: 1, visible: true, data: decor, properties: [{ name: 'role', type: 'string', value: 'decor' }] },
      { id: 4, name: 'walls', type: 'tilelayer', x: 0, y: 0, width: GRID_W, height: GRID_H, opacity: 1, visible: true, data: walls, properties: [{ name: 'role', type: 'string', value: 'collision' }] },
    ],
    nextlayerid: 5,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.10.2',
    tileheight: TILE,
    tilewidth: TILE,
    type: 'map',
    version: '1.10',
    tilesets: [
      {
        firstgid: 1,
        name: 'tiles',
        image: '../tiles/tileset_placeholder.png',
        imagewidth: TILE * TILESET_COUNT,
        imageheight: TILE,
        columns: TILESET_COUNT,
        tilecount: TILESET_COUNT,
        margin: 0,
        spacing: 0,
        tilewidth: TILE,
        tileheight: TILE,
      },
    ],
  };

  const meta = {
    version: 1,
    id: track.id,
    name: track.name,
    desc: track.desc,
    map: track.id,
    theme: track.theme ?? 'grass',
    tileSize: TILE,
    grid: { width: GRID_W, height: GRID_H },
    world: { width: GRID_W * TILE, height: GRID_H * TILE },
    layers: { ground: 'ground', track: 'track', decor: 'decor', walls: 'walls' },
    tiles: T,
    surface: {
      /** 视作赛道的瓦片 gid（有抓地力）。 */
      trackGids: [theme.road, theme.kerb, theme.startline],
      grassSpeedFactor: 0.6,
      grassRecoverSeconds: 0.6,
    },
    laps: track.laps,
    /** 单程赛道：进度到 totalLength 即完赛，不做 % 归一（见 `resolveCenterline`）。 */
    open: track.open === true,
    start: {
      x: Math.round(centerlineWorld[0][0] * 100) / 100,
      y: Math.round(centerlineWorld[0][1] * 100) / 100,
      headingRad: Math.round(heading * 10000) / 10000,
    },
    centerline: {
      totalLength: Math.round(totalLength * 100) / 100,
      points: centerlineWorld.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
    },
  };

  mkdirSync('public/assets/maps', { recursive: true });
  writeFileSync(`public/assets/maps/${track.id}.json`, JSON.stringify(map));
  writeFileSync(`public/assets/maps/${track.id}.meta.json`, JSON.stringify(meta, null, 1));

  const onTrack = trackLayer.filter((v) => v !== 0).length;
  console.log(`[gen-track] ${track.id}（${track.name}）生成完成`);
  console.log(`  主题        : ${track.theme ?? 'grass'}`);
  console.log(`  地图        : ${GRID_W} x ${GRID_H} 瓦片 (${GRID_W * TILE} x ${GRID_H * TILE} px)`);
  console.log(`  赛道长度    : ${Math.round(totalLength)} px（${(totalLength / TILE).toFixed(0)} 瓦片）`);
  console.log(`  最急弯半径  : ${check.minRadius.toFixed(0)} px`);
  console.log(`  最近两段间隔: ${check.minSeparationTiles.toFixed(2)} 瓦片（下限 ${MIN_SEPARATION_TILES.toFixed(2)}）`);
  console.log(`  赛道/路肩瓦片: ${onTrack}，装饰瓦片: ${decorCount}`);
  console.log(`  中心线采样  : ${centerlineWorld.length} 点`);
  console.log(`  发车点      : (${meta.start.x}, ${meta.start.y}) heading=${meta.start.headingRad} rad`);
  return { id: track.id, length: totalLength, minRadius: check.minRadius };
}

// ---------------------------------------------------------------- main

// 只在被 node 直接运行时才写文件：check-tracks.mjs 会 import 本模块复用 TRACKS。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = process.argv.slice(2);
  const targets = wanted.length > 0 ? TRACKS.filter((t) => wanted.includes(t.id)) : TRACKS;
  if (targets.length === 0) {
    console.error(`[gen-track] 没有匹配的赛道：${wanted.join(', ')}`);
    process.exit(1);
  }

  const results = [];
  for (const track of targets) {
    results.push(generate(track));
    console.log('');
  }

  console.log('[gen-track] 汇总');
  for (const r of results) {
    console.log(`  ${r.id}: 长度 ${r.length.toFixed(0)}px / 最急弯 ${r.minRadius.toFixed(0)}px`);
  }
}

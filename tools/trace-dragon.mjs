/**
 * tools/trace-dragon.mjs
 * 把「漂移龙」手绘草图（1536×960px）的中心线，转成 `gen-track.mjs` 用的控制点表。
 *
 * ## 为什么要有这个工具
 *
 * 前 7 轮失败的根本原因是**手摆控制点间距不均**：Catmull-Rom 在疏密突变处
 * 会折出尖角（实测最急弯掉到 2.6~39px）。而"沿一条已知折线等距重采样"
 * 正好解决这件事 —— 于是正确做法是：
 *
 *   1. 把草图上描出的**原始像素点**（密、但间距不均）写在这里；
 *   2. 本工具按**弧长等距**重采样（默认 8 瓦片一个控制点）；
 *   3. 输出可直接粘进 `gen-track.mjs` 的控制点表。
 *
 * 这样"形状"（来自草图）与"点距均匀"（来自重采样）就解耦了，
 * 不用再靠手调去同时满足两件事。
 *
 * ## 用法
 *
 *   node tools/trace-dragon.mjs            # 打印控制点表
 *   node tools/trace-dragon.mjs --scale 7  # 换比例（瓦片越小，图越细）
 *
 * 草图坐标 → 瓦片：`tile = (px - ORIGIN) / SCALE`。
 * 比例取 8px/瓦片时，地图约 192×120 瓦片（与 track3 的 168×88 同量级）。
 */

/** 每瓦片多少草图像素。 */
const SCALE = 8;

/**
 * 描出来的中心线原始点（草图像素坐标，顺时针，红点起跑线在 [268,92] 附近）。
 *
 * 说明：这些点是**顺时针**沿草图走一圈取的，间隔 20~45px 不等 ——
 * 不均匀是正常的，靠下面的等距重采样抹平。
 *
 * 描点约定：取**笔画中心线**（线宽约 50px，所以取两侧的中间）。
 */
const TRACE_PX = [
  // --- 起跑直道：图上红点在 (268,92)。起跑直道要**够长、够平**，
  //     否则等距重采样之后，出发方向会被相邻点带偏（第一版出发角 -107°，
  //     因为起点正好落在左上角的弯上）。
  [300, 92],
  [230, 88],
  [160, 84],
  // --- 左上角：留出**圆角**，别让上边的回程贴上来（第一版在这里掐成 17px 尖）
  [105, 80],
  [72, 90],
  [58, 112],
  // --- 左侧下行
  [58, 150],
  [70, 195],
  [92, 240],
  [120, 275],
  // --- 左侧大 S 凸起：**向右鼓得很深**（草图里最夸张的特征，要比第一版更鼓）
  [170, 320],
  [235, 365],
  [305, 405],
  [370, 440],
  [415, 470],
  [425, 500],
  [400, 528],
  [345, 552],
  [285, 578],
  [230, 605],
  [180, 632],
  [140, 660],
  [110, 692],
  [95, 730],
  [88, 775],
  // --- 左下角
  [95, 810],
  [120, 832],
  [160, 843],
  // --- 下边：小 S 波浪（向东）。草图上一共有约 5 个波峰 —— 波长约 260px
  [205, 840],
  [255, 820],
  [305, 806],
  [355, 818],
  [405, 840],
  [450, 850],
  [500, 840],
  [550, 818],
  [600, 806],
  [650, 818],
  [700, 840],
  [750, 850],
  [800, 840],
  [850, 818],
  [900, 806],
  [950, 818],
  [1000, 840],
  [1050, 850],
  [1100, 840],
  [1150, 818],
  [1200, 806],
  [1250, 818],
  [1300, 840],
  [1345, 848],
  // --- 右下角
  [1390, 835],
  [1430, 810],
  [1460, 775],
  // --- 右侧大回环（向右上，再折回）
  [1490, 735],
  [1508, 690],
  [1512, 640],
  [1505, 590],
  [1488, 542],
  [1460, 500],
  [1425, 465],
  [1385, 440],
  [1345, 428],
  // --- 上边：小 S 波浪（向西）。草图上约 7 个波峰，波长约 240px。
  //     注意整条上边是**向左下倾斜**的（右端 y≈455，左端 y≈95）。
  [1300, 448],
  [1255, 468],
  [1205, 482],
  [1155, 470],
  [1105, 445],
  [1058, 428],
  [1010, 440],
  [962, 462],
  [915, 476],
  [868, 464],
  [820, 440],
  [772, 424],
  [724, 436],
  [676, 458],
  [628, 472],
  [580, 460],
  [532, 436],
  [484, 420],
  [436, 432],
  [388, 454],
  [340, 468],
  [292, 456],
  [244, 432],
  [196, 416],
  [148, 428],
  [108, 450],
  [82, 480],
  [68, 520],
  [58, 560],
  [52, 600],
  [46, 640],
  [42, 680],
  [40, 720],
  [40, 760],
];

/** 两点距离。 */
function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/**
 * 按弧长**等距**重采样一条闭合折线。
 *
 * @param points 原始点（闭合：最后一点与第一点自动相连）
 * @param spacing 目标间距（与输入同单位）
 * @returns 等距点列；点数由周长决定，首尾不重复
 */
function resampleClosed(points, spacing) {
  const n = points.length;
  // 先把相邻**重复点**去掉：重复点会产生零长度段，Catmull-Rom 会原地折返
  const src = [];
  for (let i = 0; i < n; i++) {
    const cur = points[i];
    const prev = src[src.length - 1];
    if (prev && dist(prev, cur) < 1e-6) continue;
    src.push(cur);
  }
  if (src.length > 1 && dist(src[0], src[src.length - 1]) < 1e-6) src.pop();

  // 累计弧长（闭合）
  const m = src.length;
  const cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + dist(src[i], src[(i + 1) % m]));
  const total = cum[m];
  const count = Math.max(8, Math.round(total / spacing));

  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (seg < m - 1 && target >= cum[seg + 1]) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const u = segLen > 0 ? (target - cum[seg]) / segLen : 0;
    const a = src[seg];
    const b = src[(seg + 1) % m];
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return { points: out, total };
}

/** 把像素点转成瓦片坐标并取整到 0.1。 */
function toTiles(points, scale) {
  return points.map(([x, y]) => [Math.round((x / scale) * 10) / 10, Math.round((y / scale) * 10) / 10]);
}

// ---------------------------------------------------------------- main

const argScale = (() => {
  const i = process.argv.indexOf('--scale');
  return i >= 0 ? Number(process.argv[i + 1]) : SCALE;
})();
const argSpacing = (() => {
  const i = process.argv.indexOf('--spacing');
  return i >= 0 ? Number(process.argv[i + 1]) : 8;
})();

const resampled = resampleClosed(TRACE_PX, argSpacing * argScale);
const tiles = toTiles(resampled.points, argScale);

const xs = tiles.map((p) => p[0]);
const ys = tiles.map((p) => p[1]);
const minX = Math.min(...xs);
const maxX = Math.max(...xs);
const minY = Math.min(...ys);
const maxY = Math.max(...ys);

console.log(`[trace-dragon] 原始点 ${TRACE_PX.length} 个`);
console.log(`[trace-dragon] 等距重采样后 ${tiles.length} 个（间距 ${argSpacing} 瓦片，${argScale}px/瓦片）`);
console.log(`[trace-dragon] 包围盒 x[${minX.toFixed(1)}, ${maxX.toFixed(1)}] y[${minY.toFixed(1)}, ${maxY.toFixed(1)}]`);
console.log(`[trace-dragon] 建议 grid: { width: ${Math.ceil(maxX + 12)}, height: ${Math.ceil(maxY + 12)} }`);
console.log('');
console.log('const TRACK4_CONTROL_POINTS = [');
tiles.forEach((p, i) => {
  const tag = i === 0 ? '  //  0  起跑区（startIndex 指向它）' : '';
  console.log(`  [${p[0]}, ${p[1]}],${tag}`);
});
console.log('];');

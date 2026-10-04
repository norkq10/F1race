/**
 * tools/check-layout.mjs
 * 快速几何体检：给一组控制点，报告长度、最急弯半径、走廊最小间距。
 * 用来在设计阶段快速筛掉"会自交 / 弯太死"的画法，不用每次都整图生成。
 *
 * 运行：node tools/check-layout.mjs
 * （控制点直接写在下面的 CANDIDATES 里改）
 */

const TILE = 32;
const HALF_WIDTH = 2.3;
const SAMPLES_PER_SEGMENT = 40;

/**
 * 走廊自交判定下限（瓦片），与 `gen-track.mjs` 的 `MIN_SEPARATION_TILES` 一致。
 */
const MIN_SEPARATION_TILES = 4.5;

/**
 * "沿路间隔多少以内算同一段路"的窗口（瓦片），必须明显大于走廊宽度。
 *
 * 与 `gen-track.mjs` 的 `MIN_SEPARATION_ARC_SKIP_TILES` 保持同一个值 ——
 * 两个检查器给出不同结论是最糟的情况。详细论证与实测表见那边的注释。
 */
const MIN_SEPARATION_ARC_SKIP_TILES = 12;

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

/**
 * 把控制点加密成中心线（瓦片坐标，未加 tile 偏移）。
 *
 * `open` 为 true 时按**单程**处理：两端用端点自身当虚拟邻居，且**不补闭合点**。
 * 不加这个分支的话，校验器会把终点硬连回起点 —— 于是它会在那条凭空多出来的
 * "闭合边"上报「最急弯 22px / 最近间距 3.13 瓦片」，而那条边在游戏里根本不存在。
 * （同理，`gen-track.mjs` 的 `resolveCenterline` 也必须认这个标记。）
 */
function buildCenterline(controlPoints, startIndex, open = false) {
  const n = controlPoints.length;
  const at = (i) => (open ? controlPoints[Math.min(n - 1, Math.max(0, i))] : controlPoints[((i % n) + n) % n]);
  const pts = [];
  const last = open ? n - 1 : n;
  for (let k = 0; k < last; k++) {
    const i = startIndex + k;
    pts.push(
      ...Array.from({ length: SAMPLES_PER_SEGMENT }, (_, s) =>
        catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), s / SAMPLES_PER_SEGMENT),
      ),
    );
  }
  if (open) pts.push([...at(startIndex + n - 1)]);
  else pts.push([...pts[0]]);
  return pts.map((p) => [p[0] * TILE + TILE / 2, p[1] * TILE + TILE / 2]);
}

function wrapAngle(a) {
  const twoPi = Math.PI * 2;
  let w = a % twoPi;
  if (w > Math.PI) w -= twoPi;
  else if (w <= -Math.PI) w += twoPi;
  return w;
}

/**
 * 取中心线（世界坐标）。
 *   - `controlPoints`：手摆的稀疏控制点，用 Catmull-Rom 加密；
 *   - `centerlineTiles`：已经等距取样好的中心线，直接用（不能再加密一遍）。
 */
function resolveCenterline(track) {
  if (track.centerlineTiles) {
    return track.centerlineTiles.map((p) => [p[0] * TILE + TILE / 2, p[1] * TILE + TILE / 2]);
  }
  return buildCenterline(track.controlPoints, track.startIndex ?? 0, track.open === true);
}

export function analyse(track) {
  const world = resolveCenterline(track);
  const open = track.open === true;
  const cumulative = [0];
  for (let i = 1; i < world.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(world[i][0] - world[i - 1][0], world[i][1] - world[i - 1][1]));
  }
  const total = cumulative[cumulative.length - 1];
  const arcSkip = MIN_SEPARATION_ARC_SKIP_TILES * TILE;

  let minSep = Infinity;
  let minSepArc = 0;
  let minSepPair = null;
  for (let i = 0; i < world.length; i++) {
    for (let j = i + 1; j < world.length; j++) {
      const raw = cumulative[j] - cumulative[i];
      // 闭环：绕另一侧走可能更短，取较短的那条（这是"沿路走多远"，不是欧氏距离）
      // 开放路径：没有"绕另一侧"，沿路距离就是 raw
      const gap = open ? raw : Math.min(raw, total - raw);
      if (gap < arcSkip) continue;
      const d = Math.hypot(world[i][0] - world[j][0], world[i][1] - world[j][1]);
      if (d < minSep) {
        minSep = d;
        minSepArc = cumulative[i];
        minSepPair = [world[i], world[j]];
      }
    }
  }

  const lastIndex = world.length - 1;
  const tangentAt = (arc) => {
    // 开放路径：把弧长夹在 [0, total] 内，端点重复使用最后一段的切线。
    // 不夹的话 `arc % total` 会让 arc+8 从起点重新开始 —— 于是终点处的
    // 曲率会被算成"终点切线与起点切线之差"，报出一个假的 5px 尖角。
    let s = open ? Math.min(total, Math.max(0, arc)) : arc % total;
    if (!open && s < 0) s += total;
    let lo = 0;
    let hi = lastIndex;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    return Math.atan2(world[lo + 1][1] - world[lo][1], world[lo + 1][0] - world[lo][0]);
  };

  let minRadius = Infinity;
  let minRadiusArc = 0;
  const d = 8;
  for (let arc = 0; arc < total; arc += 6) {
    const turn = Math.abs(wrapAngle(tangentAt(arc + d) - tangentAt(arc - d)));
    const curvature = turn / (2 * d);
    const radius = curvature > 1e-9 ? 1 / curvature : Infinity;
    if (radius < minRadius) {
      minRadius = radius;
      minRadiusArc = arc;
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of world) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }

  const heading = Math.atan2(world[1][1] - world[0][1], world[1][0] - world[0][0]);

  // 满速 3 圈用时（理想：全程 520px/s），以及"最急弯降速后"的粗估
  const ideal3Lap = (total * 3) / 520;

  return {
    total, minSep, minSepTiles: minSep / TILE, minSepArc, minSepPair,
    corridorGapPx: minSep - 2 * HALF_WIDTH * TILE,
    minRadius, minRadiusArc,
    bounds: { minX, maxX, minY, maxY },
    boundsTiles: { minX: minX / TILE, maxX: maxX / TILE, minY: minY / TILE, maxY: maxY / TILE },
    heading, ideal3Lap,
  };
}

export function report(track, grid) {
  const r = analyse(track);
  // 与 tools/gen-track.mjs 的 MIN_SEPARATION_TILES / MIN_RADIUS_PX 保持一致：
  // 走廊自交下限 4.5 瓦片；最小转弯半径 65px。
  // 半径这条 2026-10-04 从 100 放宽到 65，理由见 gen-track.mjs 的 MIN_RADIUS_PX 注释：
  // 手绘赛道「漂移龙」最急弯 67px，实测 AI 单程跑完、简单档零碰撞 ——
  // 100px 是按几何赛道定的经验值，手绘图的弯天然更紧。
  // 间距下限**没有**放宽（还是 4.5 瓦片）；改的是"多大沿路间隔之内算同一段路"的窗口
  // （见 MIN_SEPARATION_ARC_SKIP_TILES 的论证）。两者别混为一谈。
  const ok = r.minSepTiles >= MIN_SEPARATION_TILES && r.minRadius >= 65;
  // 3 瓦片是硬底线（再近路肩/护栏就会压到赛道边）；3~5.5 瓦片只是不够宽松，不算失败。
  const fits =
    r.boundsTiles.minX >= 3 && r.boundsTiles.minY >= 3 &&
    r.boundsTiles.maxX <= grid.width - 3 && r.boundsTiles.maxY <= grid.height - 3;
  const roomy = r.boundsTiles.minX >= 4.9 && r.boundsTiles.minY >= 4.9 &&
    r.boundsTiles.maxX <= grid.width - 4.9 && r.boundsTiles.maxY <= grid.height - 4.9;
  const laps = track.laps ?? 3;
  console.log(`${ok && fits ? 'OK  ' : 'FAIL'} ${track.id}（${track.name}）`);
  console.log(
    `     长度 ${r.total.toFixed(0)}px  最急弯 ${r.minRadius.toFixed(0)}px@${r.minRadiusArc.toFixed(0)}` +
      `  最近间距 ${r.minSepTiles.toFixed(2)}瓦片(空隙${r.corridorGapPx.toFixed(0)}px)@${r.minSepArc.toFixed(0)}` +
      `  [窗口 ${MIN_SEPARATION_ARC_SKIP_TILES} 瓦片]`,
  );
  console.log(
    `     包围盒 x[${r.boundsTiles.minX.toFixed(1)}, ${r.boundsTiles.maxX.toFixed(1)}]` +
      ` y[${r.boundsTiles.minY.toFixed(1)}, ${r.boundsTiles.maxY.toFixed(1)}]` +
      ` 图 ${grid.width}x${grid.height}${fits ? (roomy ? '' : '  （边距偏紧但可接受）') : '  <-- 压到边界'}` +
      `  ${track.open === true ? '单程' : `${laps} 圈`}满速 ${((r.total * laps) / 520).toFixed(1)}s` +
      `  发车角 ${((r.heading * 180) / Math.PI).toFixed(1)}°`,
  );
  return { ...r, ok: ok && fits };
}

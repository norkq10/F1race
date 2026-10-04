/**
 * TrackGeometry.ts
 * 中心线的几何查询（**纯逻辑，不 import Phaser**，可直接单元测试）。
 *
 * 从 `Track.ts` 里抽出来的原因：`Track` 一 `new` 就要建瓦片图层、加载地图，
 * 于是"弧长怎么算"这件事**没法写单测** —— 而它恰好是 `docs/known-issues.md` 里
 * 反复出事的地方（第 8 条缓存跨车共用、第 10 条瞬移改错基准，以及
 * "过弯压草地被判切弯"这个玩家实际报回来的 bug）。
 *
 * 分工：`Track` 负责 Phaser 那一半（瓦片、图层、碰撞标志），
 * 本模块负责"给一个世界坐标，它在中心线上的哪个位置"。
 */

/** 一次几何查询的结果。与 `types.ts` 的 `TrackProgress` 同形。 */
export interface GeometryProgress {
  /** 沿中心线的弧长（像素）。 */
  arc: number;
  /** 归一化进度 0..1。 */
  t: number;
  /** 到中心线的垂直距离（像素）。 */
  lateralDistance: number;
  /** 相对中心线的有符号偏移（正值 = 前进方向的右侧）。 */
  signedLateral: number;
  /** 中心线在该处的切线方向（弧度）。 */
  tangent: number;
}

export interface TrackGeometryOptions {
  /** 中心线采样点（世界坐标）。 */
  points: readonly (readonly [number, number])[];
  /**
   * 是否是**单程**赛道（点对点）。
   *
   * `true` 时起点与终点不是同一个地方：弧长查询在两端要**夹住**而不是绕回，
   * 曲率取样也不能跨过端点取到另一头去（否则会把"起点切线与终点切线之差"
   * 算成一个根本不存在的尖角，报出「最急弯 5px」）。
   */
  open: boolean;
}

/**
 * 沿路推进量的方向容差。
 *
 * 中心线的**弧长参数化**与车辆真实位移并不是 1:1：采样密的地方弧长推进快、
 * 弯里切线转得快。实测正常行驶时两者比值在 1.0~1.5 之间，所以判据留 3 倍余量 ——
 * 它要拦的是"走 7.9px 却涨 59px"（7.5 倍）这种量级的错误读数，不是正常波动。
 */
const TRACK_DIRECTION_TOLERANCE = 3;

/**
 * 中心线几何。
 *
 * 采样点是**折线**：所有查询都先投影到最近的线段上，再按线段起点弧长 + 段内偏移
 * 算出弧长。这样结果与采样密度无关（加密采样不会改变同一位置的读数）。
 */
export class TrackGeometry {
  readonly totalLength: number;
  readonly isOpen: boolean;

  private readonly points: readonly (readonly [number, number])[];
  /** cumulative[i] = 起点到 points[i] 的弧长。 */
  private readonly cumulative: number[];
  private readonly tangents: number[];

  constructor(options: TrackGeometryOptions) {
    this.points = options.points;
    this.isOpen = options.open;
    if (this.points.length < 3) throw new Error('[F1race] 中心线采样点过少');

    const cumulative: number[] = [0];
    const tangents: number[] = [];
    for (let i = 1; i < this.points.length; i++) {
      const dx = this.points[i][0] - this.points[i - 1][0];
      const dy = this.points[i][1] - this.points[i - 1][1];
      cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
      tangents.push(Math.atan2(dy, dx));
    }
    tangents.push(tangents[tangents.length - 1]);
    this.cumulative = cumulative;
    this.tangents = tangents;
    this.totalLength = cumulative[cumulative.length - 1];
  }

  get segmentCount(): number {
    return this.points.length - 1;
  }

  /** 取第 seg 段的投影：`t` 是段内参数（已夹在 [0,1]），`distance` 是垂距。 */
  projectOnSegment(px: number, py: number, seg: number): { t: number; distance: number } {
    const a = this.points[seg];
    const b = this.points[seg + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - a[0]) * dx + (py - a[1]) * dy) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    return { t, distance: Math.hypot(px - cx, py - cy) };
  }

  /** 把一段投影结果组装成返回值。 */
  private makeProgress(seg: number, t: number, worldX: number, worldY: number): GeometryProgress {
    const a = this.points[seg];
    const b = this.points[seg + 1];
    const segLength = this.cumulative[seg + 1] - this.cumulative[seg];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const invLen = segLength > 0 ? 1 / segLength : 0;
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    // 叉积符号：正值 = 车辆在赛道前进方向的右侧。
    const cross = (dx * (worldY - cy) - dy * (worldX - cx)) * invLen;
    const arc = this.cumulative[seg] + segLength * t;
    return {
      arc,
      t: this.totalLength > 0 ? arc / this.totalLength : 0,
      lateralDistance: Math.abs(cross),
      signedLateral: cross,
      tangent: this.tangents[seg],
    };
  }

  /**
   * **全局**最近点查询：整条中心线上离这个坐标最近的位置。
   *
   * ⚠️ 它的语义是"你在图上离哪段路最近"，**不是**"你正在跑哪段路"。
   * 在发夹弯 / S 弯里，冲出赛道的车可能离另一段路更近 —— 用它推进计时就会
   * 把"压了草地"算成一次巨大的进度跳跃。**每帧计时请用 `arcNear()`。**
   */
  progressAt(worldX: number, worldY: number): GeometryProgress {
    const count = this.segmentCount;
    let bestIndex = 0;
    let bestT = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const r = this.projectOnSegment(worldX, worldY, i);
      if (r.distance < bestDistance) {
        bestDistance = r.distance;
        bestIndex = i;
        bestT = r.t;
      }
    }
    return this.makeProgress(bestIndex, bestT, worldX, worldY);
  }

  /** 把弧长归一化到本赛道的规范区间：闭环 [0, total)，单程 [0, total]。 */
  normalizeArc(arc: number): number {
    if (this.isOpen) return Math.min(this.totalLength, Math.max(0, arc));
    let value = arc % this.totalLength;
    if (value < 0) value += this.totalLength;
    return value;
  }

  /**
   * **连续**最近点查询：只看上一次弧长附近的一小段，且拒绝"物理上不可能"的读数。
   *
   * 这是"过弯冲出赛道压了草地，却被判切弯、整圈作废"的修法（玩家实际报回来的问题）。
   *
   * 判据一句话：**沿路里程的变化不能超过车真正的位移**（把位移投影到赛道切线上）。
   * 车一帧走 7px，沿路却涨了 59px —— 那不可能，只可能是投影落到了别的路段
   * （发夹弯内外侧、起点与终点相邻、采样疏密不均处都会发生），这时读数原地不动：
   *   - 不前进：抄近道不会白赚距离，压草地也不会白送进度；
   *   - 不后退：车往前开、读数却后退必然被判进度跳跃。
   *
   * ⚠️ 判据必须用**真实位移**，不能用"速度上限 × dt + 容差"：track1 上实测，
   * 走 7.9px 的帧被报出 +59px / -96px 的跳变，而 520px/s 的宽松上限（约 51px）
   * 根本拦不住。
   * ⚠️ 也不能用 `prevArc + travelled` 当兜底：那会给"被拒绝的帧"凭空加一点前进量，
   * 实测几千帧后锚点会前飘约 25 倍，直接把整圈卡死。
   *
   * ⚠️ 传入的 `prevArc` 与返回的 `arc` 都是**归一化后**的（见 `normalizeArc`）。
   * 调用方拿去当下一帧锚点时，两边约定必须一致 —— 否则起跑点这种"既是 0 又是 total"
   * 的位置会让第一帧的增量变成一整圈（真踩过，整场被判切弯）。
   *
   * @param windowPx 窗口半宽（像素）。默认 120：远大于一帧位移（约 9px），
   *                 又能把绝大多数拓扑跳变挡在外面（两段路的净距至少 24px）。
   * @param maxTravelPx 这一帧车**实际移动**的距离（像素，通常 = |本帧位移|）。
   *   传了才启用上面那套判据；不传就是旧行为（窗口内永远采信，会跳变）。
   * @param fromX / fromY 上一帧的世界坐标。给了它才能算出位移**方向**
   *   （只看长度挡不住"横着滑出去、弧长却往前跳"）。
   * @param trustProjection true = **跳过上面那套物理判据**，直接采信窗口内的投影。
   *   只在"锚点已经挂住不动、车却一直在别处"时由调用方置位（见场景里的
   *   `STUCK_REJECT_LIMIT`）：那是调试瞬移 / 极端脱困，宁可接受一次大跳变
   *   （计时器会照常判它无效），也不能让车永远卡在旧弧长上。
   */
  arcNear(
    worldX: number,
    worldY: number,
    prevArc: number,
    windowPx = 120,
    maxTravelPx?: number,
    fromX?: number,
    fromY?: number,
    trustProjection = false,
  ): GeometryProgress {
    const count = this.segmentCount;
    const anchor = this.normalizeArc(prevArc);
    const lo = anchor - windowPx;
    const hi = anchor + windowPx;

    // 闭环时窗口可能越过 0 / 总长（起跑点在 0 附近、终点在 total 附近）：
    // 把弧长区间整体平移一圈再做一次，就能覆盖"绕过来的那一段"。
    //
    // ⚠️ 平移后必须**按窗口筛选段号**，不能让整条赛道都参与比较 ——
    // 段号是从副本区间反推的，而副本区间里的一部分段其实离窗口很远。
    const intervals: { lo: number; hi: number }[] = [{ lo, hi }];
    if (!this.isOpen) intervals.push({ lo: lo + this.totalLength, hi: hi + this.totalLength });

    let bestIndex = -1;
    let bestT = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const interval of intervals) {
      for (let i = 0; i < count; i++) {
        const segStart = this.cumulative[i];
        const segEnd = this.cumulative[i + 1];
        if (segEnd <= interval.lo || segStart >= interval.hi) continue;
        const r = this.projectOnSegment(worldX, worldY, i);
        if (r.distance < bestDistance) {
          bestDistance = r.distance;
          bestIndex = i;
          bestT = r.t;
        }
      }
    }

    if (bestIndex >= 0 && bestDistance <= windowPx) {
      const candidate = this.makeProgress(bestIndex, bestT, worldX, worldY);
      if (trustProjection || maxTravelPx === undefined || fromX === undefined || fromY === undefined) {
        return candidate;
      }
      /**
       * **沿路推进量不能超过车真实位移在赛道方向上的投影。**
       *
       * 判据一句话：车一帧走 7.9px，沿路里程不该涨 59px。实测 track1 自动驾驶上，
       * 走 7.9px 的帧被报出 +59px / -96px —— 那都是投影落到了别的路段上
       * （发夹弯内外侧、起点与终点相邻、采样疏密不均处）。
       *
       * 用**位移向量在切线上的投影**而不是"位移长度"：车横着滑出去时沿路推进本来就接近 0，
       * 这条判据能如实反映；而 `|Δ弧长| ≤ |位移|` 会误杀正常行驶
       * （弧长参数化与真实距离存在 1.2~1.5 倍的差异）。
       *
       * `TRACK_DIRECTION_TOLERANCE` 是给"切线在弯里变化很快"留的余量：投影为负/极小
       * （横滑、掉头、原地打转）时不能把读数锁死，否则车会卡在旧弧长上再也追不回来。
       */
      const dirX = worldX - fromX;
      const dirY = worldY - fromY;
      const dirLen = Math.hypot(dirX, dirY);
      if (dirLen < 1e-6) return candidate; // 没动过：谈不上跳变
      const tanX = Math.cos(candidate.tangent);
      const tanY = Math.sin(candidate.tangent);
      /**
       * 允许的沿路推进量 = 位移在切线上的投影 × 容差，再兜一个固定下限。
       *
       * 固定下限 15px 是给"低速 / 横滑 / 掉头"留的：那时切向投影接近 0，
       * 但弧长仍会因车辆实际前进而增长，不能把读数锁死。
       * 它远小于"几帧内能累积出的错误读数"（实测 59~96px），所以不影响拦截效果。
       */
      const alongTrack = Math.abs(dirX * tanX + dirY * tanY) * TRACK_DIRECTION_TOLERANCE;
      const allowed = Math.max(alongTrack, 15);
      const advance = candidate.arc - anchor;
      if (Math.abs(advance) <= allowed) return candidate;
      // 判据不过：落到下面的"原地不动"
    }

    // --- 不可信 / 窗口里没有自己的路：**弧长原地不动**
    if (maxTravelPx === undefined) return this.progressAt(worldX, worldY);
    const point = this.pointAtArc(anchor);
    return {
      arc: anchor,
      t: this.totalLength > 0 ? anchor / this.totalLength : 0,
      // 横向偏移如实反映"离中心线很远"，让排名 / AI 的收油逻辑仍然知道情况不妙。
      // 符号取不到（车可能在任何一侧），给 0 比给一个猜的符号更诚实。
      lateralDistance: Math.hypot(worldX - point.x, worldY - point.y),
      signedLateral: 0,
      tangent: point.tangent,
    };
  }

  /**
   * 取弧长 arc 处的位置与切线。
   *
   * 闭环做 `% total`（绕回起点），**单程夹在 [0, total] 内** ——
   * 单程的终点不是起点，绕回来会取到赛道另一头的位置与切线。
   * AI 的前视点在最末尾会越过终点（`look` 有 70~200px），夹住才能让它继续朝前看，
   * 而不是"突然看向起点"然后打死方向。
   */
  pointAtArc(arc: number): { x: number; y: number; tangent: number } {
    const total = this.totalLength;
    let s: number;
    if (this.isOpen) {
      s = Math.min(total, Math.max(0, arc));
    } else {
      s = arc % total;
      if (s < 0) s += total;
    }

    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLength = this.cumulative[lo + 1] - this.cumulative[lo];
    const t = segLength > 0 ? (s - this.cumulative[lo]) / segLength : 0;
    const a = this.points[lo];
    const b = this.points[lo + 1];
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tangent: this.tangents[lo] };
  }

  tangentAtArc(arc: number): number {
    return this.pointAtArc(arc).tangent;
  }

  /** 中心线采样点（只读）。 */
  get centerlinePoints(): readonly (readonly [number, number])[] {
    return this.points;
  }
}

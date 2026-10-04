/**
 * tools/meta-track.mjs
 * 不带 Phaser 的赛道查询（与 Track.ts / tests/ai.test.ts 的约定一致）。
 *
 * 从 `measure-ai.mjs` 里抽出来共用：离线测量（measure-ai）与调参探针
 * （probe-curvature）都要按同一套几何走 —— 中心线弧长、走廊约束、切向。
 * 复制一份迟早会走样，而"探针量到的东西和实际跑的不是一回事"是最难查的 bug。
 */

import { TUNING } from '../src/game/constants.ts';

/** 与 gen-track.mjs 的 HALF_WIDTH 一致：赛道半宽（瓦片）。 */
export const HALF_WIDTH_TILES = 2.3;

/**
 * 车身中心能到达的边界（扣掉车身半径）。
 *
 * 从 `TUNING` 读而不是写死 12：车身半径是手感的可调参数，
 * 写死之后一旦调参，离线测量与真机的走廊就不一致了。
 */
export const CORRIDOR = HALF_WIDTH_TILES * 32 - TUNING.vehicle.bodyRadius;

export class MetaTrack {
  constructor(meta) {
    this.meta = meta;
    /**
     * 单程赛道（`TrackMeta.open`）：中心线的起点与终点**不是同一个地方**。
     *
     * ⚠️ 这里必须和运行时 `Track.ts` 的行为**完全一致**，否则离线测出来的东西
     * 和玩家实际跑的完全是两回事。踩过的坑：`pointAtArc` 一直做 `arc % total`，
     * 于是单程赛道在终点前那一段，AI 的"前视点"会**绕回起点**去看 ——
     * 它看到的是起点附近那段几乎笔直的路（曲率 0.0000），于是全油门冲进最后那个
     * 67px 发夹弯。「漂移龙」上"困难档贴墙 940 帧、比普通档还慢 9 秒"就是这么来的：
     * 不是 AI 不行，是探针喂给它的赛道几何是错的。
     */
    this.isOpen = meta.open === true;
    this.points = meta.centerline.points.map((p) => [p[0], p[1]]);
    const cumulative = [0];
    const tangents = [];
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
    this.searchSegment = 0;
  }

  progressAt(x, y) {
    const count = this.points.length - 1;
    let best = { index: 0, t: 0, distance: Number.POSITIVE_INFINITY };
    const scan = (from, to) => {
      const lo = this.isOpen ? Math.max(0, from) : from;
      const hi = this.isOpen ? Math.min(count - 1, to) : to;
      for (let i = lo; i <= hi; i++) {
        // 闭环：段索引环回；单程：夹在两端（起点之前 / 终点之后没有路）
        const seg = this.isOpen ? i : ((i % count) + count) % count;
        const a = this.points[seg];
        const b = this.points[seg + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const lenSq = dx * dx + dy * dy;
        let t = lenSq > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const distance = Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
        if (distance < best.distance) best = { index: seg, t, distance };
      }
    };
    scan(this.searchSegment - 40, this.searchSegment + 40);
    if (best.distance > 240) {
      best = { index: 0, t: 0, distance: Number.POSITIVE_INFINITY };
      scan(0, count - 1);
    }
    this.searchSegment = best.index;

    const a = this.points[best.index];
    const b = this.points[best.index + 1];
    const segLength = this.cumulative[best.index + 1] - this.cumulative[best.index];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const cx = a[0] + dx * best.t;
    const cy = a[1] + dy * best.t;
    const cross = segLength > 0 ? (dx * (y - cy) - dy * (x - cx)) / segLength : 0;
    const arc = this.cumulative[best.index] + segLength * best.t;
    return {
      arc,
      t: arc / this.totalLength,
      lateralDistance: Math.abs(cross),
      signedLateral: cross,
      tangent: this.tangents[best.index],
    };
  }

  pointAtArc(arc) {
    const total = this.totalLength;
    // 单程夹在 [0, total]；闭环才做 % total（见构造函数的说明）
    let s;
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

  tangentAtArc(arc) {
    return this.pointAtArc(arc).tangent;
  }

  poseAt(arc) {
    const sample = this.pointAtArc(arc);
    return { x: sample.x, y: sample.y, heading: sample.tangent };
  }

  /** 出走廊压回边界；返回 null 表示没撞墙。 */
  constrain(x, y) {
    const progress = this.progressAt(x, y);
    if (progress.lateralDistance <= CORRIDOR) return null;
    const sample = this.pointAtArc(progress.arc);
    const normal = sample.tangent + Math.PI / 2;
    const sign = progress.signedLateral >= 0 ? 1 : -1;
    return {
      x: sample.x + Math.cos(normal) * sign * CORRIDOR,
      y: sample.y + Math.sin(normal) * sign * CORRIDOR,
    };
  }
}

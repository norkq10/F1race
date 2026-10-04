import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrackGeometry } from '../src/game/TrackGeometry';

/**
 * 中心线几何查询 —— **"过弯冲出赛道压了草地，却被判切弯"** 的直接回归测试。
 *
 * 玩家实际报回来的问题：「漂移龙这个地图……我过弯失误之后会反馈赛道进度异常跳跃，
 * 那我后面岂不是都白跑了」。根因是 `progressAt()` 的语义 —— 它取**全图最近**的中心线点，
 * 而在发夹弯 / S 弯里，"冲出去的车"可能离**另一段路**更近，于是弧长瞬间跳掉一大截，
 * `LapTimer` 就判「切弯：赛道进度异常跳跃」、整圈作废。
 *
 * 修法是 `arcNear()`：把"车在哪条路上"变成有状态的，只在上一次弧长附近找。
 * 本文件用一个**合成 U 形赛道**把这件事钉死 —— 不用真地图，几何关系一眼可见。
 */

/**
 * 造一条 U 形**单程**中心线（世界像素）：
 *
 * ```
 *   起点 →(东)──────────┐        ← 来路（y=480）
 *                       │        ← 右端半圆回折
 *   终点 ←(西)──────────┘        ← 回路（y=640）
 * ```
 *
 * 两条平直的路相距 160px（约 5 瓦片）。车从回路外侧冲出去（y 偏大）时，
 * 到**来路**的距离会比到**回路**更近 —— 这正是"全局最近点跳段"的几何前提。
 */
function makeUTrack(): { geometry: TrackGeometry; legGapPx: number } {
  const STEP = 8;
  const yTop = 480;
  const yBottom = 640;
  const xStart = 200;
  const xTurnStart = 1000;
  const turnRadius = (yBottom - yTop) / 2; // 80
  const cx = xTurnStart;
  const cy = (yTop + yBottom) / 2; // 560

  const points: [number, number][] = [];
  // 来路：从 (200,480) 向东到半圆起点
  for (let x = xStart; x <= xTurnStart; x += STEP) points.push([x, yTop]);
  // 右端半圆：从 -90°（正上方）顺时针扫到 +90°（正下方）
  for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-9; a += STEP / turnRadius) {
    points.push([cx + Math.cos(a) * turnRadius, cy + Math.sin(a) * turnRadius]);
  }
  // 回路：从半圆终点向西回到起点正下方
  for (let x = xTurnStart; x >= xStart; x -= STEP) points.push([x, yBottom]);

  return { geometry: new TrackGeometry({ points, open: true }), legGapPx: yBottom - yTop };
}

describe('中心线几何：连续弧长（arcNear）', () => {
  const { geometry, legGapPx } = makeUTrack();

  it('合成赛道自检：两条平行路相距 160px，来路与回路各占一半弧长', () => {
    assert.equal(legGapPx, 160, '两条路的净距必须是 160px（否则这个测试的几何前提不成立）');
    const total = geometry.totalLength;
    assert.ok(total > 1800 && total < 2200, `总长 ${total.toFixed(0)} 应约 2000px`);
    // 来路中点附近
    const top = geometry.pointAtArc(400);
    assert.ok(Math.abs(top.y - 480) < 1, `arc=400 应在来路上（y=480），实际 y=${top.y}`);
    // 回路中点附近（总长后半段）
    const bottom = geometry.pointAtArc(total - 400);
    assert.ok(Math.abs(bottom.y - 640) < 1, `arc=total-400 应在回路上（y=640），实际 y=${bottom.y}`);
  });

  it('全局查询会"跳段"：冲出赛道的车可能离另一段路更近，弧长直接跳掉半个赛道', () => {
    // 车从**来路**（y=480）的外侧冲出去 100px（y=580）。它到来路 100px，
    // 到回路（y=640）只有 60px —— 于是全局最近点会落到**回路**上去。
    // 这就是玩家遇到的"我只是压了草地，怎么就说我切弯了"。
    const x = 600;
    const y = 580;
    const global = geometry.progressAt(x, y);
    assert.ok(
      global.arc > geometry.totalLength / 2,
      `全局查询应当落到回路上（这就是"跳段"），实际 arc=${global.arc.toFixed(0)} / 总长 ${geometry.totalLength.toFixed(0)}`,
    );
  });

  it('连续查询不跳段：锚点在来路上时，即使离回路更近也仍然读来路的弧长', () => {
    const x = 600;
    const y = 580;
    const anchor = 400; // 在来路上（arc=400 对应 x=600, y=480）
    const near = geometry.arcNear(x, y, anchor);
    assert.ok(
      near.arc < geometry.totalLength / 2,
      `arcNear 必须留在来路上，实际 arc=${near.arc.toFixed(0)}`,
    );
    assert.ok(
      Math.abs(near.arc - anchor) < 60,
      `弧长必须连续（锚点 ${anchor}，实际 ${near.arc.toFixed(0)}，偏差应远小于半个赛道）`,
    );
    assert.ok(near.lateralDistance > 60, `横向偏移应当如实报出来（实际 ${near.lateralDistance.toFixed(0)}px）`);
  });

  it('横向偏移在两条路之间时仍按"哪条更近"选（这是有意的，不是 bug）', () => {
    // y=560 是两条路的正中：到来路 80px、到回路 80px。此时选哪条都说得通，
    // 唯一的要求是**别跳**（结果必须落在锚点附近，而不是甩到半个赛道外）。
    const near = geometry.arcNear(600, 560, 400);
    assert.ok(Math.abs(near.arc - 400) < 120, `应当落在锚点附近，实际 ${near.arc.toFixed(0)}`);
  });

  it('正常行驶时连续查询与全局查询一致（没有副作用）', () => {
    for (let arc = 50; arc < geometry.totalLength - 50; arc += 137) {
      const p = geometry.pointAtArc(arc);
      const global = geometry.progressAt(p.x, p.y);
      const near = geometry.arcNear(p.x, p.y, global.arc);
      assert.ok(
        Math.abs(near.arc - global.arc) < 1e-6,
        `中心线上 arc=${arc}：全局 ${global.arc.toFixed(3)} vs 连续 ${near.arc.toFixed(3)} 应当相同`,
      );
    }
  });

  it('真瞬移会回落到全局查询（重新摆位 / 调试瞬移不能失效）', () => {
    const target = geometry.totalLength - 300; // 回路靠终点的位置
    const p = geometry.pointAtArc(target);
    const near = geometry.arcNear(p.x, p.y, 100); // 锚点还在来路起点附近
    assert.ok(
      Math.abs(near.arc - target) < 20,
      `瞬移后应当读出新位置（期望 ~${target.toFixed(0)}，实际 ${near.arc.toFixed(0)}）`,
    );
  });

  it('归一化约定：单程夹在 [0, total]，闭环回绕到 [0, total)', () => {
    const open = geometry;
    assert.equal(open.normalizeArc(-50), 0, '单程不允许负数弧长');
    assert.equal(open.normalizeArc(open.totalLength + 50), open.totalLength, '单程不允许超过 total');

    // 闭环：同一个几何按闭环解释时应当回绕
    const closed = new TrackGeometry({ points: open.centerlinePoints as [number, number][], open: false });
    assert.ok(Math.abs(closed.normalizeArc(-50) - (closed.totalLength - 50)) < 1e-6);
    assert.ok(Math.abs(closed.normalizeArc(closed.totalLength + 50) - 50) < 1e-6);
  });

  it('单程赛道的 pointAtArc 夹在两端，闭环才绕回起点', () => {
    const total = geometry.totalLength;
    const beyond = geometry.pointAtArc(total + 500);
    const end = geometry.pointAtArc(total);
    assert.ok(Math.abs(beyond.x - end.x) < 1e-6 && Math.abs(beyond.y - end.y) < 1e-6, '单程越过终点应当夹住');

    const closed = new TrackGeometry({ points: geometry.centerlinePoints as [number, number][], open: false });
    const wrapped = closed.pointAtArc(closed.totalLength + 500);
    const start = closed.pointAtArc(500);
    assert.ok(
      Math.abs(wrapped.x - start.x) < 1e-6 && Math.abs(wrapped.y - start.y) < 1e-6,
      '闭环越过总量应当绕回起点附近',
    );
  });
});

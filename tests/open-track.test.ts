import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LapTimer, type LapTimerOptions } from '../src/game/LapTimer';
import { progressLabelFor } from '../src/game/RaceStandings';

/**
 * 单程赛道（`open: true`）的计时与排名文案 —— CR-16「漂移龙」。
 *
 * 闭环那套逻辑正在两张图上跑，本文件只盯"单程"这条新分支：
 *  1. **不做弧长归一**：环形赛道靠 `% total` 与"±半圈"把跨线当成绕回来，
 *     单程的终点不是起点，照抄那套会把"冲线"误算成一次巨大的负跳变；
 *  2. **跨过终点即整场结束**：`laps: 1`，这一圈就是整趟成绩；
 *  3. **冲线后成绩必须冻结**：多算一帧，「漂移龙」的成绩就会一帧一帧地涨；
 *  4. **文案**：未完赛显示"进行中"，不能说"第 N 圈"。
 */

const TOTAL = 1000;
const FRAME_MS = 16;
/** 每帧 10.5px：正好不是帧长整数倍，用来证明过线做了插值。 */
const PX_PER_FRAME = 10.5;
const PX_PER_MS = PX_PER_FRAME / FRAME_MS;

/** 单程计时器：`open: true` + 1 趟。 */
function makeOpenTimer(overrides: Partial<LapTimerOptions> = {}): LapTimer {
  return new LapTimer({
    totalLength: TOTAL,
    lapCount: 1,
    open: true,
    sectorCount: 3,
    checkpointsPerSector: 8,
    maxSpeed: 1000,
    jumpTolerance: 1.25,
    jumpSlackPx: 40,
    ...overrides,
  });
}

/**
 * 单程推进：弧长**不取模**，一路涨到 total 之后继续涨（模拟真实场景 ——
 * `Track.progressAt` 在终点附近返回的 arc 会到 total 上下）。
 */
function runOpen(timer: LapTimer, frames: number, startArc = 0, pxPerFrame = PX_PER_FRAME): number {
  let arc = startArc;
  for (let i = 0; i < frames; i++) {
    arc += pxPerFrame;
    timer.update(FRAME_MS, arc);
  }
  return arc;
}

describe('单程计时（open: true）', () => {
  it('跑完一趟就算完赛：跨过 totalLength 产生一条成绩，且 finished=true', () => {
    const timer = makeOpenTimer();
    timer.start(0);
    runOpen(timer, 96); // 1008px > 1000px

    const s = timer.snapshot;
    assert.equal(s.laps.length, 1, '单程只应产生一条成绩');
    assert.equal(s.finished, true, '跑完一趟就是完赛');
    assert.equal(s.totalMs, s.laps[0].lapMs, '整趟时间就是这条成绩');
  });

  it('过线时刻同样是帧内插值（不是帧边界）', () => {
    const timer = makeOpenTimer();
    timer.start(0);
    runOpen(timer, 96);

    const lapMs = timer.snapshot.laps[0].lapMs;
    const expectedMs = TOTAL / PX_PER_MS;
    assert.ok(Math.abs(lapMs - expectedMs) < 1, `整趟 ${lapMs.toFixed(3)}ms 应接近 ${expectedMs.toFixed(3)}ms`);
    assert.ok(Math.abs(lapMs % FRAME_MS) > 0.5, `落在了帧边界上，说明没有插值：${lapMs}`);
  });

  it('冲线后成绩冻结：再跑 200 帧，总时间一分一毫都不涨', () => {
    const timer = makeOpenTimer();
    timer.start(0);
    runOpen(timer, 96);
    const atFinish = timer.snapshot;
    assert.ok(atFinish.totalMs !== null);

    // 冲线之后车还在往前滑（场景要到那一帧才 finish），这里必须什么都不变
    runOpen(timer, 200, 1008);
    const after = timer.snapshot;
    assert.equal(after.totalMs, atFinish.totalMs, '冲线后总时间必须冻结');
    assert.equal(after.elapsedMs, atFinish.elapsedMs, '冲线后 elapsed 也必须冻结');
    assert.equal(after.laps.length, 1, '不能多出一条成绩');
  });

  it('冲线的那一帧不会被判成"切弯"（不做 ±半圈归一）', () => {
    const timer = makeOpenTimer();
    timer.start(0);
    // 一步步走到刚好越过终点，然后继续推 —— 若做了环形归一，
    // arc 从 1008 继续涨会被当成"绕回"，delta 出现巨大负值。
    runOpen(timer, 96);
    const s = timer.snapshot;
    assert.equal(s.laps[0].valid, true, `冲线不该判无效：${String(s.laps[0].invalidReason)}`);
    assert.equal(s.currentLapInvalid, false);
  });

  it('把 arc 折回 0（模拟"用闭环的读取方式"）会被判成进度跳跃', () => {
    // 这条是**反向守卫**：它记录"如果 Track 那边忘了按 open 夹住弧长会怎样"。
    // 只要 `Track.pointAtArc` / `LapTimer.normalizeArc` 的单程分支都在，就永远不会走到这里；
    // 一旦有人把那边改回 `% total`，本用例会红，提示"整趟被判无效"的真实症状。
    const timer = makeOpenTimer();
    timer.start(900);
    timer.update(FRAME_MS, 995);
    timer.update(FRAME_MS, 5); // 折回起点：对单程来说是 -990px 的跳变
    const s = timer.snapshot;
    assert.equal(s.currentLapInvalid, true);
    assert.match(String(s.currentLapInvalidReason), /跳跃/);
  });

  it('单程的 lapProgress 从 0 涨到 1（不绕回）', () => {
    const timer = makeOpenTimer();
    timer.start(0);
    timer.update(FRAME_MS, 250);
    assert.ok(Math.abs(timer.snapshot.lapProgress - 0.25) < 1e-9, `实际 ${timer.snapshot.lapProgress}`);
    timer.update(FRAME_MS, 750);
    assert.ok(Math.abs(timer.snapshot.lapProgress - 0.75) < 1e-9, `实际 ${timer.snapshot.lapProgress}`);
    // 完赛瞬间钉在 1（不再涨过 1）
    runOpen(timer, 40, 750);
    assert.equal(timer.snapshot.lapProgress, 1, '完赛后进度钉在 100%');
  });

  it('闭环行为不受影响：同一个 totalLength 下仍按 3 圈跑', () => {
    // 这条是回归守卫 —— 单程分支不能把闭环的语义改掉。
    const closed = new LapTimer({
      totalLength: TOTAL,
      lapCount: 3,
      sectorCount: 3,
      checkpointsPerSector: 8,
      maxSpeed: 1000,
      jumpTolerance: 1.25,
      jumpSlackPx: 40,
    });
    assert.equal(closed.open, false);
    closed.start(0);
    let arc = 0;
    for (let i = 0; i < 96; i++) {
      arc = (arc + PX_PER_FRAME) % TOTAL;
      closed.update(FRAME_MS, arc);
    }
    assert.equal(closed.snapshot.laps.length, 1, '闭环跑过一圈只算 1 圈（不是完赛）');
    assert.equal(closed.snapshot.finished, false, '3 圈的图跑 1 圈不算完赛');
  });
});

describe('单程赛道的进度文案', () => {
  it('未完赛显示"进行中"，不显示"第 N 圈"', () => {
    assert.equal(progressLabelFor({ lapsCompleted: 0 }, 1, true), '进行中');
    assert.equal(progressLabelFor({ lapsCompleted: 0 }, 1, false), '第 1 圈');
    assert.equal(progressLabelFor({ lapsCompleted: 2 }, 3, false), '第 3 圈');
    // 闭环越界时封顶，不会出现"第 5 圈"
    assert.equal(progressLabelFor({ lapsCompleted: 9 }, 3, false), '第 3 圈');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LapTimer, type LapTimerOptions } from '../src/game/LapTimer';

const TOTAL = 1000;
/** 每帧前进 10.5px / 16ms → 正好不是帧长的整数倍，用来证明过线做了插值。 */
const PX_PER_FRAME = 10.5;
const FRAME_MS = 16;
const PX_PER_MS = PX_PER_FRAME / FRAME_MS;

function makeTimer(overrides: Partial<LapTimerOptions> = {}): LapTimer {
  return new LapTimer({
    totalLength: TOTAL,
    lapCount: 3,
    sectorCount: 3,
    checkpointsPerSector: 8,
    maxSpeed: 1000, // 放得很宽，避免正常推进被误判成切弯
    jumpTolerance: 1.25,
    jumpSlackPx: 40,
    ...overrides,
  });
}

/** 以恒定速度推进，返回消耗的帧数。 */
function runFrames(timer: LapTimer, frames: number, startArc = 0): number {
  let arc = startArc;
  for (let i = 0; i < frames; i++) {
    arc = (arc + PX_PER_FRAME) % TOTAL;
    timer.update(FRAME_MS, arc);
  }
  return arc;
}

describe('LapTimer 精确计时', () => {
  it('过线时刻按帧内插值，误差远小于一帧', () => {
    const timer = makeTimer();
    timer.start(0);

    // 跑够一圈多一点
    runFrames(timer, 96);

    const snapshot = timer.snapshot;
    assert.equal(snapshot.laps.length, 1, '应该完成 1 圈');

    const expectedMs = TOTAL / PX_PER_MS; // 1000 / 0.65625 = 1523.809...
    const lapMs = snapshot.laps[0].lapMs;
    assert.ok(
      Math.abs(lapMs - expectedMs) < 1,
      `圈速 ${lapMs.toFixed(3)}ms 应接近理论值 ${expectedMs.toFixed(3)}ms（一帧 = ${FRAME_MS}ms）`,
    );
    // 若没有插值，结果必然是帧长的整数倍
    assert.ok(
      Math.abs(lapMs % FRAME_MS) > 0.5,
      `圈速 ${lapMs.toFixed(3)}ms 落在帧边界上，说明没有做插值`,
    );
  });

  it('多圈累计：总时间等于各圈之和', () => {
    const timer = makeTimer();
    timer.start(0);
    runFrames(timer, 300); // 约 3.3 圈

    const snapshot = timer.snapshot;
    assert.equal(snapshot.laps.length, 3);
    assert.equal(snapshot.finished, true);

    const sum = snapshot.laps.reduce((acc, lap) => acc + lap.lapMs, 0);
    assert.ok(snapshot.totalMs !== null);
    assert.ok(Math.abs(snapshot.totalMs - sum) < 1e-9, '总时间必须严格等于各圈之和');
    assert.ok(
      Math.abs(sum - 3 * (TOTAL / PX_PER_MS)) < 2,
      `三圈总时间 ${sum.toFixed(2)}ms 应接近 ${(3 * TOTAL / PX_PER_MS).toFixed(2)}ms`,
    );
  });

  it('分段时间之和等于圈速（匀速时三段基本相等）', () => {
    const timer = makeTimer();
    timer.start(0);
    runFrames(timer, 96);

    const lap = timer.snapshot.laps[0];
    assert.equal(lap.sectorsMs.length, 3);
    const sectorSum = lap.sectorsMs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sectorSum - lap.lapMs) < 1e-6, `分段之和 ${sectorSum} 应等于圈速 ${lap.lapMs}`);
    for (const sector of lap.sectorsMs) {
      assert.ok(Math.abs(sector - lap.lapMs / 3) < 2, `匀速时每段应接近 ${(lap.lapMs / 3).toFixed(2)}ms，实际 ${sector.toFixed(2)}ms`);
    }
  });
});

describe('LapTimer 无效圈判定', () => {
  it('进度异常跳跃会判本圈无效，且不刷新最佳圈', () => {
    const timer = makeTimer();
    timer.start(0);
    runFrames(timer, 96); // 第一圈：干净
    assert.equal(timer.snapshot.laps[0].valid, true);
    const bestAfterCleanLap = timer.snapshot.bestLapMs;
    assert.ok(bestAfterCleanLap !== null);

    // 第二圈中途瞬移半圈 → 进度跳跃
    const currentArc = (96 * PX_PER_FRAME) % TOTAL;
    let arc = currentArc;
    arc = (arc + TOTAL * 0.4) % TOTAL;
    timer.update(FRAME_MS, arc);

    runFrames(timer, 96, arc); // 跑完这一圈（用时更短，因为抄了近道）

    const laps = timer.snapshot.laps;
    assert.equal(laps.length, 2);
    assert.equal(laps[1].valid, false, '抄近道的圈必须判无效');
    assert.match(laps[1].invalidReason ?? '', /切弯/);
    assert.equal(timer.snapshot.bestLapMs, bestAfterCleanLap, '无效圈不能刷新最佳圈');
  });

  it('正常倒车不会被判无效', () => {
    const timer = makeTimer();
    timer.start(0);
    let arc = 0;
    for (let i = 0; i < 40; i++) {
      arc += PX_PER_FRAME;
      timer.update(FRAME_MS, arc);
    }
    // 倒车 30 帧
    for (let i = 0; i < 30; i++) {
      arc -= PX_PER_FRAME;
      timer.update(FRAME_MS, arc);
    }
    assert.equal(timer.snapshot.currentLapInvalid, false, '倒车不应判无效');
  });
});

describe('LapTimer 反作弊', () => {
  it('rebase 之后不会把瞬移误判成切弯', () => {
    const timer = makeTimer();
    timer.start(0);
    runFrames(timer, 40);

    // 模拟瞬移：先对齐基准，再继续跑
    timer.rebase(600);
    let arc = 600;
    for (let i = 0; i < 10; i++) {
      arc += PX_PER_FRAME;
      timer.update(FRAME_MS, arc);
    }
    assert.equal(timer.snapshot.currentLapInvalid, false, 'rebase 之后的正常行驶不应判无效');
  });

  it('rebase 不会凭空增加本圈进度', () => {
    const timer = makeTimer();
    timer.start(0);
    const before = timer.snapshot.lapProgress;
    timer.rebase(900);
    assert.equal(timer.snapshot.lapProgress, before, 'rebase 只对齐基准，不改变已累计的进度');
  });

  it('起点来回蹭线不会完成任何一圈', () => {
    const timer = makeTimer();
    timer.start(0);
    let arc = 0;
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 3; i++) {
        arc = (arc + PX_PER_FRAME) % TOTAL;
        timer.update(FRAME_MS, arc);
      }
      for (let i = 0; i < 3; i++) {
        arc = (arc - PX_PER_FRAME + TOTAL) % TOTAL;
        timer.update(FRAME_MS, arc);
      }
    }
    assert.equal(timer.snapshot.laps.length, 0, '在终点线来回蹭不应产生圈数');
  });

  it('必须真的跑满一整圈才能过线', () => {
    const timer = makeTimer();
    timer.start(0);
    // 差一点点到终点
    const framesForOneLap = Math.ceil(TOTAL / PX_PER_FRAME);
    runFrames(timer, framesForOneLap - 2);
    assert.equal(timer.snapshot.laps.length, 0);
    runFrames(timer, 4, ((framesForOneLap - 2) * PX_PER_FRAME) % TOTAL);
    assert.equal(timer.snapshot.laps.length, 1);
  });
});

describe('LapTimer 实时 delta', () => {
  it('没有参考圈时 delta 为 null，设置参考后能看到落后', () => {
    const timer = makeTimer();
    timer.start(0);
    assert.equal(timer.snapshot.liveDeltaMs, null);

    // 手造一条 1500ms 的参考曲线（匀速）
    const checkpoints = Array.from({ length: 25 }, (_, i) => (i / 24) * 1500);
    timer.setReference(checkpoints);
    assert.equal(timer.snapshot.referenceSource, 'history');

    // 用更慢的速度跑（每帧 8px → 0.5px/ms → 一圈 2000ms），跑到 1/4 处应该已经慢了
    let arc = 0;
    for (let i = 0; i < 40; i++) {
      arc = (arc + 8) % TOTAL;
      timer.update(FRAME_MS, arc);
    }
    const delta = timer.snapshot.liveDeltaMs;
    assert.ok(delta !== null && delta > 50, `落后时应为正的 delta，实际 ${String(delta)}`);
  });

  it('长度不匹配的参考曲线会被忽略', () => {
    const timer = makeTimer();
    timer.start(0);
    timer.setReference([0, 1, 2]);
    assert.equal(timer.snapshot.referenceSource, null);
    assert.equal(timer.snapshot.liveDeltaMs, null);
  });

  it('本场刷出更快的圈后，参考曲线切换为本场成绩', () => {
    const timer = makeTimer();
    // 先给一条很慢的历史参考
    timer.setReference(Array.from({ length: 25 }, (_, i) => (i / 24) * 9000));
    timer.start(0);
    runFrames(timer, 96);
    assert.equal(timer.snapshot.referenceSource, 'session');
    const checkpoints = timer.checkpoints;
    assert.ok(checkpoints !== null);
    assert.ok(Math.abs(checkpoints[24] - timer.snapshot.bestLapMs!) < 1e-6);
  });
});

describe('LapTimer 生命周期', () => {
  it('reset 会清空本场成绩，但不会丢掉历史参考曲线', () => {
    const timer = makeTimer();
    timer.setReference(Array.from({ length: 25 }, (_, i) => (i / 24) * 1500));
    timer.start(0);
    timer.reset();

    assert.equal(timer.snapshot.laps.length, 0);
    assert.equal(timer.snapshot.bestLapMs, null);
    assert.equal(timer.snapshot.referenceSource, 'history', 'reset 不应丢掉历史参考');
  });

  it('本场刷出更快圈后参考升级为 session，reset 后依然可用', () => {
    const timer = makeTimer();
    // 先给一条很慢的历史参考
    timer.setReference(Array.from({ length: 25 }, (_, i) => (i / 24) * 9000));
    timer.start(0);
    runFrames(timer, 96);
    assert.equal(timer.snapshot.laps.length, 1);
    assert.equal(timer.snapshot.referenceSource, 'session');

    timer.reset();
    assert.equal(timer.snapshot.laps.length, 0);
    assert.equal(timer.snapshot.referenceSource, 'session', '本场更快的那条曲线仍然是有效参考');
    assert.ok(timer.checkpoints !== null);
  });

  it('没有 start 时 update 不产生任何数据', () => {
    const timer = makeTimer();
    timer.update(FRAME_MS, 100);
    assert.equal(timer.snapshot.laps.length, 0);
    assert.equal(timer.snapshot.elapsedMs, 0);
  });
});

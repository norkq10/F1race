import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNING } from '../src/game/constants';
import { GhostPlayback, GhostRecorder, isValidGhostData, shortestAngleDelta } from '../src/game/Ghost';
import type { GhostData } from '../src/game/types';

function makeGhost(overrides: Partial<GhostData> = {}): GhostData {
  return {
    version: TUNING.ghost.dataVersion,
    totalMs: 60000,
    intervalMs: 100,
    frames: [0, 0, 0, 100, 50, 0, 200, 50, Math.PI / 2],
    ...overrides,
  };
}

/** 归一化到 (-π, π]，断言朝向时用。 */
function wrapToPi(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** 两个朝向之间的夹角（恒为非负）。 */
function angleGap(a: number, b: number): number {
  return Math.abs(wrapToPi(a - b));
}

describe('GhostRecorder 采样', () => {
  it('第一帧立即落点，之后不足 intervalMs 不落点', () => {
    const rec = new GhostRecorder(50, 100);
    rec.capture(0, 10, 20, 0);
    assert.equal(rec.sampleCount, 1, '计时刚起步必须留下起点，否则回放没有开头');

    rec.capture(16, 11, 20, 0);
    rec.capture(49, 12, 20, 0);
    assert.equal(rec.sampleCount, 1, '距上次采样不足 50ms 时不应落点');

    rec.capture(50, 30, 40, 0.1);
    assert.equal(rec.sampleCount, 2, '刚好达到间隔时落点');
    rec.capture(99, 31, 40, 0.1);
    assert.equal(rec.sampleCount, 2);
    rec.capture(100, 50, 60, 0.2);
    assert.equal(rec.sampleCount, 3);
  });

  it('采样点严格落在等距网格上（回放时间轴的根基）', () => {
    const interval = 50;
    const rec = new GhostRecorder(interval, 1000);
    // 帧长 7ms 不能整除 50ms —— 这正是"发现超时才记当前坐标"会跑偏的场景
    for (let t = 0; t <= 1000; t += 7) rec.capture(t, t, 0, 0);

    const playback = new GhostPlayback(rec.build(1000));
    assert.equal(
      playback.recordedMs,
      (rec.sampleCount - 1) * interval,
      '记录时长必须等于 (点数-1)×interval，回放正是按这个假设推进的',
    );
    // 本用例里玩家在 t 时刻的位置恰好等于 t，所以每个网格点都应精确命中
    for (let i = 0; i < rec.sampleCount; i++) {
      const pose = playback.sampleAt(i * interval);
      assert.ok(pose, `第 ${i} 个网格点应能取样`);
      assert.ok(
        Math.abs(pose.x - i * interval) < 1e-6,
        `第 ${i} 个网格点回放到 ${pose.x}，应等于真实位置 ${i * interval}`,
      );
    }
  });

  it('时间倒退 / 非有限值不会落点（重开、瞬移不会污染回放）', () => {
    const rec = new GhostRecorder(50, 100);
    rec.capture(0, 0, 0, 0);
    rec.capture(Number.NaN, 1, 1, 1);
    rec.capture(Number.POSITIVE_INFINITY, 1, 1, 1);
    rec.capture(200, Number.NaN, 1, 1);
    rec.capture(200, 1, Number.NaN, 1);
    rec.capture(200, 1, 1, Number.NaN);
    assert.equal(rec.sampleCount, 1);

    rec.capture(500, 5, 5, 0.5);
    // 0→500ms 之间跨过 50/100/…/500 共 10 个网格点，会被插值补齐：
    // 时间轴不能因为一次长间隔就整体缩短，否则回放会越跑越快
    assert.equal(rec.sampleCount, 11);

    const beforeBackwards = rec.sampleCount;
    rec.capture(100, 9, 9, 9);
    assert.equal(rec.sampleCount, beforeBackwards, '比赛时间倒退时不应落点');
  });

  it('超过 maxSamples 后停止采样，build 仍返回已有数据', () => {
    const rec = new GhostRecorder(10, 3);
    for (let i = 0; i < 10; i++) rec.capture(i * 10, i, 0, 0);
    assert.equal(rec.sampleCount, 3);

    const data = rec.build(100);
    assert.equal(data.frames.length, 9);
    assert.equal(data.frames[6], 2, '保留的是最早录到的三个点');
  });

  it('build 产出可存档结构，且返回副本', () => {
    const rec = new GhostRecorder(50, 10);
    rec.capture(0, 1, 2, 0.5);
    rec.capture(60, 3, 4, 0.6);

    const data = rec.build(1234);
    assert.equal(data.version, TUNING.ghost.dataVersion);
    assert.equal(data.totalMs, 1234);
    assert.equal(data.intervalMs, 50);
    assert.equal(rec.sampleCount, 2);
    // 第二个点落在 50ms 网格上，坐标由 0ms→60ms 两帧插值而来，而不是 60ms 的原始坐标
    assert.ok(Math.abs(data.frames[3] - 2.6666667) < 1e-4, `50ms 网格点的 x 应为 2.667，实际 ${data.frames[3]}`);
    assert.ok(Math.abs(data.frames[5] - 0.5833333) < 1e-4, `50ms 网格点的朝向应为 0.583，实际 ${data.frames[5]}`);
    assert.equal(isValidGhostData(data), true);

    // 外部改动返回值不能影响录制器
    data.frames[0] = 999;
    assert.equal(rec.build(1234).frames[0], 1, '录制器内部数据不能被外部引用改坏');

    // 继续录制会往网格后面追加，已产出的副本不受影响
    rec.capture(200, 5, 6, 0.7);
    const later = rec.build(1234);
    assert.equal(later.frames[0], 1);
    assert.ok(later.frames.length > data.frames.length, '继续录制应当追加新的网格点');
    assert.equal(later.frames[later.frames.length - 3], 5, '最后一个网格点应落在 200ms 处');
  });

  it('totalMs 非法时回落到记录到的时长', () => {
    const rec = new GhostRecorder(50, 10);
    rec.capture(0, 0, 0, 0);
    rec.capture(60, 1, 0, 0);
    assert.equal(rec.build(Number.NaN).totalMs, 50, '两帧记录的时长 = (2-1) * 50ms');
    assert.equal(rec.build(-1).totalMs, 50);
  });

  it('reset 清空采样，可以重新录一场', () => {
    const rec = new GhostRecorder(50, 10);
    rec.capture(0, 1, 1, 1);
    rec.capture(60, 2, 2, 2);
    assert.equal(rec.sampleCount, 2);

    rec.reset();
    assert.equal(rec.sampleCount, 0);
    assert.deepEqual(rec.build(0).frames, []);

    rec.capture(0, 7, 7, 7);
    assert.equal(rec.sampleCount, 1);
    assert.deepEqual(rec.build(10).frames, [7, 7, 7]);
  });
});

describe('GhostPlayback 插值与边界', () => {
  it('落在采样点上时精确返回记录值', () => {
    const playback = new GhostPlayback(makeGhost());
    assert.deepEqual(playback.sampleAt(0), { x: 0, y: 0, heading: 0 });
    assert.deepEqual(playback.sampleAt(100), { x: 100, y: 50, heading: 0 });
    assert.deepEqual(playback.sampleAt(200), { x: 200, y: 50, heading: Math.PI / 2 });
    assert.equal(playback.totalMs, 60000);
    assert.equal(playback.recordedMs, 200, '最后一帧的时间 = (3-1) * 100ms');
  });

  it('相邻采样点之间做线性插值', () => {
    const playback = new GhostPlayback(makeGhost());
    const mid = playback.sampleAt(50);
    assert.ok(mid);
    assert.equal(mid.x, 50);
    assert.equal(mid.y, 25);
    const quarter = playback.sampleAt(25);
    assert.ok(quarter);
    assert.equal(quarter.x, 25);
    assert.equal(quarter.y, 12.5);
  });

  it('超出记录范围返回 null，负时间返回第一帧', () => {
    const playback = new GhostPlayback(makeGhost());
    assert.equal(playback.sampleAt(200.0001), null);
    assert.equal(playback.sampleAt(60000), null, 'recordedMs 之后即使没到 totalMs 也没有数据');
    assert.deepEqual(playback.sampleAt(-5), { x: 0, y: 0, heading: 0 });
    assert.equal(playback.sampleAt(Number.NaN), null);
  });

  it('空数据：isEmpty 为 true，sampleAt 恒为 null', () => {
    const playback = new GhostPlayback(makeGhost({ frames: [] }));
    assert.equal(playback.isEmpty, true);
    assert.equal(playback.recordedMs, 0);
    assert.equal(playback.sampleAt(0), null);
    assert.equal(playback.sampleAt(100), null);
  });

  it('单帧数据只能回放起点', () => {
    const playback = new GhostPlayback(makeGhost({ frames: [10, 20, 0.3] }));
    assert.equal(playback.isEmpty, false);
    assert.equal(playback.recordedMs, 0);
    assert.deepEqual(playback.sampleAt(0), { x: 10, y: 20, heading: 0.3 });
    assert.equal(playback.sampleAt(1), null);
  });

  it('朝向按最短弧插值：跨越 ±π 时不会瞬间打转', () => {
    // 两个采样点朝向分别是 3.0 与 -3.0：真实运动是绕过 ±π，而不是倒着转回去
    const playback = new GhostPlayback(makeGhost({ frames: [0, 0, 3.0, 0, 0, -3.0] }));
    const forwardQuarter = playback.sampleAt(25);
    assert.ok(forwardQuarter);
    assert.ok(forwardQuarter.heading > 3.0, `应朝 +π 方向转动，实际 ${forwardQuarter.heading}`);

    const mid = playback.sampleAt(50);
    assert.ok(mid);
    assert.ok(
      angleGap(mid.heading, Math.PI) < 1e-6,
      `中点朝向应经过 ±π（实际 ${mid.heading}）；若得到 0 说明用了朴素线性插值`,
    );
    // 中点与两端点的夹角相等，说明走的是最短弧的中点
    assert.ok(Math.abs(angleGap(mid.heading, 3.0) - angleGap(mid.heading, -3.0)) < 1e-9);

    // 反方向：-3.0 → 3.0 的最短弧是负向，先经过 -π 而不是绕 0
    const reverse = new GhostPlayback(makeGhost({ frames: [0, 0, -3.0, 0, 0, 3.0] }));
    const reverseQuarter = reverse.sampleAt(25);
    assert.ok(reverseQuarter);
    assert.ok(reverseQuarter.heading < -3.0, `应朝 -π 方向转动，实际 ${reverseQuarter.heading}`);
    const reverseMid = reverse.sampleAt(50);
    assert.ok(reverseMid);
    assert.ok(angleGap(reverseMid.heading, Math.PI) < 1e-6, `实际 ${reverseMid.heading}`);
  });

  it('朝向插值结果始终落在两端点的最短弧上', () => {
    const cases: [number, number][] = [
      [0, Math.PI / 2],
      [Math.PI / 2, -Math.PI / 2],
      [-3.0, 3.0],
      [3.0, -3.0],
      [-1.0, -2.5],
      [6.0, -6.0],
    ];
    for (const [from, to] of cases) {
      const playback = new GhostPlayback(makeGhost({ frames: [0, 0, from, 0, 0, to] }));
      const delta = shortestAngleDelta(from, to);
      for (const t of [0, 25, 50, 75, 100]) {
        const sampled = playback.sampleAt(t);
        assert.ok(sampled);
        const expected = wrapToPi(from + delta * (t / 100));
        assert.ok(
          angleGap(sampled.heading, expected) < 1e-9,
          `${from} → ${to} @${t}ms：期望 ${expected}，实际 ${sampled.heading}`,
        );
      }
    }
  });

  it('手改过的数据含有 NaN 帧时被截断，不会产出 NaN 位姿', () => {
    const playback = new GhostPlayback(makeGhost({ frames: [0, 0, 0, Number.NaN, 1, 1, 5, 5, 5] }));
    assert.equal(playback.recordedMs, 0);
    const first = playback.sampleAt(0);
    assert.ok(first);
    assert.ok(Number.isFinite(first.x) && Number.isFinite(first.y) && Number.isFinite(first.heading));
    assert.equal(playback.sampleAt(10), null);

    // 尾部残缺（长度不是 3 的倍数）只取完整的三元组
    const truncated = new GhostPlayback(makeGhost({ frames: [0, 0, 0, 100, 100, 0, 200] }));
    assert.equal(truncated.recordedMs, 100);
    assert.deepEqual(truncated.sampleAt(100), { x: 100, y: 100, heading: 0 });
  });

  it('非法 intervalMs 有兜底，不会除零', () => {
    const playback = new GhostPlayback(makeGhost({ intervalMs: 0, frames: [0, 0, 0, 10, 0, 0] }));
    assert.ok(playback.recordedMs > 0);
    const mid = playback.sampleAt(playback.recordedMs / 2);
    assert.ok(mid);
    assert.ok(Number.isFinite(mid.x));
    assert.ok(Math.abs(mid.x - 5) < 1e-9);
  });
});

describe('isValidGhostData', () => {
  it('接受合法数据', () => {
    assert.equal(isValidGhostData(makeGhost()), true);
    assert.equal(isValidGhostData(makeGhost({ frames: [1, 2, 3] })), true);
  });

  it('拒绝非对象与缺字段的数据', () => {
    for (const bad of [null, undefined, 42, 'ghost', true, [], {}, { version: 1 }]) {
      assert.equal(isValidGhostData(bad), false, `${JSON.stringify(bad)} 不应通过校验`);
    }
  });

  it('拒绝版本不符的数据', () => {
    assert.equal(isValidGhostData(makeGhost({ version: TUNING.ghost.dataVersion + 1 })), false);
    assert.equal(isValidGhostData(makeGhost({ version: 0 })), false);
  });

  it('拒绝 frames 为空 / 不是 3 的倍数 / 含非有限值', () => {
    assert.equal(isValidGhostData(makeGhost({ frames: [] })), false, '没有帧的幽灵车无法回放');
    assert.equal(isValidGhostData(makeGhost({ frames: [0, 0] })), false);
    assert.equal(isValidGhostData(makeGhost({ frames: [0, 0, 0, Number.NaN, 0, 0] })), false);
    assert.equal(
      isValidGhostData(makeGhost({ frames: [0, 0, 0, 0, Number.POSITIVE_INFINITY, 0] })),
      false,
    );
  });

  it('拒绝非法的 intervalMs / totalMs', () => {
    assert.equal(isValidGhostData(makeGhost({ intervalMs: 0 })), false);
    assert.equal(isValidGhostData(makeGhost({ intervalMs: -50 })), false);
    assert.equal(isValidGhostData(makeGhost({ intervalMs: Number.NaN })), false);
    assert.equal(isValidGhostData(makeGhost({ totalMs: -1 })), false);
    assert.equal(isValidGhostData(makeGhost({ totalMs: Number.NaN })), false);
  });
});

describe('录制 → 回放 端到端', () => {
  /** 一条平滑的合成轨迹，用来验证"回放与记录基本一致"。 */
  const poseAt = (t: number) => ({
    x: 300 * (t / 1000),
    y: 100 * Math.sin(t / 500),
    heading: t / 800,
  });

  it('按 20Hz 录制的整场轨迹，回放误差远小于一个采样步长', () => {
    const interval = TUNING.ghost.sampleIntervalMs;
    const rec = new GhostRecorder(interval, TUNING.ghost.maxSamples);
    const frameMs = 10; // 帧长整除采样间隔，采样点正好落在理论时刻上
    const durationMs = 4000;

    for (let t = 0; t <= durationMs; t += frameMs) {
      const pose = poseAt(t);
      rec.capture(t, pose.x, pose.y, pose.heading);
    }

    const data = rec.build(durationMs);
    assert.equal(isValidGhostData(data), true);
    assert.equal(rec.sampleCount, durationMs / interval + 1, '4 秒 @20Hz 应正好 81 个采样点');

    const playback = new GhostPlayback(data);
    assert.equal(playback.recordedMs, durationMs);

    let maxPosErr = 0;
    let maxHeadErr = 0;
    for (let t = 0; t <= durationMs; t += 37) {
      const got = playback.sampleAt(t);
      assert.ok(got, `t=${t} 应有位姿`);
      const want = poseAt(t);
      maxPosErr = Math.max(maxPosErr, Math.hypot(got.x - want.x, got.y - want.y));
      maxHeadErr = Math.max(maxHeadErr, angleGap(got.heading, want.heading));
    }
    assert.ok(maxPosErr < 1, `位置误差 ${maxPosErr.toFixed(3)}px 应远小于一个采样步长`);
    assert.ok(maxHeadErr < 0.01, `朝向误差 ${maxHeadErr.toFixed(5)}rad 过大`);
  });

  it('录制短于整场时，回放在记录范围之外返回 null（集成层据此隐藏幽灵车）', () => {
    const rec = new GhostRecorder(50, 10);
    rec.capture(0, 0, 0, 0);
    rec.capture(50, 10, 0, 0);
    const playback = new GhostPlayback(rec.build(9999));
    assert.equal(playback.totalMs, 9999);
    assert.equal(playback.recordedMs, 50);
    assert.ok(playback.sampleAt(50));
    assert.equal(playback.sampleAt(51), null);
  });
});

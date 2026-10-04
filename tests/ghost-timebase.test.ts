import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNING } from '../src/game/constants';
import { GhostPlayback, GhostRecorder, isValidGhostData } from '../src/game/Ghost';

/**
 * M4 幽灵车的时间基准测试。
 *
 * 这一组测试针对一个真实的线上 bug：录制时"发现距上次落点超过 intervalMs 才记当前坐标"，
 * 实际采样间隔会吸附到整数帧；而回放按标称 50ms 推进，于是幽灵车跑得比录制时快
 * （144Hz 下快 11%，而且误差随圈数累积，很快就甩开玩家跑出画面）。
 *
 * 判定标准很直接：让玩家以恒定速度跑一段，再回放，任意时刻的幽灵位置都应该
 * 等于"玩家本来应该在的位置"。
 */

const INTERVAL = 50;
const MAX_SAMPLES = 4000;
const SPEED = 500; // px/s，沿 +x 匀速

/** 用指定帧长把一段匀速直线运动录下来。 */
function recordConstantRun(durationMs: number, frameMs: number, jitter = 0): GhostRecorder {
  const recorder = new GhostRecorder(INTERVAL, MAX_SAMPLES);
  recorder.reset();
  // 集成层会在发车瞬间显式落一个 t=0 的起点采样
  recorder.capture(0, 0, 0, 0);

  let t = 0;
  let tick = 0;
  while (t < durationMs) {
    const step = jitter > 0 ? frameMs + ((tick % 5) - 2) * jitter : frameMs;
    tick++;
    t += Math.max(0.1, step);
    recorder.capture(t, (SPEED * t) / 1000, 0, 0);
  }
  return recorder;
}

/** 期望位置：玩家在 probeMs 时刻本应在的地方。 */
function expectedX(probeMs: number): number {
  return (SPEED * probeMs) / 1000;
}

const FRAME_RATES: Array<{ name: string; frameMs: number; jitter?: number }> = [
  { name: '60Hz', frameMs: 1000 / 60 },
  { name: '75Hz', frameMs: 1000 / 75 },
  { name: '120Hz', frameMs: 1000 / 120 },
  { name: '144Hz', frameMs: 1000 / 144 },
  { name: '165Hz', frameMs: 1000 / 165 },
  { name: '240Hz', frameMs: 1000 / 240 },
  { name: '60Hz 抖动', frameMs: 1000 / 60, jitter: 4 },
];

describe('幽灵车回放必须与录制同速', () => {
  for (const rate of FRAME_RATES) {
    it(`${rate.name}：任意时刻的位置都等于玩家本应在的位置`, () => {
      const duration = 6000;
      const recorder = recordConstantRun(duration, rate.frameMs, rate.jitter ?? 0);
      const playback = new GhostPlayback(recorder.build(duration));

      for (const probeMs of [500, 1500, 3000, 5000, 5900]) {
        const pose = playback.sampleAt(probeMs);
        assert.ok(pose, `${probeMs}ms 应该能取到位姿`);
        const drift = Math.abs(pose.x - expectedX(probeMs));
        assert.ok(
          drift < 4,
          `${rate.name} 在 ${probeMs}ms 处偏差 ${drift.toFixed(1)}px（回放 ${pose.x.toFixed(1)} vs 期望 ${expectedX(probeMs).toFixed(1)}）`,
        );
      }
    });
  }

  it('采样点落在等距网格上，数量与时长一致', () => {
    const duration = 6000;
    const recorder = recordConstantRun(duration, 1000 / 144);
    // 6 秒 / 50ms ≈ 121 个点（含 t=0）
    assert.ok(
      recorder.sampleCount >= 119 && recorder.sampleCount <= 122,
      `144Hz 下 6 秒应录到约 121 个点，实际 ${recorder.sampleCount}`,
    );

    const playback = new GhostPlayback(recorder.build(duration));
    // 网格等距 → 记录时长必须约等于 (点数-1)*50ms
    assert.ok(
      Math.abs(playback.recordedMs - (recorder.sampleCount - 1) * INTERVAL) < 1e-6,
      `记录时长 ${playback.recordedMs} 与点数 ${recorder.sampleCount} 不自洽`,
    );
  });

  it('首帧固定在 t=0，幽灵车不会一开始就领先', () => {
    const recorder = recordConstantRun(3000, 1000 / 144);
    const playback = new GhostPlayback(recorder.build(3000));
    const start = playback.sampleAt(0);
    assert.ok(start);
    assert.equal(start.x, 0, '起点采样必须是发车位置');
  });

  it('一帧跨过多个网格时会把中间点补齐，不会丢时间', () => {
    const recorder = new GhostRecorder(INTERVAL, MAX_SAMPLES);
    recorder.reset();
    recorder.capture(0, 0, 0, 0);
    // 模拟一次长卡顿：直接跳到 400ms（比赛计时被钳制时也可能出现）
    recorder.capture(400, 200, 0, 0);
    const playback = new GhostPlayback(recorder.build(400));

    assert.equal(recorder.sampleCount, 9, `0/50/…/400 共 9 个网格点，实际 ${recorder.sampleCount}`);
    const mid = playback.sampleAt(200);
    assert.ok(mid);
    assert.ok(Math.abs(mid.x - 100) < 1e-6, `200ms 处应插值到 100px，实际 ${mid.x}`);
  });

  it('旧版（非等距网格）的录制数据会被版本校验拒绝', () => {
    // dataVersion 已升到 2：用户手里那批"跑得偏快"的旧幽灵会被丢弃，等下次刷新纪录重新录
    const legacy = {
      version: 1,
      totalMs: 51000,
      intervalMs: INTERVAL,
      frames: [0, 0, 0, 100, 0, 0, 200, 0, 0],
    };
    assert.equal(isValidGhostData(legacy), false, 'v1 幽灵数据不应再被接受');

    const current = { ...legacy, version: TUNING.ghost.dataVersion };
    assert.equal(isValidGhostData(current), true, '当前版本的数据应当可用');
  });
});

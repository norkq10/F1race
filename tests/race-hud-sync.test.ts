import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resetHudForNewRace,
  syncHudBestLap,
  syncHudFrame,
  syncHudGhost,
  type HudFrame,
  type HudStaticContext,
  type HudSurface,
} from '../src/game/RaceHudSync';

/** 记录所有调用的假 HUD —— 这就是把 HUD 收成窄接口的收益。 */
function makeFakeHud() {
  const calls: [string, ...unknown[]][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const hud: HudSurface = {
    setSpeed: rec('setSpeed'),
    setLap: rec('setLap'),
    setLapTime: rec('setLapTime'),
    setTotalTime: rec('setTotalTime'),
    setSurface: rec('setSurface'),
    setFps: rec('setFps'),
    setDelta: rec('setDelta'),
    setLapValidity: rec('setLapValidity'),
    setDrift: rec('setDrift'),
    setBestLap: rec('setBestLap'),
    setGhostStatus: rec('setGhostStatus'),
    setDifficulty: rec('setDifficulty'),
    setTrack: rec('setTrack'),
  };
  /** 取某个 setter 最后一次调用的实参。 */
  const last = (name: string): unknown[] | undefined =>
    [...calls].reverse().find((c) => c[0] === name)?.slice(1);
  return { hud, calls, last };
}

const CTX: HudStaticContext = {
  totalLaps: 3,
  fps: 60,
  difficulty: 'normal',
  difficultyLabel: '普通',
  trackId: 'track1',
  trackLabel: '环城赛道',
  storedBestLapMs: 16_995,
};

function frame(over: Partial<HudFrame> = {}): HudFrame {
  return {
    phase: 'racing',
    speedKmh: 180,
    currentLap: 2,
    lapMs: 12_345,
    lastLapMs: 16_000,
    elapsedMs: 30_000,
    totalMs: null,
    liveDeltaMs: -250,
    referenceSource: 'history',
    currentLapInvalid: false,
    bestLapMs: 16_995,
    onTrack: true,
    drifting: false,
    driftAngle: 0,
    ...over,
  };
}

/**
 * HUD 同步映射。
 *
 * 这些断言锁的是"显示规则"，以前它们只存在于 `RaceScene.updateHud()` 的代码里
 * 和零散的注释里，没有任何测试。规则一旦被改错（例如倒计时期间把圈速显示成 0），
 * 只会被玩家看到，不会被 CI 拦住。
 */
describe('HUD 每帧同步 syncHudFrame', () => {
  it('比赛中：圈速显示当前圈、总时间显示本场累计', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame(), CTX);
    assert.deepEqual(last('setLap'), [2, 3]);
    assert.deepEqual(last('setLapTime'), [12_345]);
    assert.deepEqual(last('setTotalTime'), [30_000]);
  });

  it('倒计时期间圈速回落到上一圈（而不是显示 0 让人以为计时坏了）', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ phase: 'countdown', lapMs: 0, lastLapMs: 16_500 }), CTX);
    assert.deepEqual(last('setLapTime'), [16_500], '倒计时期间该显示上一圈用时');
  });

  it('倒计时期间且没有上一圈时显示 0（第一圈本来就没跑过）', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ phase: 'countdown', lapMs: 0, lastLapMs: null }), CTX);
    assert.deepEqual(last('setLapTime'), [0]);
  });

  it('完赛后总时间用 totalMs（各圈之和），不用还在走的 elapsedMs', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ phase: 'finished', totalMs: 51_553, elapsedMs: 51_600 }), CTX);
    assert.deepEqual(last('setTotalTime'), [51_553], '完赛后必须定格在正式总时间上');
  });

  it('完赛但 totalMs 缺失时回落到 elapsedMs（异常兜底，不显示 null）', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ phase: 'finished', totalMs: null, elapsedMs: 51_600 }), CTX);
    assert.deepEqual(last('setTotalTime'), [51_600]);
  });

  it('只有比赛中才显示 delta；倒计时与完赛后一律隐藏', () => {
    for (const [phase, expected] of [
      ['racing', [-250, 'history']],
      ['countdown', [null, null]],
      ['finished', [null, null]],
    ] as const) {
      const { hud, last } = makeFakeHud();
      syncHudFrame(hud, frame({ phase }), CTX);
      assert.deepEqual(last('setDelta'), expected, `${phase} 的 delta 显示不对`);
    }
  });

  it('只有比赛中且本圈确实无效时才挂"本圈无效"', () => {
    const cases: [HudFrame['phase'], boolean, boolean][] = [
      ['racing', true, true],
      ['racing', false, false],
      ['countdown', true, false],
      ['finished', true, false],
    ];
    for (const [phase, invalid, expected] of cases) {
      const { hud, last } = makeFakeHud();
      syncHudFrame(hud, frame({ phase, currentLapInvalid: invalid }), CTX);
      assert.deepEqual(last('setLapValidity'), [expected], `${phase}/invalid=${invalid} 判断不对`);
    }
  });

  it('漂移状态与漂移角原样传给 HUD', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ drifting: true, driftAngle: 0.13 }), CTX);
    assert.deepEqual(last('setDrift'), [true, 0.13]);
  });

  it('车速 / 路面 / FPS 每帧都刷新', () => {
    const { hud, last } = makeFakeHud();
    syncHudFrame(hud, frame({ speedKmh: 187, onTrack: false }), CTX);
    assert.deepEqual(last('setSpeed'), [187]);
    assert.deepEqual(last('setSurface'), [false]);
    assert.deepEqual(last('setFps'), [60]);
  });
});

describe('最佳圈与幽灵车的 HUD 同步', () => {
  it('最佳圈：本场最佳优先', () => {
    const { hud, last } = makeFakeHud();
    syncHudBestLap(hud, 16_000, 16_995);
    assert.deepEqual(last('setBestLap'), [16_000], '本场已经跑出更好成绩时该显示本场的');
  });

  it('最佳圈：本场还没有有效圈时回落到历史最佳（玩家始终有目标可追）', () => {
    const { hud, last } = makeFakeHud();
    syncHudBestLap(hud, null, 16_995);
    assert.deepEqual(last('setBestLap'), [16_995]);
  });

  it('最佳圈：两边都没有时显示 null（HUD 渲染成 --:--.---）', () => {
    const { hud, last } = makeFakeHud();
    syncHudBestLap(hud, null, null);
    assert.deepEqual(last('setBestLap'), [null]);
  });

  it('幽灵车：时间差与"是否可用"一起传', () => {
    const { hud, last } = makeFakeHud();
    syncHudGhost(hud, -16_484, true);
    assert.deepEqual(last('setGhostStatus'), [-16_484, true]);

    syncHudGhost(hud, null, false);
    assert.deepEqual(last('setGhostStatus'), [null, false]);
  });
});

describe('重开比赛时的 HUD 复位', () => {
  it('把所有"上一场的残留"清干净', () => {
    const { hud, last } = makeFakeHud();
    resetHudForNewRace(hud, CTX);
    assert.deepEqual(last('setLap'), [1, 3], '圈数回到第 1 圈');
    assert.deepEqual(last('setLapTime'), [0], '圈速清零');
    assert.deepEqual(last('setTotalTime'), [0], '总时间清零');
    assert.deepEqual(last('setDelta'), [null, null], 'delta 必须隐藏（否则挂着上一场的差值）');
    assert.deepEqual(last('setLapValidity'), [false], '"本圈无效"标记必须撤掉');
    assert.deepEqual(last('setDrift'), [false, 0]);
    assert.deepEqual(last('setGhostStatus'), [null, false]);
    assert.deepEqual(last('setDifficulty'), ['normal', '普通']);
    assert.deepEqual(last('setTrack'), ['track1', '环城赛道']);
    assert.deepEqual(last('setBestLap'), [16_995], '复位后最佳圈回落到历史最佳');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankRacers } from '../src/game/Ranking';
import type { RacerProgress } from '../src/game/types';

const TOTAL = 1000;

function racer(id: string, overrides: Partial<RacerProgress> = {}): RacerProgress {
  return {
    id,
    lapsCompleted: 0,
    lapArc: 0,
    finished: false,
    finishMs: null,
    isPlayer: false,
    ...overrides,
  };
}

/** 按名次顺序取 id 列表，方便断言。 */
function order(entries: readonly RacerProgress[]): string[] {
  return rankRacers(entries, TOTAL).map((r) => r.id);
}

describe('rankRacers 基本行为', () => {
  it('空数组返回空数组', () => {
    assert.deepEqual(rankRacers([], TOTAL), []);
  });

  it('名次从 1 开始连续编号', () => {
    const ranked = rankRacers([racer('a'), racer('b'), racer('c')], TOTAL);
    assert.deepEqual(
      ranked.map((r) => r.rank),
      [1, 2, 3],
    );
  });

  it('totalProgressPx = 圈数 × 赛道长度 + 本圈弧长', () => {
    const ranked = rankRacers([racer('a', { lapsCompleted: 2, lapArc: 345 })], TOTAL);
    assert.equal(ranked[0].totalProgressPx, 2 * TOTAL + 345);
    assert.equal(ranked[0].lapsCompleted, 2);
    assert.equal(ranked[0].lapArc, 345);
  });

  it('不改动传入的数组与元素', () => {
    const input = [racer('a', { lapArc: 10 }), racer('b', { lapArc: 20 })];
    const snapshot = input.map((r) => ({ ...r }));
    rankRacers(input, TOTAL);
    assert.deepEqual(input, snapshot);
    assert.equal('rank' in input[0], false, 'rank 只应出现在返回结果里');
  });
});

describe('rankRacers 完赛优先与完赛时间', () => {
  it('已完赛的排在未完赛的前面（哪怕未完赛者进度更多）', () => {
    const finishedButSlow = racer('winner', { finished: true, finishMs: 90_000, lapsCompleted: 3 });
    const unfinishedButFar = racer('runner', { lapsCompleted: 2, lapArc: 990 });
    assert.deepEqual(order([unfinishedButFar, finishedButSlow]), ['winner', 'runner']);
  });

  it('都完赛时按 finishMs 升序', () => {
    const entries = [
      racer('slow', { finished: true, finishMs: 5000 }),
      racer('fast', { finished: true, finishMs: 3000 }),
      racer('mid', { finished: true, finishMs: 4000 }),
    ];
    assert.deepEqual(order(entries), ['fast', 'mid', 'slow']);
  });

  it('finished=true 但 finishMs 为 null 的数据异常排在同组最后', () => {
    const entries = [
      racer('broken', { finished: true, finishMs: null }),
      racer('ok', { finished: true, finishMs: 8000 }),
    ];
    assert.deepEqual(order(entries), ['ok', 'broken']);
  });
});

describe('rankRacers 未完赛按进度', () => {
  it('同圈数按本圈弧长降序', () => {
    const entries = [
      racer('behind', { lapsCompleted: 1, lapArc: 100 }),
      racer('ahead', { lapsCompleted: 1, lapArc: 800 }),
      racer('middle', { lapsCompleted: 1, lapArc: 500 }),
    ];
    assert.deepEqual(order(entries), ['ahead', 'middle', 'behind']);
  });

  it('圈数优先于本圈弧长：多一圈的永远在前', () => {
    const entries = [
      racer('twoLaps', { lapsCompleted: 2, lapArc: 5 }),
      racer('oneLapFar', { lapsCompleted: 1, lapArc: 995 }),
      racer('oneLapNear', { lapsCompleted: 1, lapArc: 10 }),
    ];
    const ranked = rankRacers(entries, TOTAL);
    assert.deepEqual(
      ranked.map((r) => r.id),
      ['twoLaps', 'oneLapFar', 'oneLapNear'],
    );
    assert.deepEqual(
      ranked.map((r) => r.totalProgressPx),
      [2005, 1995, 1010],
    );
  });

  it('刚过终点线（lapArc 归零）不会掉到同圈车手后面', () => {
    const entries = [
      racer('justCrossed', { lapsCompleted: 1, lapArc: 0 }),
      racer('aboutToCross', { lapsCompleted: 0, lapArc: 999 }),
    ];
    assert.deepEqual(order(entries), ['justCrossed', 'aboutToCross']);
  });
});

describe('rankRacers 并列与稳定性', () => {
  it('进度完全并列时玩家优先', () => {
    const entries = [
      racer('ai-a', { lapsCompleted: 1, lapArc: 400 }),
      racer('player', { lapsCompleted: 1, lapArc: 400, isPlayer: true }),
      racer('ai-b', { lapsCompleted: 1, lapArc: 400 }),
    ];
    assert.deepEqual(order(entries), ['player', 'ai-a', 'ai-b']);
  });

  it('都完赛且时间并列时玩家优先', () => {
    const entries = [
      racer('ai', { finished: true, finishMs: 60_000 }),
      racer('player', { finished: true, finishMs: 60_000, isPlayer: true }),
    ];
    assert.deepEqual(order(entries), ['player', 'ai']);
  });

  it('非玩家并列时按 id 字典序，保证结果稳定', () => {
    const entries = [
      racer('zoe', { lapsCompleted: 1, lapArc: 7 }),
      racer('amy', { lapsCompleted: 1, lapArc: 7 }),
      racer('moe', { lapsCompleted: 1, lapArc: 7 }),
    ];
    assert.deepEqual(order(entries), ['amy', 'moe', 'zoe']);
    // 输入顺序换一下，结果必须一致
    assert.deepEqual(order([...entries].reverse()), ['amy', 'moe', 'zoe']);
  });

  it('一整场比赛：玩家第 2、两台 AI 一完赛一未完赛', () => {
    const entries = [
      racer('ai-blue', { finished: true, finishMs: 154_300, lapsCompleted: 3 }),
      racer('player', { finished: true, finishMs: 158_900, lapsCompleted: 3, isPlayer: true }),
      racer('ai-green', { lapsCompleted: 2, lapArc: 610 }),
    ];
    const ranked = rankRacers(entries, 7532.23);
    assert.deepEqual(
      ranked.map((r) => [r.rank, r.id]),
      [
        [1, 'ai-blue'],
        [2, 'player'],
        [3, 'ai-green'],
      ],
    );
    assert.equal(ranked[2].finishMs, null);
  });
});

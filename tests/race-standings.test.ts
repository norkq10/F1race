import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ETA_DISPLAY_MIN_GAP_MS,
  computeStandings,
  estimateFinishMs,
  formatEstimate,
  progressLabelFor,
  rebasePlayerOnly,
  toStandingEntries,
  toStandingRows,
  type StandingsInput,
} from '../src/game/RaceStandings';

const TOTAL = 7500;

/** 造一份进度快照。 */
function racer(
  id: string,
  opts: Partial<StandingsInput> & { laps?: number; arc?: number } = {},
): StandingsInput {
  return {
    id,
    name: id === 'player' ? '玩家' : id,
    isPlayer: id === 'player',
    lapsCompleted: opts.laps ?? opts.lapsCompleted ?? 0,
    lapArc: opts.arc ?? opts.lapArc ?? 0,
    finished: opts.finished ?? false,
    finishMs: opts.finishMs ?? null,
    color: opts.color ?? 0x123456,
  };
}

/**
 * 排名与进度基准。
 *
 * ⚠️ 本文件的两组用例分别锁住 `docs/known-issues.md` 第 9 条与第 10 条：
 *   第 9 条：排名必须**跟着进度每帧变**，不能是发车瞬间的快照；
 *   第 10 条：进度基准**只能对齐玩家**，不能连 AI 一起 rebase。
 * 这两条以前没有测试（逻辑埋在 Phaser 场景里），所以 bug 藏了很久。
 */
describe('排名计算 RaceStandings（known-issues 第 9 条回归）', () => {
  it('名次跟着进度变化 —— 同一批车、进度一变名次就变', () => {
    // 第一次：玩家领先
    const leading = computeStandings(
      [racer('player', { arc: 5000 }), racer('ai1', { arc: 1000 })],
      TOTAL,
    );
    assert.equal(leading.playerRank, 1);

    // 第二次：同样的车，只是进度反过来了 —— 名次必须跟着翻。
    // 这一条正是"排名整场是发车瞬间的快照"那个 bug 的回归：它要求
    // computeStandings 是**每帧调用**的纯函数，而不是只在开局算一次。
    const trailing = computeStandings(
      [racer('player', { arc: 1000 }), racer('ai1', { arc: 5000 })],
      TOTAL,
    );
    assert.equal(trailing.playerRank, 2, '进度被反超后名次必须跟着变');
  });

  it('圈数优先于本圈弧长（跑完 1 圈一定领先没跑完的）', () => {
    const r = computeStandings(
      [racer('player', { laps: 0, arc: TOTAL - 10 }), racer('ai1', { laps: 1, arc: 5 })],
      TOTAL,
    );
    assert.equal(r.ranking[0].id, 'ai1');
    assert.equal(r.playerRank, 2);
  });

  it('已完赛的排在未完赛前面，都完赛按时间升序', () => {
    const r = computeStandings(
      [
        racer('player', { laps: 3, arc: TOTAL }),
        racer('ai1', { finished: true, finishMs: 60_000, laps: 3 }),
        racer('ai2', { finished: true, finishMs: 50_000, laps: 3 }),
      ],
      TOTAL,
    );
    assert.deepEqual(
      r.ranking.map((e) => e.id),
      ['ai2', 'ai1', 'player'],
    );
  });

  it('总进度 = 圈数 × 赛道长度 + 本圈弧长', () => {
    const r = computeStandings([racer('player', { laps: 2, arc: 1234 })], TOTAL);
    assert.equal(r.progressPx.get('player'), 2 * TOTAL + 1234);
  });

  it('完全并列时玩家优先，且多次调用结果完全一致（名次不抖动）', () => {
    const inputs = [racer('ai1', { arc: 2000 }), racer('player', { arc: 2000 })];
    const a = computeStandings(inputs, TOTAL);
    const b = computeStandings(inputs, TOTAL);
    assert.equal(a.playerRank, 1, '并列时玩家优先');
    assert.deepEqual(
      a.ranking.map((e) => e.id),
      b.ranking.map((e) => e.id),
      '同一份输入多次计算结果必须一致，否则 HUD 名次会随数组顺序抖',
    );
  });

  it('只有一台车时玩家名次为 1', () => {
    const r = computeStandings([racer('player')], TOTAL);
    assert.equal(r.playerRank, 1);
    assert.equal(r.ranking.length, 1);
  });

  it('空数组不抛异常，玩家名次兜底为 1', () => {
    const r = computeStandings([], TOTAL);
    assert.equal(r.ranking.length, 0);
    assert.equal(r.playerRank, 1);
  });

  it('HUD 行：冠军显示总时间，其余显示与冠军的差距', () => {
    const inputs = [
      racer('ai1', { finished: true, finishMs: 50_000, laps: 3 }),
      racer('player', { finished: true, finishMs: 51_500, laps: 3 }),
    ];
    const rows = toStandingRows(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 3, false),
    );
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].gap, '0:50.000', '冠军显示自己的总时间');
    assert.equal(rows[1].gap, '+1.500', '其余显示与冠军的差距');
  });

  it('HUD 行：未完赛显示"第 N 圈"，且不会超过总圈数', () => {
    const inputs = [racer('player', { laps: 1, arc: 100 })];
    const rows = toStandingRows(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 3, false),
    );
    assert.equal(rows[0].gap, '第 2 圈');
    // 圈数越界时钳到总圈数，不会出现"第 5 圈"
    const capped = toStandingRows(
      computeStandings([racer('player', { laps: 9, arc: 0 })], TOTAL).ranking,
      [racer('player', { laps: 9, arc: 0 })],
      (e) => progressLabelFor(e, 3, false),
    );
    assert.equal(capped[0].gap, '第 3 圈');
  });

  it('单程赛道：未完赛的进度文案是"进行中"，不是"第 1 圈"', () => {
    // 「漂移龙」只有一个"趟"，说"第 1 圈"会让玩家以为还要再跑一圈。
    const inputs = [racer('player', { laps: 0, arc: 800 })];
    const rows = toStandingRows(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 1, true),
    );
    assert.equal(rows[0].gap, '进行中');
    const entries = toStandingEntries(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 1, true),
    );
    assert.equal(entries[0].progressLabel, '进行中');
  });

  it('结算条目带配色与与冠军的差距', () => {
    const inputs = [
      racer('ai1', { finished: true, finishMs: 50_000, color: 0x3ba7ff }),
      racer('player', { finished: true, finishMs: 52_000, color: 0xe23c38 }),
    ];
    const entries = toStandingEntries(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 3, false),
    );
    assert.equal(entries[0].color, 0x3ba7ff);
    assert.equal(entries[1].color, 0xe23c38, '配色必须原样带出来（领奖台小人要用）');
    assert.equal(entries[0].gapMs, 0);
    assert.equal(entries[1].gapMs, 2000);
  });

  it('结算条目：未完赛的车给进度描述、时间与差距都是 null', () => {
    const inputs = [racer('player', { laps: 1, arc: 500 }), racer('ai1', { finished: true, finishMs: 40_000 })];
    const entries = toStandingEntries(
      computeStandings(inputs, TOTAL).ranking,
      inputs,
      (e) => progressLabelFor(e, 3, false),
    );
    const me = entries.find((e) => e.isPlayer);
    assert.ok(me);
    assert.equal(me.totalMs, null);
    assert.equal(me.gapMs, null, '冠军没完赛时大家都算不出差距');
    assert.equal(me.progressLabel, '第 2 圈');
  });
});

describe('进度基准同步（known-issues 第 10 条回归）', () => {
  /** 带记录功能的假计时器。 */
  function makeRacers() {
    const calls: string[] = [];
    const racers = [
      { isPlayer: true, rebase: (arc: number) => calls.push(`player:${arc}`) },
      { isPlayer: false, rebase: (arc: number) => calls.push(`ai1:${arc}`) },
      { isPlayer: false, rebase: (arc: number) => calls.push(`ai2:${arc}`) },
    ];
    return { racers, calls };
  }

  it('只对齐玩家，绝不碰 AI 的基准', () => {
    const { racers, calls } = makeRacers();
    rebasePlayerOnly(racers, 4242);
    assert.deepEqual(calls, ['player:4242'], 'rebase 只该作用在玩家身上');
  });

  it('返回对齐后的 arc，方便调用方记录', () => {
    const { racers } = makeRacers();
    assert.equal(rebasePlayerOnly(racers, 777), 777);
  });

  it('没有玩家时不抛异常', () => {
    const calls: string[] = [];
    const ais = [{ isPlayer: false, rebase: (arc: number) => calls.push(`ai:${arc}`) }];
    assert.doesNotThrow(() => rebasePlayerOnly(ais, 100));
    assert.deepEqual(calls, [], '没有玩家时不该 rebase 任何 AI');
  });

  it('空数组不抛异常', () => {
    assert.doesNotThrow(() => rebasePlayerOnly([], 100));
  });
});

/**
 * 未完赛 AI 的预计完赛时间（known-issues 第 9 条）。
 *
 * 玩家冲线即结束比赛，其他车还在跑 —— 原本结算里它们只有"第 3 圈"，
 * 读者没法判断"到底还差多少"。这组测试钉住外推算法的三条防护：
 * 不足半圈不估、不把本圈折成部分圈、除零保护。
 */
describe('预计完赛时间 estimateFinishMs', () => {
  const base = { totalLength: 7500, lapCount: 3, elapsedMs: 50_000 };

  it('跑完一圈时外推结果与实际均速一致', () => {
    // 跑完 1 圈花了 50 秒 → 均速 150px/s → 3 圈需要 150 秒
    const est = estimateFinishMs({ ...base, lapsCompleted: 1, lapArc: 0 });
    assert.equal(est, 150_000);
  });

  it('本圈进度计入已跑距离（但不折成部分圈）', () => {
    // 1 整圈 + 半圈 = 11250px / 50s → 3 圈 22500px 需要 100s
    const est = estimateFinishMs({ ...base, lapsCompleted: 1, lapArc: 3750 });
    assert.equal(est, 100_000);
  });

  it('不足半圈时返回 null（起跑加速阶段平均速度没有代表性）', () => {
    assert.equal(estimateFinishMs({ ...base, lapsCompleted: 0, lapArc: 3000 }), null);
    assert.equal(
      estimateFinishMs({ ...base, lapsCompleted: 0, lapArc: 3749 }),
      null,
      '刚好差一点到半圈也不估',
    );
  });

  it('刚好半圈就开始估（边界可取）', () => {
    assert.notEqual(estimateFinishMs({ ...base, lapsCompleted: 0, lapArc: 3750 }), null);
  });

  it('已经跑完时返回 null（不该再估一个"未来"时间）', () => {
    assert.equal(estimateFinishMs({ ...base, lapsCompleted: 3, lapArc: 0 }), null);
  });

  it('已用时间为 0 / 负数时返回 null（除零保护）', () => {
    assert.equal(estimateFinishMs({ ...base, elapsedMs: 0, lapsCompleted: 1, lapArc: 0 }), null);
    assert.equal(estimateFinishMs({ ...base, elapsedMs: -5, lapsCompleted: 1, lapArc: 0 }), null);
  });

  it('非法赛道参数时返回 null', () => {
    assert.equal(estimateFinishMs({ ...base, totalLength: 0, lapsCompleted: 1, lapArc: 0 }), null);
    assert.equal(estimateFinishMs({ ...base, lapCount: 0, lapsCompleted: 1, lapArc: 0 }), null);
  });

  it('本圈弧长越界时被钳到 [0, 单圈长度]', () => {
    const a = estimateFinishMs({ ...base, lapsCompleted: 1, lapArc: -100 });
    const b = estimateFinishMs({ ...base, lapsCompleted: 1, lapArc: 0 });
    assert.equal(a, b, '负弧长应按 0 处理');
    const c = estimateFinishMs({ ...base, lapsCompleted: 1, lapArc: 99_999 });
    const d = estimateFinishMs({ ...base, lapsCompleted: 2, lapArc: 0 });
    assert.equal(c, d, '超长弧长应被钳到一整圈');
  });

  it('结果永远大于已用时间（估计的是"完赛"而不是"当前"）', () => {
    for (const laps of [0, 1, 2]) {
      for (const arc of [0, 1875, 3750, 7500]) {
        const est = estimateFinishMs({ ...base, lapsCompleted: laps, lapArc: arc });
        if (est !== null) assert.ok(est > base.elapsedMs, `laps=${laps} arc=${arc} 估出 ${est}`);
      }
    }
  });
});

describe('预计完赛时间的显示', () => {
  it('格式化成"预计 m:ss.s"（只到 0.1 秒，提示这是估计值）', () => {
    assert.equal(formatEstimate(64_200), '预计 1:04.2');
    assert.equal(formatEstimate(48_000), '预计 0:48.0');
    assert.equal(formatEstimate(125_500), '预计 2:05.5');
  });

  it('非法输入给占位符而不是 NaN', () => {
    assert.equal(formatEstimate(null), '预计 --:--');
    assert.equal(formatEstimate(undefined), '预计 --:--');
    assert.equal(formatEstimate(Number.NaN), '预计 --:--');
  });
});

describe('HUD 排名里的预计完赛时间', () => {
  /** 造一场"玩家已完赛、AI 还在跑"的局面。 */
  function playerFinishedScene() {
    const inputs: StandingsInput[] = [
      racer('player', { finished: true, finishMs: 50_000, laps: 3, arc: 0 }),
      // AI 落后很多：只跑完 1 圈，用时也是 50 秒 → 预计 150 秒
      racer('ai1', { laps: 1, arc: 0 }),
      // AI 紧跟其后：1 圈 + 跑了大半圈，预计时间与玩家差距小于门槛
      racer('ai2', { laps: 2, arc: TOTAL * 0.9 }),
    ];
    return { inputs, ranking: computeStandings(inputs, TOTAL).ranking };
  }

  it('落后足够多的未完赛车显示"预计 m:ss.s"', () => {
    const { inputs, ranking } = playerFinishedScene();
    const rows = toStandingRows(ranking, inputs, (e) => progressLabelFor(e, 3, false), {
      totalLength: TOTAL,
      elapsedMs: 50_000,
      playerFinishMs: 50_000,
      lapCount: 3,
    });
    const ai1 = rows.find((r) => r.name === 'ai1');
    assert.ok(ai1);
    assert.ok(ai1.gap.startsWith('预计 '), `ai1 应显示预计时间，实际 "${ai1.gap}"`);
  });

  it('紧跟玩家的未完赛车仍显示"第 N 圈"（不拿估计值替换真实进度）', () => {
    const { inputs, ranking } = playerFinishedScene();
    const rows = toStandingRows(ranking, inputs, (e) => progressLabelFor(e, 3, false), {
      totalLength: TOTAL,
      elapsedMs: 50_000,
      playerFinishMs: 50_000,
      lapCount: 3,
    });
    const ai2 = rows.find((r) => r.name === 'ai2');
    assert.ok(ai2);
    assert.equal(ai2.gap, '第 3 圈', `ai2 差得不够多，应显示圈数，实际 "${ai2.gap}"`);
  });

  it('不传 context 时全部退回"第 N 圈"（向后兼容）', () => {
    const { inputs, ranking } = playerFinishedScene();
    const rows = toStandingRows(ranking, inputs, (e) => progressLabelFor(e, 3, false));
    for (const row of rows.filter((r) => !r.finished)) {
      assert.ok(row.gap.startsWith('第 '), `实际 "${row.gap}"`);
    }
  });

  it('已完赛的车不受影响（仍然显示总时间 / 差距）', () => {
    const { inputs, ranking } = playerFinishedScene();
    const rows = toStandingRows(ranking, inputs, (e) => progressLabelFor(e, 3, false), {
      totalLength: TOTAL,
      elapsedMs: 50_000,
      playerFinishMs: 50_000,
      lapCount: 3,
    });
    const me = rows.find((r) => r.isPlayer);
    assert.ok(me);
    assert.equal(me.gap, '0:50.000');
    assert.ok(!me.gap.includes('预计'));
  });

  it('门槛是正数且量级合理（不是 0 也不是几十秒）', () => {
    assert.ok(ETA_DISPLAY_MIN_GAP_MS > 0 && ETA_DISPLAY_MIN_GAP_MS < 30_000, `门槛 ${ETA_DISPLAY_MIN_GAP_MS} 不合理`);
  });
});

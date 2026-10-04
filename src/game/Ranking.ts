import type { RacerProgress, RankedRacer } from './types';

/**
 * 名次计算（M5 / REQ-016）。
 *
 * 纯逻辑、无副作用：输入一份进度快照，输出带 `rank` 与 `totalProgressPx` 的排序结果。
 * 排序规则（冻结契约）：
 *  1. 已完赛的排在未完赛前面；都完赛按 `finishMs` 升序；
 *  2. 都未完赛按 `totalProgressPx`（= lapsCompleted × totalLength + lapArc）降序；
 *  3. 完全并列时玩家优先，其次按 id 字典序 —— 保证同一帧多次调用结果完全一致，
 *     否则 HUD 上的名次会随数组顺序抖动。
 */
export function rankRacers(entries: readonly RacerProgress[], totalLength: number): RankedRacer[] {
  const ranked = entries.map((entry) => ({
    ...entry,
    rank: 0,
    totalProgressPx: entry.lapsCompleted * totalLength + entry.lapArc,
  }));

  ranked.sort(compare);

  for (let i = 0; i < ranked.length; i++) ranked[i].rank = i + 1;
  return ranked;
}

/** 比较函数：越靠前越"领先"。 */
function compare(a: RankedRacer, b: RankedRacer): number {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;

  if (a.finished) {
    // finishMs 为 null 只可能是数据异常（finished=true 却没有时间），
    // 兜底当作"最慢"，不让它插到正常完赛者前面。
    const aMs = a.finishMs ?? Number.POSITIVE_INFINITY;
    const bMs = b.finishMs ?? Number.POSITIVE_INFINITY;
    if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  } else if (a.totalProgressPx !== b.totalProgressPx) {
    return a.totalProgressPx > b.totalProgressPx ? -1 : 1;
  }

  if (a.isPlayer !== b.isPlayer) return a.isPlayer ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

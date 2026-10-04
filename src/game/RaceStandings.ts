/**
 * RaceStandings.ts
 * 排名与进度基准（纯逻辑，**不 import Phaser**，可直接单元测试）。
 *
 * 这里装着 `docs/known-issues.md` 记录的两个最隐蔽的 bug，所以它值得单独成模块：
 *
 *  - **第 9 条**：`updateRanking()` 没进每帧循环 → 排名整场都是发车瞬间的快照。
 *    本模块把"由进度算排名"变成纯函数，测试可以直接断言"进度变了、名次跟着变"。
 *  - **第 10 条**：`syncProgressBaseline()` 原本遍历全部 racer → 瞬移调试把 AI 的
 *    基准一起改了，AI 圈数凭空错乱。`rebasePlayerOnly()` 从命名上就只碰玩家。
 *
 * 设计取舍：本模块不认识 `Vehicle` / `LapTimer`，只吃一份"快照数组"。
 * 场景负责把计时器读数拍成快照（`collect()` 那一步），其余全是纯计算。
 */

import { formatEstimate } from './format';
import { rankRacers } from './Ranking';
import type { RankedRacer, RacerProgress, StandingEntry } from './types';

/** 一名参赛者的进度快照 —— 本模块的唯一输入。 */
export interface StandingsInput {
  id: string;
  name: string;
  isPlayer: boolean;
  /** 已完成圈数。 */
  lapsCompleted: number;
  /** 本圈已跑弧长（像素）。 */
  lapArc: number;
  /** 是否已完赛。 */
  finished: boolean;
  /** 完赛总时间；未完赛为 null。 */
  finishMs: number | null;
  /** 车手配色（小地图 / 领奖台共用）。 */
  color: number;
}

/** HUD 排名列表里的一行。 */
export interface StandingRow {
  rank: number;
  name: string;
  isPlayer: boolean;
  finished: boolean;
  /** 冠军显示总时间，其余显示与冠军的差距；未完赛显示"第 N 圈"。 */
  gap: string;
}

/** 结算用的排名结果。 */
export interface StandingsResult {
  /** 排好序的名次表。 */
  ranking: RankedRacer[];
  /** 玩家名次（1 基）。 */
  playerRank: number;
  /** 每名参赛者的总进度（像素），key = id。 */
  progressPx: Map<string, number>;
}

/**
 * 落后这么多毫秒以上的未完赛 AI，才改用"预计完赛时间"显示（known-issues 第 9 条）。
 *
 * 为什么设门槛：玩家冲线即结束比赛，未完赛的 AI 只能按进度排名，
 * HUD 上显示"第 3 圈" —— 读者没法判断"它到底还差多少"。
 * 预计时间能回答这个问题，但它终究是**外推**，误差随剩余距离变大。
 *
 * 折中：只对落后足够多的车显示。紧跟玩家的那台车不显示 ——
 * 那才是玩家真正在意的对手，它的差距用圈数表达更实在，
 * 不该被一个估计值替换掉。
 */
export const ETA_DISPLAY_MIN_GAP_MS = 3000;

/** 估算未完赛车完赛总时间所需的输入。 */
export interface FinishEstimateInput {
  /** 已完成圈数。 */
  lapsCompleted: number;
  /** 本圈已跑弧长（像素）。 */
  lapArc: number;
  /** 比赛已进行的总时长（毫秒）。 */
  elapsedMs: number;
  /** 单圈长度（像素）。 */
  totalLength: number;
  /** 要跑的总圈数。 */
  lapCount: number;
}

/**
 * 由"已跑的距离 ÷ 已花的时间"外推完赛总时间（毫秒）；样本不足时返回 null。
 *
 * 刻意**用"整圈 + 本圈进度"而不是"估计的单圈时间"**：后者在 AI 还没跑完
 * 第一圈时无数据可用 —— 而那正是最需要它的时候。
 *
 * 三道防护，都是为了不估出荒唐数字：
 *
 *  1. **本圈不算成部分圈**：`lapsCompleted` 只计**跑完**的圈，本圈进度单独加。
 *     若把本圈按比例折成"部分圈"，第一圈刚起步（进度 1%）时就会拿
 *     1% 的圈去比 100% 的距离，估出的时间离谱地长。
 *  2. **不足半圈不估**：起跑加速阶段的平均速度没有代表性。
 *  3. **已用时间为 0 不估**：避免除零。
 *
 * 已知偏差（写在这里免得以后被当 bug 查）：它假设剩余路程按**平均**速度跑。
 * 实际单圈会随熟悉度变快，所以估算**偏保守（偏慢）**。
 * 对"让玩家知道对手大概还有多久回来"这个用途，偏保守是安全的方向。
 */
export function estimateFinishMs(input: FinishEstimateInput): number | null {
  const { lapsCompleted, lapArc, elapsedMs, totalLength, lapCount } = input;
  if (elapsedMs <= 0 || totalLength <= 0 || lapCount <= 0) return null;

  const targetDistance = totalLength * lapCount;
  const doneDistance = lapsCompleted * totalLength + Math.max(0, Math.min(totalLength, lapArc));
  if (doneDistance < totalLength * 0.5) return null;
  if (doneDistance >= targetDistance) return null; // 已经跑完了，不该再估

  const speed = doneDistance / elapsedMs; // 像素/毫秒
  if (!Number.isFinite(speed) || speed <= 0) return null;
  const totalMs = targetDistance / speed;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return null;
  return totalMs;
}

/** 把预计完赛时间格式化的实现在 `format.ts`（与其它格式化函数同处），这里转出去方便使用。 */
export { formatEstimate };

/** 把毫秒格式化成 `m:ss.mmm`（与 HUD 一致）。 */
function formatTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--:--.---';
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * 未完赛者在排名里的进度文案。
 *
 * - 闭环：「第 N 圈」，N 封顶在总圈数（不会出现"第 5 圈"）。
 * - **单程**（`open`）：「进行中」。它只有一趟，"第 1 圈"会让玩家以为还要跑一圈。
 *
 * 之所以做成模块级的纯函数（而不是留在场景里）：场景与单元测试都要用它，
 * 而"文案规则"是排名这套逻辑的一部分，放在这里两边不会漂移。
 */
export function progressLabelFor(
  entry: Pick<RankedRacer, 'lapsCompleted'>,
  lapCount: number,
  open: boolean,
): string {
  if (open) return '进行中';
  return `第 ${Math.min(entry.lapsCompleted + 1, lapCount)} 圈`;
}

/**
 * 由进度快照算出完整排名。
 *
 * **每帧都要调用它** —— 第 9 条 bug 就是"只在 create / reset / finish 调用"，
 * 导致比赛途中名次一直是发车时的快照。所以这个函数刻意做成无状态纯函数，
 * 调用成本只有 O(n log n)，n ≤ 4。
 */
export function computeStandings(
  racers: readonly StandingsInput[],
  totalLength: number,
): StandingsResult {
  const entries: RacerProgress[] = racers.map((racer) => ({
    id: racer.id,
    lapsCompleted: racer.lapsCompleted,
    lapArc: racer.lapArc,
    finished: racer.finished,
    finishMs: racer.finishMs,
    isPlayer: racer.isPlayer,
  }));

  const ranking = rankRacers(entries, totalLength);
  const progressPx = new Map<string, number>();
  for (const entry of ranking) progressPx.set(entry.id, entry.totalProgressPx);

  return {
    ranking,
    playerRank: ranking.find((entry) => entry.isPlayer)?.rank ?? 1,
    progressPx,
  };
}

/**
 * 把排名结果渲染成 HUD 的行。
 *
 * `progressLabel` 由调用方传入而不是从 TUNING 读 ——
 * 这个模块不依赖任何全局配置，测试可以随便造数据。
 * `totalLength` / `elapsedMs` 只用于估算未完赛车的完赛时间（known-issues 第 9 条）。
 *
 * ⚠️ 为什么进度文案是**回调**而不是 `lapCount` 数字：本项目有**单程赛道**
 * （`TrackMeta.open`，跑完一趟就完赛）。那种图上"第 1 圈"是没有意义的说法
 * —— 玩家看到会以为还有第二圈。把文案的决定权交回集成层，纯逻辑模块不必知道拓扑。
 *
 * @param context 估算预计完赛时间所需的上下文；不传就只用 `progressLabel`
 */
export function toStandingRows(
  ranking: readonly RankedRacer[],
  racers: readonly StandingsInput[],
  progressLabel: (entry: RankedRacer) => string,
  context?: { totalLength: number; elapsedMs: number; playerFinishMs: number | null; lapCount: number },
): StandingRow[] {
  const byId = new Map(racers.map((r) => [r.id, r]));
  const leader = ranking[0];
  const leaderMs = leader && leader.finished ? leader.finishMs : null;
  // 已完赛的最慢者时间，用来判断"落后多少"（没有完赛者时为 null）
  const slowestFinishedMs = ranking.reduce<number | null>(
    (acc, e) => (e.finishMs === null ? acc : acc === null ? e.finishMs : Math.max(acc, e.finishMs)),
    null,
  );

  return ranking.map((entry) => {
    const racer = byId.get(entry.id);
    let gap: string;
    if (entry.finishMs !== null) {
      // 冠军（与自己的差距为 0）显示总时间；其余显示 `+差距`。
      // 判据是"差距 > 0"而不是"冠军时间 > 0"：后者在冠军跑出极小时间时
      // 会误判成普通选手，把冠军也显示成 +0.000。
      const behindMs = leaderMs !== null ? entry.finishMs - leaderMs : 0;
      gap = behindMs > 0 ? `+${(behindMs / 1000).toFixed(3)}` : formatTime(entry.finishMs);
    } else {
      gap = progressLabel(entry);
      // 落后足够多时改用预计完赛时间：读者能直接看出"它还差多久回来"
      // （known-issues 第 9 条：未完赛的 AI 只有圈数、没有时间）。
      if (context && racer) {
        const estimate = estimateFinishMs({
          lapsCompleted: racer.lapsCompleted,
          lapArc: racer.lapArc,
          elapsedMs: context.elapsedMs,
          totalLength: context.totalLength,
          lapCount: context.lapCount,
        });
        if (estimate !== null) {
          const referenceMs = context.playerFinishMs ?? slowestFinishedMs;
          const behind = referenceMs === null ? Number.POSITIVE_INFINITY : estimate - referenceMs;
          if (behind >= ETA_DISPLAY_MIN_GAP_MS) gap = formatEstimate(estimate);
        }
      }
    }
    return {
      rank: entry.rank,
      name: racer?.name ?? entry.id,
      isPlayer: entry.isPlayer,
      finished: entry.finished,
      gap,
    };
  });
}

/**
 * 结算界面用的排行榜（含配色与"与冠军的差距"）。
 *
 * 与 `toStandingRows` 的区别：那个给 HUD 的紧凑列表用，
 * 这个给结算面板用（要显示总时间 + 差距 + 进度描述 + 配色）。
 * 同样用 `progressLabel` 回调决定"未完赛"的文案（单程赛道不能说"第 N 圈"）。
 */
export function toStandingEntries(
  ranking: readonly RankedRacer[],
  racers: readonly StandingsInput[],
  progressLabel: (entry: RankedRacer) => string,
): StandingEntry[] {
  const byId = new Map(racers.map((r) => [r.id, r]));
  const leader = ranking[0];
  const leaderMs = leader && leader.finished ? leader.finishMs : null;

  return ranking.map((entry) => {
    const racer = byId.get(entry.id);
    return {
      // id 必须带出来：结算要拿它去按 id 索引的表（如 finishEstimatesMs）里查东西。
      // 用 name 查会失败 —— name 是显示文案，不是稳定键。
      id: entry.id,
      rank: entry.rank,
      name: racer?.name ?? entry.id,
      isPlayer: entry.isPlayer,
      totalMs: entry.finishMs,
      gapMs: entry.finishMs !== null && leaderMs !== null ? entry.finishMs - leaderMs : null,
      progressLabel: entry.finishMs === null ? progressLabel(entry) : null,
      color: racer?.color ?? 0xffffff,
    };
  });
}

/**
 * 只把**玩家**的计时基准对齐到当前位置。
 *
 * ⚠️ 这里只处理玩家（`racers[0]`），是第 10 条 bug 的直接回归点：
 * 调试接口瞬移的是玩家，AI 与幽灵车的位置并没有变。如果连带把 AI 的基准
 * 一起 rebase，AI 的圈数与排名会凭空错乱（表现为"瞬移一次 AI 就多跑一圈"）。
 *
 * 返回被对齐的 arc，方便调用方记录（幽灵车录制要用）。
 */
export function rebasePlayerOnly(
  racers: readonly { isPlayer: boolean; rebase(arc: number): void }[],
  playerArc: number,
): number {
  const player = racers.find((r) => r.isPlayer);
  player?.rebase(playerArc);
  return playerArc;
}

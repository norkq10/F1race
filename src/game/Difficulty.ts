import { DEFAULT_DIFFICULTY, DIFFICULTY_ORDER, TUNING } from './constants';
import type { DifficultyId, DifficultyProfile } from './types';

/**
 * 四档难度查表（M5 / REQ-008；`inferno` 为 2026-10-04 追加）。
 *
 * 数值本体在 `constants.ts` 的 `TUNING.difficulty` 里（那是唯一调参入口），
 * 这里只做两件事：把 id 补成字面量类型（constants 里是可变对象，
 * `id` 会被推断成 `string`，直接赋值给 `DifficultyProfile` 过不了类型检查），
 * 以及提供校验 / 兜底查询。
 */
export const DIFFICULTIES: Record<DifficultyId, DifficultyProfile> = {
  easy: { ...TUNING.difficulty.easy, id: 'easy' },
  normal: { ...TUNING.difficulty.normal, id: 'normal' },
  hard: { ...TUNING.difficulty.hard, id: 'hard' },
  inferno: { ...TUNING.difficulty.inferno, id: 'inferno' },
};

/**
 * 按 id 取难度档位。非法 / 空值一律回落到默认难度，
 * 这样存档被手改、URL 参数乱写都不会让场景崩掉。
 */
export function getDifficulty(id: DifficultyId | string | null | undefined): DifficultyProfile {
  if (id === 'easy' || id === 'normal' || id === 'hard' || id === 'inferno') return DIFFICULTIES[id];
  // DEFAULT_DIFFICULTY 在 constants 里是 `string` 字面量，这里断言回联合类型
  return DIFFICULTIES[DEFAULT_DIFFICULTY as DifficultyId];
}

/** 严格递增的参数：越难的档必须越大。 */
const ASCENDING: ReadonlyArray<[string, (p: DifficultyProfile) => number]> = [
  ['speedCapRatio', (p) => p.speedCapRatio],
  ['steerGain', (p) => p.steerGain],
  ['corneringGrip', (p) => p.corneringGrip],
  ['lookAheadBase', (p) => p.lookAheadBase],
  ['lookAheadPerSpeed', (p) => p.lookAheadPerSpeed],
];

/** 严格递减的参数：越难的档必须越小（失误越少、越贴线、起步越快）。 */
const DESCENDING: ReadonlyArray<[string, (p: DifficultyProfile) => number]> = [
  ['mistakeRatePerSecond', (p) => p.mistakeRatePerSecond],
  ['mistakeDurationMs', (p) => p.mistakeDurationMs],
  ['mistakeSteerError', (p) => p.mistakeSteerError],
  ['lineOffsetPx', (p) => p.lineOffsetPx],
  ['reactionMs', (p) => p.reactionMs],
];

/** 取值区间自检：越界说明调参把难度调成了不合法的驾驶目标。 */
const RANGES: ReadonlyArray<[string, (p: DifficultyProfile) => number, number, number]> = [
  ['speedCapRatio', (p) => p.speedCapRatio, 0.1, 1],
  ['steerGain', (p) => p.steerGain, 0.1, 12],
  ['corneringGrip', (p) => p.corneringGrip, 50, 100000],
  ['lookAheadBase', (p) => p.lookAheadBase, 1, 2000],
  ['lookAheadPerSpeed', (p) => p.lookAheadPerSpeed, 0, 5],
  ['mistakeRatePerSecond', (p) => p.mistakeRatePerSecond, 0, 10],
  ['mistakeDurationMs', (p) => p.mistakeDurationMs, 0, 10000],
  ['mistakeSteerError', (p) => p.mistakeSteerError, 0, 1],
  ['lineOffsetPx', (p) => p.lineOffsetPx, 0, 200],
  ['reactionMs', (p) => p.reactionMs, 0, 5000],
];

/**
 * 三档难度必须满足的单调性，用于自检与测试。
 *
 * REQ-008 要求「困难明显快于简单」，这份自检保证的是"参数层面确实更快"：
 * 速度上限更高、转折更准、失误更少、走线更贴、起步更快。
 * 任何一条被违反（例如调参时手滑把 hard 的 speedCapRatio 改小）都会立刻抛错，
 * 而不是等到玩家发现困难比简单还慢。
 */
export function assertDifficultyOrdering(): void {
  const profiles = DIFFICULTY_ORDER.map((id) => {
    const profile = DIFFICULTIES[id];
    if (profile.id !== id) {
      throw new Error(`[F1race] 难度 ${id} 的 id 字段是 ${profile.id}，查表错位`);
    }
    return profile;
  });

  const labels = profiles.map((p) => p.id).join(' < ');

  for (const [name, read] of ASCENDING) {
    const values = profiles.map(read);
    for (let i = 1; i < values.length; i++) {
      if (!(values[i] > values[i - 1])) {
        throw new Error(`[F1race] 难度参数 ${name} 必须递增（${labels}），实际 ${values.join(' / ')}`);
      }
    }
  }

  for (const [name, read] of DESCENDING) {
    const values = profiles.map(read);
    for (let i = 1; i < values.length; i++) {
      if (!(values[i] < values[i - 1])) {
        throw new Error(`[F1race] 难度参数 ${name} 必须递减（${labels}），实际 ${values.join(' / ')}`);
      }
    }
  }

  for (const profile of profiles) {
    for (const [name, read, min, max] of RANGES) {
      const value = read(profile);
      if (!(value >= min && value <= max)) {
        throw new Error(`[F1race] 难度 ${profile.id} 的 ${name}=${value} 超出合法区间 [${min}, ${max}]`);
      }
    }
  }
}

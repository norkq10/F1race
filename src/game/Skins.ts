/**
 * Skins.ts
 * 车辆皮肤系统的数据层（纯逻辑，**不 import Phaser**，可直接单元测试）。
 *
 * 抽奖（`SlotMachine`）原本只决定放不放中奖动画，中奖道具**不接任何实际效果**。
 * 在一个以"刷时间 = 实力证明"为核心的游戏里，没有产出的随机奖励比没有奖励更伤 ——
 * 它稀释了刷新纪录本身的成就感。皮肤是最轻的"可累积产出"：
 * **不影响任何数值**、不破坏公平、有收集欲、成本低（都是程序化生成的占位 PNG）。
 *
 * 两条硬约束（都对应 `docs/change-requests.md` 里点名的坑）：
 *
 *  1. **存储走独立键** `f1race.skins.v1`，绝不能塞进 `SaveStore` 那套
 *     `rulesetVersion` 升版会清空的存档对象 —— 操控规则一变，纪录会被有意清空
 *     （见 known-issues 第 16 条），但**外观解锁不该跟着丢**。
 *  2. **皮肤不参与任何物理**：没有速度 / 抓地 / 碰撞 / 计时上的差异。
 *     所以本模块只描述"长什么样"，不含任何数值字段。
 */

// `import type` 会被完全擦除，运行时不存在这条边，所以不会与 constants 形成循环依赖。
import type { SkinAssetSuffix } from './constants';

/** 一款皮肤的静态描述。 */
export interface SkinDefinition {
  /** 稳定 id（存储与抽奖表都用它，永远不要改）。 */
  id: string;
  /** 界面上显示的名字。 */
  label: string;
  /**
   * 贴图后缀：`player_<assetSuffix>.png`。
   *
   * 类型是 `constants.ts` 的 `SkinAssetSuffix` 联合 —— 拼错后缀会在 `tsc` 阶段报错，
   * 而不是等到运行时才发现"车库选中了一张不存在的贴图"。
   */
  assetSuffix: SkinAssetSuffix;
  /** 稀有度，只用于界面排序与提示（不影响任何数值）。 */
  rarity: 'starter' | 'common' | 'rare';
  /** 车库里的说明文案。 */
  desc: string;
}

/**
 * 首版 6 款皮肤。
 *
 * `default` 是初始拥有的，其余靠抽奖产出。
 * id 用的是 `SKINS` 的键，`assetSuffix` 与 `tools/gen-assets.mjs` 里
 * 生成的文件名一一对应 —— 改这里必须同步改生成器。
 */
export const SKINS: Record<string, SkinDefinition> = {
  default: {
    id: 'default',
    label: '原厂',
    assetSuffix: 'default',
    rarity: 'starter',
    desc: '出厂配色，蓝白涂装。',
  },
  red: {
    id: 'red',
    label: '烈焰红',
    assetSuffix: 'red',
    rarity: 'common',
    desc: '高饱和红漆，赛道上一眼能认出来。',
  },
  blue: {
    id: 'blue',
    label: '深海蓝',
    assetSuffix: 'blue',
    rarity: 'common',
    desc: '冷色调深蓝，配银色描边。',
  },
  carbon: {
    id: 'carbon',
    label: '碳纤维',
    assetSuffix: 'carbon',
    rarity: 'common',
    desc: '哑光黑底 + 碳纤维纹理。',
  },
  ghost: {
    id: 'ghost',
    label: '幽灵白',
    assetSuffix: 'ghost',
    rarity: 'rare',
    desc: '半透明白车身，像幽灵车一样飘。',
  },
  gold: {
    id: 'gold',
    label: '黄金',
    assetSuffix: 'gold',
    rarity: 'rare',
    desc: '整车镀金。稀有。',
  },
};

/** 皮肤 id 列表（顺序即车库里的显示顺序：初始款在最前，稀有的最后）。 */
export const SKIN_IDS: string[] = Object.keys(SKINS);

/** 初始就拥有的皮肤。 */
export const STARTER_SKIN_ID = 'default';

/** 皮肤系统的当前存储版本。 */
export const SKINS_VERSION = 1;

/** 存储键（**独立于成绩存档**，见文件头第 1 条约束）。 */
export const SKINS_STORAGE_KEY = 'f1race.skins.v1';

/** 车库状态。 */
export interface SkinState {
  /** 已拥有的皮肤 id。 */
  owned: string[];
  /** 当前装备的皮肤 id。 */
  equipped: string;
}

/** 全新的车库状态（只有初始皮肤）。 */
export function createSkinState(): SkinState {
  return { owned: [STARTER_SKIN_ID], equipped: STARTER_SKIN_ID };
}

/** 规范化：过滤掉不认识的 id、去重、保证 equipped 一定在 owned 里。 */
export function normalizeSkinState(raw: unknown): SkinState {
  if (!raw || typeof raw !== 'object') return createSkinState();
  const record = raw as { owned?: unknown; equipped?: unknown };
  const known = new Set(SKIN_IDS);
  const owned = Array.isArray(record.owned)
    ? [...new Set(record.owned.filter((id): id is string => typeof id === 'string' && known.has(id)))]
    : [];
  // 初始皮肤永远算已拥有：老档里漏了它也不该让玩家失去默认外观
  if (!owned.includes(STARTER_SKIN_ID)) owned.unshift(STARTER_SKIN_ID);

  const equipped =
    typeof record.equipped === 'string' && owned.includes(record.equipped) ? record.equipped : STARTER_SKIN_ID;
  return { owned, equipped };
}

/** 是否已拥有。 */
export function hasSkin(state: SkinState, id: string): boolean {
  return state.owned.includes(id);
}

/**
 * 解锁一款皮肤。
 *
 * @returns `{ state, isNew }` —— `isNew` 为 false 表示**重复抽到**，
 *   调用方必须对此给出明确处理（提示"已拥有"或折算成别的东西）。
 *   静默吞掉重复是最容易被玩家记恨的做法。
 */
export function unlockSkin(state: SkinState, id: string): { state: SkinState; isNew: boolean } {
  if (!SKINS[id]) return { state, isNew: false };
  if (state.owned.includes(id)) return { state, isNew: false };
  return { state: { ...state, owned: [...state.owned, id] }, isNew: true };
}

/**
 * 装备一款皮肤。
 *
 * 未拥有时**不生效**（返回原状态）—— 装备是玩家意图，不该替他解锁。
 */
export function equipSkin(state: SkinState, id: string): SkinState {
  if (!state.owned.includes(id)) return state;
  if (state.equipped === id) return state;
  return { ...state, equipped: id };
}

/** 按抽奖结果挑一款皮肤 id（用注入的随机源，便于测试）。 */
export function pickSkinDrop(random: () => number, dropTable: readonly { id: string; weight: number }[]): string {
  const total = dropTable.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return STARTER_SKIN_ID;
  let roll = random() * total;
  for (const entry of dropTable) {
    roll -= Math.max(0, entry.weight);
    if (roll < 0) return entry.id;
  }
  // 浮点误差兜底：落到最后一个合法项
  return dropTable[dropTable.length - 1]?.id ?? STARTER_SKIN_ID;
}

/**
 * 序列化 / 反序列化（供存储层调用）。
 *
 * 版本不一致时**丢弃旧数据、返回全新状态，不抛异常** ——
 * 皮肤是可再获取的外观数据，为它报错弹窗不值得。
 */
export function serializeSkins(state: SkinState): string {
  return JSON.stringify({ version: SKINS_VERSION, owned: state.owned, equipped: state.equipped });
}

export function deserializeSkins(raw: string | null): SkinState {
  if (!raw) return createSkinState();
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed.version !== SKINS_VERSION) return createSkinState();
    return normalizeSkinState(parsed);
  } catch {
    return createSkinState();
  }
}

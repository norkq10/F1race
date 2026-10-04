/**
 * SkinStore.ts
 * 皮肤车库的**持久化**（纯逻辑，**不 import Phaser**，可直接单元测试）。
 *
 * 为什么单独一个 Store，而不并进 `SaveStore`：
 * `SaveStore` 里的"纪录"会在操控规则升版时被**有意清空**
 * （`rulesetVersion`，见 known-issues 第 16 条）。那是有道理的设计 ——
 * 物理改了，旧成绩不再可比。但**外观解锁不该跟着丢**：
 * 玩家抽到的皮肤与跑得快不快毫无关系。
 *
 * 所以：**独立存储键** `f1race.skins.v1`，独立版本号，独立生命周期。
 * 这条约束在 `tests/skins.test.ts` 里有断言守着。
 */

import {
  SKINS_STORAGE_KEY,
  createSkinState,
  deserializeSkins,
  equipSkin,
  normalizeSkinState,
  serializeSkins,
  unlockSkin,
  type SkinState,
} from './Skins';

/** 最小存储接口（与 SaveStore 的 StorageLike 同形，便于共用内存实现做测试）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SkinStoreOptions {
  /** 不传则自动探测 `window.localStorage`；显式传 null 表示纯内存（测试用）。 */
  storage?: StorageLike | null;
  /** 存储键，默认 `f1race.skins.v1`。 */
  key?: string;
}

/** 探测可用的 localStorage；隐私模式 / 沙箱下可能抛异常，所以整个包起来。 */
function detectStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // 探一次写入：Safari 隐私模式下 localStorage 存在但 setItem 会抛
    const probe = '__f1race_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export class SkinStore {
  private readonly storage: StorageLike | null;
  private readonly key: string;
  private state: SkinState;

  constructor(options: SkinStoreOptions = {}) {
    this.storage = options.storage === undefined ? detectStorage() : options.storage;
    this.key = options.key ?? SKINS_STORAGE_KEY;
    this.state = this.load();
  }

  /** 是否真的落盘（纯内存时为 false，调试接口用它区分"存了"和"只是这次有效"）。 */
  get isPersistent(): boolean {
    return this.storage !== null;
  }

  /** 当前车库状态（只读快照）。 */
  get snapshot(): SkinState {
    return { owned: [...this.state.owned], equipped: this.state.equipped };
  }

  /** 当前装备的皮肤 id。 */
  get equipped(): string {
    return this.state.equipped;
  }

  /** 已拥有的皮肤 id。 */
  get owned(): readonly string[] {
    return this.state.owned;
  }

  has(id: string): boolean {
    return this.state.owned.includes(id);
  }

  /**
   * 解锁一款皮肤并落盘。
   *
   * @returns 是否**首次**获得（false = 重复抽到，调用方必须给出明确提示）
   */
  unlock(id: string): boolean {
    const { state, isNew } = unlockSkin(this.state, id);
    if (isNew) {
      this.state = state;
      this.persist();
    }
    return isNew;
  }

  /**
   * 装备一款皮肤并落盘。
   *
   * @returns 是否真的换了（未拥有 / 已经是它 → false）
   */
  equip(id: string): boolean {
    const next = equipSkin(this.state, id);
    if (next === this.state) return false;
    this.state = next;
    this.persist();
    return true;
  }

  /** 清空车库（回到只有初始皮肤）。 */
  clear(): void {
    this.state = createSkinState();
    this.persist();
  }

  // ------------------------------------------------------------ 内部

  private load(): SkinState {
    if (!this.storage) return createSkinState();
    try {
      return deserializeSkins(this.storage.getItem(this.key));
    } catch {
      // 读失败（配额 / 权限）不该让游戏起不来：退回全新车库
      return createSkinState();
    }
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.key, serializeSkins(this.state));
    } catch {
      // 写失败（配额满 / 隐私模式）静默降级为"本次会话有效"。
      // 不抛异常：皮肤是外观数据，写不进去不值得打断比赛。
    }
  }

  /** 直接注入状态（测试 / 调试用；会做规范化并落盘）。 */
  restore(raw: unknown): void {
    this.state = normalizeSkinState(raw);
    this.persist();
  }
}

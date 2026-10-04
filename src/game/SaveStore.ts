import { TUNING } from './constants';
import { isFaster } from './format';
import { isValidGhostData } from './Ghost';
import type { GhostData, RunRecord, SaveData as BaseSaveData } from './types';

/** 最小存储接口，方便在 Node 里用内存实现做单元测试。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 本地存档结构（v3）。
 *
 * 之所以在 types.ts 的 SaveData 之上扩展而不是直接改 types.ts：
 * 那条文件是别的工作线共用的冻结文件，M4 只需要在这里补齐新增字段。
 */
export interface SaveData extends BaseSaveData {
  /** 写入这份存档时的操控规则版本（见 TUNING.save.rulesetVersion）。 */
  rulesetVersion: number;
  /** 最佳总时间那一场的幽灵车数据。 */
  bestGhost: GhostData | null;
}

export interface SaveStoreOptions {
  /** 不传则自动探测 window.localStorage；显式传 null 表示纯内存。 */
  storage?: StorageLike | null;
  key?: string;
  version?: number;
  historyLimit?: number;
  now?: () => Date;
}

/**
 * 多赛道存档：每条赛道一份独立的 SaveStore。
 *
 * 为什么必须分开：最佳圈、最佳总时间、参考曲线（检查点曲线）与幽灵车都是**赛道强相关**的。
 * track1 的 45 秒和 track2 的 64 秒放在同一份纪录里比较没有意义，
 * 幽灵车录的也是不同地图上的轨迹（回放会跑到草地上去）。
 *
 * 存储键形如 `f1race.save.v3@track2`；具体赛道的键与旧版单赛道键（`f1race.save.v3`）
 * 完全一致，所以默认赛道（track1）的历史成绩能原地继承，不需要迁移。
 */
export class TrackSaveStores {
  /** 用于拼每条赛道的键。 */
  readonly baseKey: string;
  /** 默认赛道（沿用基键，从而原地继承单赛道时代的成绩）。 */
  private readonly defaultTrackId: string;
  private readonly options: Omit<SaveStoreOptions, 'key'>;
  private readonly stores = new Map<string, SaveStore>();

  constructor(defaultTrackId: string, options: SaveStoreOptions = {}) {
    const { key, ...rest } = options;
    this.baseKey = key ?? TUNING.save.key;
    this.defaultTrackId = defaultTrackId;
    this.options = rest;
  }

  /** 取（必要时创建）某条赛道的存档。 */
  for(trackId: string): SaveStore {
    let store = this.stores.get(trackId);
    if (!store) {
      store = new SaveStore({ ...this.options, key: this.keyFor(trackId) });
      this.stores.set(trackId, store);
    }
    return store;
  }

  /** 赛道存档键：默认赛道沿用基键，其余加 `@<id>` 后缀。 */
  keyFor(trackId: string): string {
    return trackId === this.defaultTrackId ? this.baseKey : `${this.baseKey}@${trackId}`;
  }
}

export interface SubmitOutcome {
  isNewBestTotal: boolean;
  isNewBestLap: boolean;
  isNewBestSector: boolean;
  /** 是否成功写入了持久化存储。 */
  persisted: boolean;
}

/** 老版本使用过的存档键，升级到 v3 时需要读取并迁移。 */
const LEGACY_KEYS: readonly string[] = ['f1race.save.v2', 'f1race.save.v1'];

/** 旧档没有 rulesetVersion 字段时的隐含值（M1/M2 时代的规则）。 */
const IMPLICIT_RULESET_VERSION = 1;

function emptySave(version: number, sectorCount: number): SaveData {
  return {
    version,
    rulesetVersion: TUNING.save.rulesetVersion,
    bestTotalMs: null,
    bestLapMs: null,
    bestSectorsMs: new Array(sectorCount).fill(null),
    bestLapCheckpointsMs: null,
    bestGhost: null,
    history: [],
    updatedAt: null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 深拷贝幽灵数据：getter / snapshot 不能把内部数组漏出去。 */
function cloneGhost(ghost: GhostData): GhostData {
  return {
    version: ghost.version,
    totalMs: ghost.totalMs,
    intervalMs: ghost.intervalMs,
    frames: [...ghost.frames],
  };
}

/**
 * submit 时只做结构性检查：调用方是刚跑完一场的录制器，数据可信，
 * 但要挡住三元组残缺 / NaN 这类明显写坏的值。
 * 严格得多的"这份数据能不能回放"校验（isValidGhostData）留给读取存档的路径，
 * 因为那边才是真的"来路不明"。
 */
function isStorableGhost(ghost: GhostData | null): ghost is GhostData {
  if (!ghost || typeof ghost !== 'object') return false;
  const frames = ghost.frames;
  return Array.isArray(frames) && frames.length % 3 === 0 && frames.every((v) => Number.isFinite(v));
}

/**
 * 本地存档（REQ-013）。
 *
 * M2 起结构升级为 v2（分段最佳 + 最佳圈检查点曲线 + 成绩历史），
 * M4 起升级为 v3（新增 rulesetVersion 与最佳成绩的幽灵车数据 bestGhost）。
 *
 * v3 的关键变化：M3 引入漂移后物理规则变了，旧规则下跑出来的纪录不再可比。
 * 因此读到 rulesetVersion 不一致的存档时会**清空全部纪录**
 * （bestTotalMs / bestLapMs / bestSectorsMs / bestLapCheckpointsMs / bestGhost），
 * 但保留 history——它是流水账，不是纪录；同时置位 recordsResetForRuleset 供 UI 提示玩家。
 */
export class SaveStore {
  private readonly key: string;
  private readonly version: number;
  private readonly historyLimit: number;
  private readonly sectorCount: number;
  private readonly now: () => Date;
  private readonly storage: StorageLike | null;
  private readonly persistent: boolean;

  private data: SaveData;
  /** 本次读取是否由旧版本迁移而来（诊断 / 测试用）。 */
  readonly migratedFromVersion: number | null;
  /** 本次读取是否因规则版本变化清空过纪录（UI 据此提示玩家）。 */
  readonly recordsResetForRuleset: boolean;

  constructor(options: SaveStoreOptions = {}) {
    this.key = options.key ?? TUNING.save.key;
    this.version = options.version ?? TUNING.save.version;
    this.historyLimit = options.historyLimit ?? TUNING.save.historyLimit;
    this.sectorCount = TUNING.race.sectorCount;
    this.now = options.now ?? (() => new Date());

    if (options.storage === undefined) {
      const detected = SaveStore.detectStorage();
      this.storage = detected;
      this.persistent = detected !== null;
    } else {
      this.storage = options.storage;
      this.persistent = options.storage !== null;
    }

    const loaded = this.read();
    this.data = loaded.data;
    this.migratedFromVersion = loaded.migratedFrom;
    this.recordsResetForRuleset = loaded.resetForRuleset;

    // 迁移（或清纪录）后立刻落盘。顺序很关键：**先写新键、写成功再删旧键**。
    // M2 在这里踩过坑：先删旧键的话，用户迁移完没跑完一场就关页面会直接丢成绩。
    if (loaded.migratedFrom !== null || loaded.resetForRuleset) {
      const persisted = this.write();
      if (persisted && loaded.legacyKey && this.storage) {
        try {
          this.storage.removeItem(loaded.legacyKey);
        } catch {
          /* 删不掉也不影响，下次读取还会再迁移一遍 */
        }
      }
    }
  }

  private static detectStorage(): StorageLike | null {
    try {
      const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
      if (!candidate) return null;
      const probeKey = '__f1race_probe__';
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      return null;
    }
  }

  private readRaw(key: string): unknown {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** 存档里的 rulesetVersion 与当前不一致时（缺失视为 1）必须清纪录。 */
  private needsRulesetReset(rulesetVersion: unknown): boolean {
    const stored =
      typeof rulesetVersion === 'number' && Number.isFinite(rulesetVersion)
        ? rulesetVersion
        : IMPLICIT_RULESET_VERSION;
    return stored !== TUNING.save.rulesetVersion;
  }

  private read(): {
    data: SaveData;
    migratedFrom: number | null;
    legacyKey: string | null;
    resetForRuleset: boolean;
  } {
    const current = this.readRaw(this.key);
    // 非对象（被手改成数字 / 字符串）一律当损坏存档，别拿它去覆盖任何东西
    if (current && typeof current === 'object') {
      const parsed = current as Partial<SaveData>;
      if (parsed.version === this.version) {
        const resetForRuleset = this.needsRulesetReset(parsed.rulesetVersion);
        return {
          data: this.normalize(parsed, resetForRuleset),
          migratedFrom: null,
          legacyKey: null,
          resetForRuleset,
        };
      }
      console.warn(
        `[F1race] 存档版本不匹配（${String(parsed.version)} != ${this.version}），尝试按旧格式迁移。`,
      );
      const resetForRuleset = this.needsRulesetReset(parsed.rulesetVersion);
      return {
        data: this.normalize(parsed, resetForRuleset),
        migratedFrom: typeof parsed.version === 'number' ? parsed.version : 0,
        legacyKey: null,
        resetForRuleset,
      };
    }

    // 当前键不存在：尝试从 M1 / M2 的旧键迁移
    for (const legacyKey of LEGACY_KEYS) {
      const legacy = this.readRaw(legacyKey);
      if (!legacy || typeof legacy !== 'object') continue;
      const parsed = legacy as Partial<SaveData>;
      const resetForRuleset = this.needsRulesetReset(parsed.rulesetVersion);
      return {
        data: this.normalize(parsed, resetForRuleset),
        migratedFrom: typeof parsed.version === 'number' ? parsed.version : 0,
        legacyKey,
        resetForRuleset,
      };
    }

    return {
      data: emptySave(this.version, this.sectorCount),
      migratedFrom: null,
      legacyKey: null,
      resetForRuleset: false,
    };
  }

  /**
   * 防御性归一化：手改过 / 残缺的存档不应该让游戏崩掉。
   * resetForRuleset 为 true 时丢弃全部"纪录"，但 history 始终保留（能救的都救）。
   */
  private normalize(parsed: Partial<SaveData>, resetForRuleset: boolean): SaveData {
    const data = emptySave(this.version, this.sectorCount);
    data.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;

    if (Array.isArray(parsed.history)) {
      data.history = parsed.history
        .filter((item): item is RunRecord => !!item && typeof item === 'object' && Number.isFinite((item as RunRecord).totalMs))
        .slice(0, this.historyLimit)
        .map((item) => ({
          at: typeof item.at === 'string' ? item.at : new Date(0).toISOString(),
          totalMs: item.totalMs,
          bestLapMs: finiteOrNull(item.bestLapMs),
          lapTimesMs: Array.isArray(item.lapTimesMs) ? item.lapTimesMs.filter((v) => Number.isFinite(v)) : [],
          sectorsMs: Array.isArray(item.sectorsMs) ? item.sectorsMs.filter((v) => Number.isFinite(v)) : [],
          valid: item.valid !== false,
          invalidReason: typeof item.invalidReason === 'string' ? item.invalidReason : null,
        }));
    }

    if (resetForRuleset) return data;

    data.bestTotalMs = finiteOrNull(parsed.bestTotalMs);
    data.bestLapMs = finiteOrNull(parsed.bestLapMs);

    if (Array.isArray(parsed.bestSectorsMs)) {
      for (let i = 0; i < this.sectorCount; i++) {
        data.bestSectorsMs[i] = finiteOrNull(parsed.bestSectorsMs[i]);
      }
    }
    if (Array.isArray(parsed.bestLapCheckpointsMs) && parsed.bestLapCheckpointsMs.every((v) => Number.isFinite(v))) {
      data.bestLapCheckpointsMs = parsed.bestLapCheckpointsMs.map(Number);
    }
    if (isValidGhostData(parsed.bestGhost)) {
      data.bestGhost = cloneGhost(parsed.bestGhost);
    }
    return data;
  }

  private write(): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify(this.data));
      return true;
    } catch (err) {
      console.warn('[F1race] 写入存档失败。', err);
      return false;
    }
  }

  get bestTotalMs(): number | null {
    return this.data.bestTotalMs;
  }

  get bestLapMs(): number | null {
    return this.data.bestLapMs;
  }

  get bestSectorsMs(): (number | null)[] {
    return [...this.data.bestSectorsMs];
  }

  get bestLapCheckpointsMs(): number[] | null {
    return this.data.bestLapCheckpointsMs ? [...this.data.bestLapCheckpointsMs] : null;
  }

  /** 最佳成绩的幽灵车数据（深拷贝，外部改不动内部状态）。 */
  get bestGhost(): GhostData | null {
    return this.data.bestGhost ? cloneGhost(this.data.bestGhost) : null;
  }

  get history(): RunRecord[] {
    return this.data.history.map((item) => ({ ...item, lapTimesMs: [...item.lapTimesMs], sectorsMs: [...item.sectorsMs] }));
  }

  get isPersistent(): boolean {
    return this.persistent;
  }

  /**
   * 提交一场成绩。
   * 只有整场有效的成绩才能刷新最佳总时间 / 最佳圈 / 最佳分段；
   * 无效成绩仍然会写进历史（附带原因），方便回看。
   *
   * ghost 只在**本次成绩有效且刷新了最佳总时间**时才写入 bestGhost。
   */
  submit(
    record: RunRecord,
    bestLapCheckpointsMs: readonly number[] | null,
    ghost: GhostData | null,
  ): SubmitOutcome {
    const isNewBestTotal = record.valid && isFaster(record.totalMs, this.data.bestTotalMs);
    const isNewBestLap =
      record.valid && record.bestLapMs !== null && isFaster(record.bestLapMs, this.data.bestLapMs);

    let isNewBestSector = false;
    if (record.valid) {
      for (let i = 0; i < this.sectorCount; i++) {
        const value = record.sectorsMs[i];
        if (!Number.isFinite(value)) continue;
        const previous = this.data.bestSectorsMs[i];
        if (previous === null || previous === undefined || value < previous) {
          this.data.bestSectorsMs[i] = value;
          isNewBestSector = true;
        }
      }
    }

    if (isNewBestTotal) {
      this.data.bestTotalMs = record.totalMs;
      // 幽灵必须与"最佳总时间"这一场对应：拿不到可用的录制数据时宁可置空，
      // 也不要留下上一次（更慢那一场）的旧幽灵
      this.data.bestGhost = isStorableGhost(ghost) ? cloneGhost(ghost) : null;
    }
    if (isNewBestLap) {
      this.data.bestLapMs = record.bestLapMs;
      if (bestLapCheckpointsMs && bestLapCheckpointsMs.every((v) => Number.isFinite(v))) {
        this.data.bestLapCheckpointsMs = [...bestLapCheckpointsMs];
      }
    }

    this.data.history = [record, ...this.data.history].slice(0, this.historyLimit);
    this.data.updatedAt = this.now().toISOString();

    const persisted = this.write();
    return { isNewBestTotal, isNewBestLap, isNewBestSector, persisted };
  }

  clear(): void {
    this.data = emptySave(this.version, this.sectorCount);
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.key);
      for (const legacyKey of LEGACY_KEYS) this.storage.removeItem(legacyKey);
    } catch {
      /* 忽略 */
    }
  }

  snapshot(): SaveData {
    return {
      ...this.data,
      bestSectorsMs: [...this.data.bestSectorsMs],
      bestLapCheckpointsMs: this.data.bestLapCheckpointsMs ? [...this.data.bestLapCheckpointsMs] : null,
      bestGhost: this.data.bestGhost ? cloneGhost(this.data.bestGhost) : null,
      history: this.history,
    };
  }
}

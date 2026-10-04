import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNING } from '../src/game/constants';
import { isValidGhostData } from '../src/game/Ghost';
import { SaveStore, type StorageLike } from '../src/game/SaveStore';
import type { GhostData, RunRecord } from '../src/game/types';

/** 内存版存储，避免单元测试依赖浏览器环境。 */
class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** 记录读写顺序的存储，用来验证"先写新键、写成功再删旧键"。 */
class RecordingStorage extends MemoryStorage {
  readonly ops: string[] = [];
  override setItem(key: string, value: string): void {
    this.ops.push(`set:${key}`);
    super.setItem(key, value);
  }
  override removeItem(key: string): void {
    this.ops.push(`remove:${key}`);
    super.removeItem(key);
  }
}

/** 写新键一定失败（模拟配额满 / 隐私模式）。 */
class FailingWriteStorage extends MemoryStorage {
  override setItem(key: string, value: string): void {
    if (key === V3_KEY) throw new Error('QuotaExceededError');
    super.setItem(key, value);
  }
}

/** 删旧键一定失败。 */
class FailingRemoveStorage extends MemoryStorage {
  override removeItem(key: string): void {
    if (key === V2_KEY) throw new Error('blocked');
    super.removeItem(key);
  }
}

const V3_KEY = 'f1race.save.v3';
const V2_KEY = 'f1race.save.v2';
const V1_KEY = 'f1race.save.v1';
const FIXED_NOW = () => new Date('2026-10-03T12:00:00.000Z');

function makeRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    at: '2026-10-03T12:00:00.000Z',
    totalMs: 52000,
    bestLapMs: 17000,
    lapTimesMs: [17500, 17000, 17500],
    sectorsMs: [5700, 5600, 5700],
    valid: true,
    invalidReason: null,
    ...overrides,
  };
}

function makeGhost(overrides: Partial<GhostData> = {}): GhostData {
  return {
    version: TUNING.ghost.dataVersion,
    totalMs: 52000,
    intervalMs: 50,
    frames: [0, 0, 0, 10, 0, 0.1, 20, 0, 0.2],
    ...overrides,
  };
}

function makeStore(storage: StorageLike): SaveStore {
  return new SaveStore({ storage, key: V3_KEY, version: 3, historyLimit: 10, now: FIXED_NOW });
}

/** M2 时代的存档内容（v2 没有 rulesetVersion / bestGhost）。 */
function v2Save(rulesetVersion?: number): Record<string, unknown> {
  const save: Record<string, unknown> = {
    version: 2,
    bestTotalMs: 51564.6,
    bestLapMs: 16999.3,
    bestSectorsMs: [5700, 5600, 5700],
    bestLapCheckpointsMs: [0, 1000, 2000],
    history: [makeRecord({ totalMs: 51564.6 })],
    updatedAt: '2026-10-03T07:30:00.000Z',
  };
  if (rulesetVersion !== undefined) save.rulesetVersion = rulesetVersion;
  return save;
}

describe('SaveStore v3 基本读写', () => {
  it('空存储时给出干净的初始值', () => {
    const store = makeStore(new MemoryStorage());
    assert.equal(store.bestTotalMs, null);
    assert.equal(store.bestLapMs, null);
    assert.deepEqual(store.bestSectorsMs, [null, null, null]);
    assert.equal(store.bestLapCheckpointsMs, null);
    assert.equal(store.bestGhost, null);
    assert.deepEqual(store.history, []);
    assert.equal(store.isPersistent, true);
    assert.equal(store.migratedFromVersion, null);
    assert.equal(store.recordsResetForRuleset, false, '全新存档没有旧纪录可清');
  });

  it('有效成绩会刷新最佳、写入幽灵车并落盘', () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    const checkpoints = Array.from({ length: 25 }, (_, i) => (i / 24) * 17000);
    const ghost = makeGhost();

    const outcome = store.submit(makeRecord(), checkpoints, ghost);
    assert.equal(outcome.isNewBestTotal, true);
    assert.equal(outcome.isNewBestLap, true);
    assert.equal(outcome.isNewBestSector, true);
    assert.equal(outcome.persisted, true);

    assert.equal(store.bestTotalMs, 52000);
    assert.equal(store.bestLapMs, 17000);
    assert.deepEqual(store.bestSectorsMs, [5700, 5600, 5700]);
    assert.deepEqual(store.bestLapCheckpointsMs, checkpoints);
    assert.deepEqual(store.bestGhost?.frames, ghost.frames);
    assert.equal(store.history.length, 1);

    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.version, 3);
    assert.equal(written.rulesetVersion, TUNING.save.rulesetVersion);
    assert.equal(written.bestTotalMs, 52000);
    assert.equal(isValidGhostData(written.bestGhost), true);

    // 重新读取应完全一致
    const reloaded = makeStore(storage);
    assert.equal(reloaded.bestTotalMs, 52000);
    assert.equal(reloaded.bestLapMs, 17000);
    assert.deepEqual(reloaded.bestLapCheckpointsMs, checkpoints);
    assert.deepEqual(reloaded.bestGhost?.frames, ghost.frames);
    assert.equal(reloaded.migratedFromVersion, null);
    assert.equal(reloaded.recordsResetForRuleset, false);
  });

  it('更慢的成绩不会刷新最佳，但仍然进入历史', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, makeGhost());
    const outcome = store.submit(makeRecord({ totalMs: 60000, bestLapMs: 19000 }), null, makeGhost({ frames: [9, 9, 9] }));

    assert.equal(outcome.isNewBestTotal, false);
    assert.equal(outcome.isNewBestLap, false);
    assert.equal(store.bestTotalMs, 52000);
    assert.deepEqual(store.bestGhost?.frames, makeGhost().frames, '没刷新最佳就不该动幽灵车');
    assert.equal(store.history.length, 2);
    assert.equal(store.history[0].totalMs, 60000, '最新的成绩排在最前');
  });

  it('分段最佳按段独立比较', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, null);
    const outcome = store.submit(
      makeRecord({ totalMs: 60000, bestLapMs: 19000, sectorsMs: [5500, 6000, 5800] }),
      null,
      null,
    );
    assert.equal(outcome.isNewBestSector, true, 'S1 更快就应该算刷新分段');
    assert.deepEqual(store.bestSectorsMs, [5500, 5600, 5700]);
  });

  it('snapshot 带出 v3 的新字段且不外泄内部引用', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, makeGhost());

    const snapshot = store.snapshot();
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.rulesetVersion, TUNING.save.rulesetVersion);
    const snapshotGhost = snapshot.bestGhost;
    assert.ok(snapshotGhost);
    snapshotGhost.frames[0] = 777;
    assert.equal(store.bestGhost?.frames[0], 0, 'snapshot 的幽灵车必须是深拷贝');
  });
});

describe('SaveStore 幽灵车写入规则', () => {
  it('只有刷新最佳总时间时才写入 bestGhost', () => {
    const store = makeStore(new MemoryStorage());
    const first = store.submit(makeRecord(), null, makeGhost({ totalMs: 52000 }));
    assert.equal(first.isNewBestTotal, true);
    assert.deepEqual(store.bestGhost?.frames, makeGhost().frames);

    // 更慢的一场：不刷新最佳总时间，幽灵保持原样
    store.submit(makeRecord({ totalMs: 60000 }), null, makeGhost({ totalMs: 60000, frames: [9, 9, 9] }));
    assert.deepEqual(store.bestGhost?.frames, makeGhost().frames);

    // 更快的一场：替换成新的幽灵
    const faster = store.submit(makeRecord({ totalMs: 50000 }), null, makeGhost({ totalMs: 50000, frames: [1, 1, 1] }));
    assert.equal(faster.isNewBestTotal, true);
    assert.deepEqual(store.bestGhost?.frames, [1, 1, 1]);
    assert.equal(store.bestTotalMs, 50000);
  });

  it('无效成绩即使总时间更短也不会写幽灵车', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, makeGhost({ frames: [1, 2, 0.1] }));
    const outcome = store.submit(
      makeRecord({ totalMs: 1000, valid: false, invalidReason: '切弯：赛道进度异常跳跃' }),
      null,
      makeGhost({ frames: [3, 4, 0.2] }),
    );

    assert.equal(outcome.isNewBestTotal, false);
    assert.equal(store.bestTotalMs, 52000);
    assert.deepEqual(store.bestGhost?.frames, [1, 2, 0.1]);
  });

  it('刷新最佳总时间但没提供幽灵车时，旧幽灵会被清掉（不能与纪录不符）', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, makeGhost());
    assert.ok(store.bestGhost);

    store.submit(makeRecord({ totalMs: 50000 }), null, null);
    assert.equal(store.bestTotalMs, 50000);
    assert.equal(store.bestGhost, null);
  });

  it('三元组残缺 / 含 NaN 的幽灵车数据会被丢弃', () => {
    const store = makeStore(new MemoryStorage());
    const broken = { ...makeGhost(), frames: [0, 0] } as GhostData;
    const outcome = store.submit(makeRecord(), null, broken);
    assert.equal(outcome.isNewBestTotal, true);
    assert.equal(store.bestGhost, null);

    store.submit(makeRecord({ totalMs: 51000 }), null, makeGhost({ frames: [0, 0, Number.NaN] }));
    assert.equal(store.bestGhost, null);
  });

  it('录制器产出空帧（异常短的一场比赛）时不视为损坏数据', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, makeGhost({ frames: [] }));
    assert.deepEqual(store.bestGhost?.frames, [], '空帧是合法结构，能不能回放交给 GhostPlayback.isEmpty 判断');
  });

  it('bestGhost 返回深拷贝，存档往返后仍然合法', () => {
    const storage = new MemoryStorage();
    const store = makeStore(storage);
    store.submit(makeRecord(), null, makeGhost());

    const got = store.bestGhost;
    assert.ok(got);
    got.frames[0] = 12345;
    assert.equal(store.bestGhost?.frames[0], 0, 'getter 不能被外部改坏内部状态');

    const reloaded = makeStore(storage);
    const reloadedGhost = reloaded.bestGhost;
    assert.ok(reloadedGhost);
    assert.equal(isValidGhostData(reloadedGhost), true);
    assert.deepEqual(reloadedGhost.frames, makeGhost().frames);
    assert.equal(reloadedGhost.intervalMs, TUNING.ghost.sampleIntervalMs);
  });

  it('存档里的幽灵车被手改坏时，只丢幽灵车，不影响成绩', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      V3_KEY,
      JSON.stringify({
        version: 3,
        rulesetVersion: TUNING.save.rulesetVersion,
        bestTotalMs: 50000,
        bestLapMs: 16000,
        bestSectorsMs: [5500, 5400, 5500],
        bestGhost: { version: 1, totalMs: 50000, intervalMs: 50, frames: [1, 2] },
      }),
    );

    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, 50000);
    assert.equal(store.bestGhost, null);
    assert.equal(store.recordsResetForRuleset, false);
  });
});

describe('SaveStore 无效成绩', () => {
  it('无效成绩不刷新任何最佳，但会带原因写进历史', () => {
    const store = makeStore(new MemoryStorage());
    store.submit(makeRecord(), null, null);

    const outcome = store.submit(
      makeRecord({ totalMs: 1000, bestLapMs: 500, valid: false, invalidReason: '切弯：赛道进度异常跳跃' }),
      null,
      null,
    );

    assert.equal(outcome.isNewBestTotal, false);
    assert.equal(outcome.isNewBestLap, false);
    assert.equal(outcome.isNewBestSector, false);
    assert.equal(store.bestTotalMs, 52000);
    assert.equal(store.bestLapMs, 17000);
    assert.equal(store.history[0].valid, false);
    assert.match(store.history[0].invalidReason ?? '', /切弯/);
  });

  it('没有有效圈（bestLapMs 为 null）时不会崩，也不会刷新最佳圈', () => {
    const store = makeStore(new MemoryStorage());
    const outcome = store.submit(makeRecord({ bestLapMs: null, sectorsMs: [] }), null, null);
    assert.equal(outcome.isNewBestTotal, true);
    assert.equal(outcome.isNewBestLap, false);
    assert.equal(store.bestLapMs, null);
  });
});

describe('SaveStore 迁移到 v3', () => {
  it('v2 存档的 ruleset 一致时保留全部纪录与历史，并清掉旧键', () => {
    const storage = new MemoryStorage();
    storage.setItem(V2_KEY, JSON.stringify(v2Save(TUNING.save.rulesetVersion)));

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, 2);
    assert.equal(store.recordsResetForRuleset, false, '规则版本一致就不该清纪录');
    assert.equal(store.bestTotalMs, 51564.6);
    assert.equal(store.bestLapMs, 16999.3);
    assert.deepEqual(store.bestSectorsMs, [5700, 5600, 5700]);
    assert.deepEqual(store.bestLapCheckpointsMs, [0, 1000, 2000]);
    assert.equal(store.history.length, 1);
    assert.equal(store.bestGhost, null, 'v2 没有幽灵车数据');

    assert.equal(storage.getItem(V2_KEY), null, '迁移成功后应删除旧键');
    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.version, 3);
    assert.equal(written.rulesetVersion, TUNING.save.rulesetVersion);
    assert.equal(written.bestTotalMs, 51564.6);
    assert.equal(written.updatedAt, '2026-10-03T07:30:00.000Z');
  });

  it('v2 存档的 ruleset 过期时清空全部纪录，但保留 history', () => {
    const storage = new MemoryStorage();
    storage.setItem(V2_KEY, JSON.stringify(v2Save(1)));

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, 2);
    assert.equal(store.recordsResetForRuleset, true, '需要提示玩家纪录已因规则变化清空');
    assert.equal(store.bestTotalMs, null);
    assert.equal(store.bestLapMs, null);
    assert.deepEqual(store.bestSectorsMs, [null, null, null]);
    assert.equal(store.bestLapCheckpointsMs, null);
    assert.equal(store.bestGhost, null);
    assert.equal(store.history.length, 1, 'history 是流水账，不属于纪录，必须保留');
    assert.equal(store.history[0].totalMs, 51564.6);

    assert.equal(storage.getItem(V2_KEY), null);
    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.version, 3);
    assert.equal(written.bestTotalMs, null);
    assert.equal(written.history.length, 1);
  });

  it('M1 的 v1 存档（没有 rulesetVersion）视为规则 1：清纪录、留历史', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      V1_KEY,
      JSON.stringify({ version: 1, bestTotalMs: 51564.6, bestLapMs: 16999.3, updatedAt: '2026-10-03T07:30:00.000Z' }),
    );

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, 1);
    assert.equal(store.recordsResetForRuleset, true);
    assert.equal(store.bestTotalMs, null, '旧规则下的成绩与漂移后的物理不可比');
    assert.equal(store.bestLapMs, null);
    assert.deepEqual(store.bestSectorsMs, [null, null, null]);
    assert.equal(store.bestLapCheckpointsMs, null);
    assert.deepEqual(store.history, []);

    assert.equal(storage.getItem(V1_KEY), null, '迁移后应删除旧键');
    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.version, 3);
    assert.equal(written.updatedAt, '2026-10-03T07:30:00.000Z', '尽量救回旧存档的元信息');
  });

  it('旧键里的 ruleset 与当前一致时保留成绩（迁移规则只看 ruleset）', () => {
    const storage = new MemoryStorage();
    storage.setItem(V1_KEY, JSON.stringify({ version: 1, rulesetVersion: TUNING.save.rulesetVersion, bestTotalMs: 48000, bestLapMs: 15000 }));

    const store = makeStore(storage);
    assert.equal(store.recordsResetForRuleset, false);
    assert.equal(store.bestTotalMs, 48000);
    assert.equal(store.bestLapMs, 15000);
  });

  it('同时存在 v2 与 v1 时优先用 v2', () => {
    const storage = new MemoryStorage();
    storage.setItem(V1_KEY, JSON.stringify({ version: 1, bestTotalMs: 99999, bestLapMs: 99999 }));
    storage.setItem(V2_KEY, JSON.stringify(v2Save(TUNING.save.rulesetVersion)));

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, 2);
    assert.equal(store.bestTotalMs, 51564.6);
    assert.equal(storage.getItem(V1_KEY) !== null, true, '没用到的旧键不动它');
  });

  it('当前键版本号不对时就地迁移，且不删任何旧键', () => {
    const storage = new MemoryStorage();
    storage.setItem(V3_KEY, JSON.stringify(v2Save(TUNING.save.rulesetVersion)));
    storage.setItem(V2_KEY, JSON.stringify({ version: 2, bestTotalMs: 12345 }));

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, 2);
    assert.equal(store.bestTotalMs, 51564.6);
    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.version, 3);
    assert.equal(storage.getItem(V2_KEY) !== null, true);
  });

  it('已有 v3 存档时优先使用 v3，不受旧键影响', () => {
    const storage = new MemoryStorage();
    storage.setItem(V1_KEY, JSON.stringify({ version: 1, bestTotalMs: 99999, bestLapMs: 99999 }));
    storage.setItem(
      V3_KEY,
      JSON.stringify({ version: 3, rulesetVersion: TUNING.save.rulesetVersion, bestTotalMs: 40000, bestLapMs: 13000 }),
    );

    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, 40000);
    assert.equal(store.migratedFromVersion, null);
    assert.equal(store.recordsResetForRuleset, false);
  });

  it('v3 存档的 ruleset 过期时清纪录、留历史并写回', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      V3_KEY,
      JSON.stringify({ version: 3, rulesetVersion: 1, bestTotalMs: 40000, bestLapMs: 13000, history: [makeRecord()] }),
    );

    const store = makeStore(storage);
    assert.equal(store.migratedFromVersion, null, '版本号没变，不算版本迁移');
    assert.equal(store.recordsResetForRuleset, true);
    assert.equal(store.bestTotalMs, null);
    assert.equal(store.history.length, 1);

    const written = JSON.parse(storage.getItem(V3_KEY) ?? '{}');
    assert.equal(written.rulesetVersion, TUNING.save.rulesetVersion, '清完纪录要把新 ruleset 写回去');
    assert.equal(written.bestTotalMs, null);

    // 再读一次不应该又提示一遍
    const again = makeStore(storage);
    assert.equal(again.recordsResetForRuleset, false);
    assert.equal(again.bestTotalMs, null);
  });

  it('v3 存档缺少 rulesetVersion 时按规则 1 处理（清纪录）', () => {
    const storage = new MemoryStorage();
    storage.setItem(V3_KEY, JSON.stringify({ version: 3, bestTotalMs: 40000, bestLapMs: 13000 }));

    const store = makeStore(storage);
    assert.equal(store.recordsResetForRuleset, true);
    assert.equal(store.bestTotalMs, null);
  });

  it('ruleset 一致的 v3 存档不会被重写（不做无谓的落盘）', () => {
    const storage = new RecordingStorage();
    storage.setItem(
      V3_KEY,
      JSON.stringify({ version: 3, rulesetVersion: TUNING.save.rulesetVersion, bestTotalMs: 40000, bestLapMs: 13000 }),
    );
    storage.ops.length = 0;

    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, 40000);
    assert.deepEqual(storage.ops, [], '没有迁移 / 清纪录时不应写存储');
  });
});

describe('SaveStore 迁移的写入顺序与失败回退', () => {
  it('先写新键、写成功之后才删旧键', () => {
    const storage = new RecordingStorage();
    storage.setItem(V2_KEY, JSON.stringify(v2Save(1)));
    storage.ops.length = 0;

    makeStore(storage);

    const setIndex = storage.ops.indexOf(`set:${V3_KEY}`);
    const removeIndex = storage.ops.indexOf(`remove:${V2_KEY}`);
    assert.ok(setIndex >= 0, `应写入新键，实际操作：${storage.ops.join(', ')}`);
    assert.ok(removeIndex >= 0, `应删除旧键，实际操作：${storage.ops.join(', ')}`);
    assert.ok(setIndex < removeIndex, `必须先写新键再删旧键，实际操作：${storage.ops.join(', ')}`);
  });

  it('写新键失败时绝不删旧键（否则用户没跑完一场就关页面会丢成绩）', () => {
    const storage = new FailingWriteStorage();
    storage.setItem(V2_KEY, JSON.stringify(v2Save(1)));

    const store = makeStore(storage);

    assert.equal(storage.getItem(V3_KEY), null);
    assert.notEqual(storage.getItem(V2_KEY), null, '旧键必须留着，下次启动还能再迁移一次');
    assert.equal(store.isPersistent, true);
    assert.equal(store.migratedFromVersion, 2, '内存里仍然完成了迁移');
  });

  it('删旧键失败不会抛异常', () => {
    const storage = new FailingRemoveStorage();
    storage.setItem(V2_KEY, JSON.stringify(v2Save(TUNING.save.rulesetVersion)));

    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, 51564.6);
    assert.notEqual(storage.getItem(V2_KEY), null);
    assert.equal(JSON.parse(storage.getItem(V3_KEY) ?? '{}').version, 3);
  });
});

describe('SaveStore 健壮性', () => {
  it('存档损坏时不抛异常，退回空数据', () => {
    const storage = new MemoryStorage();
    storage.setItem(V3_KEY, '{ this is not json');
    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, null);
    assert.deepEqual(store.history, []);
    assert.equal(store.recordsResetForRuleset, false);
  });

  it('存档是合法 JSON 但不是对象时按损坏处理，且不覆盖原内容', () => {
    const storage = new MemoryStorage();
    storage.setItem(V3_KEY, '123');
    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, null);
    assert.equal(storage.getItem(V3_KEY), '123', '分不清结构时不要写坏用户的存档');
  });

  it('历史条数按上限截断', () => {
    const store = makeStore(new MemoryStorage());
    for (let i = 0; i < 15; i++) {
      store.submit(makeRecord({ totalMs: 60000 + i }), null, null);
    }
    assert.equal(store.history.length, 10);
    assert.equal(store.history[0].totalMs, 60014, '保留最新的 10 条');
  });

  it('残缺的 history 项会被过滤掉', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      V3_KEY,
      JSON.stringify({
        version: 3,
        rulesetVersion: TUNING.save.rulesetVersion,
        bestTotalMs: 50000,
        bestLapMs: 16000,
        history: [{ totalMs: 51000 }, null, { nope: true }, 'x'],
      }),
    );
    const store = makeStore(storage);
    assert.equal(store.history.length, 1);
    assert.equal(store.history[0].totalMs, 51000);
  });

  it('全部纪录为空时也不会崩（空历史 + 空幽灵车）', () => {
    const storage = new MemoryStorage();
    storage.setItem(V3_KEY, JSON.stringify({ version: 3, rulesetVersion: TUNING.save.rulesetVersion }));
    const store = makeStore(storage);
    assert.equal(store.bestTotalMs, null);
    assert.equal(store.bestGhost, null);
    assert.deepEqual(store.bestSectorsMs, [null, null, null]);
    assert.deepEqual(store.history, []);
  });

  it('clear 会清空当前键与遗留旧键', () => {
    const storage = new MemoryStorage();
    storage.setItem(V1_KEY, JSON.stringify({ version: 1, bestTotalMs: 1, bestLapMs: 1 }));
    storage.setItem(V2_KEY, JSON.stringify(v2Save(TUNING.save.rulesetVersion)));
    const store = makeStore(storage);
    store.submit(makeRecord(), null, makeGhost());
    store.clear();
    assert.equal(store.bestTotalMs, null);
    assert.equal(store.bestGhost, null);
    assert.equal(storage.getItem(V3_KEY), null);
    assert.equal(storage.getItem(V2_KEY), null);
    assert.equal(storage.getItem(V1_KEY), null);
  });

  it('storage 为 null 时退化为纯内存，不抛异常', () => {
    const store = new SaveStore({ storage: null, key: V3_KEY, version: 3 });
    const outcome = store.submit(makeRecord(), null, makeGhost());
    assert.equal(outcome.persisted, false);
    assert.equal(store.isPersistent, false);
    assert.equal(store.bestTotalMs, 52000, '内存里仍然可用');
    assert.ok(store.bestGhost);
  });

  it('默认键与版本号就是 v3 契约里的值', () => {
    assert.equal(TUNING.save.key, 'f1race.save.v3');
    assert.equal(TUNING.save.version, 3);
    const store = new SaveStore({ storage: null });
    assert.equal(store.snapshot().version, 3);
  });
});

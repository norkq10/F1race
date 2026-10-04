import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TUNING } from '../src/game/constants';
import { SaveStore, TrackSaveStores, type StorageLike } from '../src/game/SaveStore';
import type { RunRecord } from '../src/game/types';

/** 内存版 localStorage。 */
function makeStorage(): StorageLike & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

function record(totalMs: number, bestLapMs = totalMs / 3): RunRecord {
  return {
    at: new Date(0).toISOString(),
    totalMs,
    bestLapMs,
    lapTimesMs: [bestLapMs, bestLapMs, bestLapMs],
    sectorsMs: [],
    valid: true,
    invalidReason: null,
  };
}

describe('多赛道存档隔离', () => {
  it('默认赛道沿用基键，其余赛道各自加后缀（默认赛道的旧成绩原地继承）', () => {
    const stores = new TrackSaveStores('track1', { key: 'f1race.save.v3' });
    assert.equal(stores.keyFor('track1'), 'f1race.save.v3');
    assert.equal(stores.keyFor('track2'), 'f1race.save.v3@track2');
    assert.equal(stores.keyFor('track3'), 'f1race.save.v3@track3');
  });

  it('同一 id 反复取到的是同一个实例', () => {
    const stores = new TrackSaveStores('track1', { storage: makeStorage() });
    assert.equal(stores.for('track2'), stores.for('track2'));
    assert.notEqual(stores.for('track2'), stores.for('track3'));
  });

  it('不同赛道的纪录互不覆盖（track2 的 90 秒不会盖掉 track1 的 45 秒）', () => {
    const storage = makeStorage();
    const stores = new TrackSaveStores('track1', { storage });

    stores.for('track1').submit(record(45_000), null, null);
    stores.for('track2').submit(record(90_000), null, null);

    assert.equal(stores.for('track1').bestTotalMs, 45_000);
    assert.equal(stores.for('track2').bestTotalMs, 90_000);
    // 各写各的键
    const keys = Object.keys(storage.dump());
    assert.ok(keys.includes('f1race.save.v3'), `缺少 track1 的键：${keys.join(', ')}`);
    assert.ok(keys.includes('f1race.save.v3@track2'), `缺少 track2 的键：${keys.join(', ')}`);
  });

  it('清空某条赛道的纪录不影响其他赛道', () => {
    const storage = makeStorage();
    const stores = new TrackSaveStores('track1', { storage });
    stores.for('track1').submit(record(45_000), null, null);
    stores.for('track2').submit(record(90_000), null, null);

    stores.for('track1').clear();

    assert.equal(stores.for('track1').bestTotalMs, null);
    assert.equal(stores.for('track2').bestTotalMs, 90_000);
  });

  it('新开的存档实例能读到对应赛道已落盘的成绩', () => {
    const storage = makeStorage();
    new TrackSaveStores('track1', { storage }).for('track3').submit(record(60_000), null, null);

    const fresh = new TrackSaveStores('track1', { storage }).for('track3');
    assert.equal(fresh.bestTotalMs, 60_000);
    // 其他赛道仍然干净
    assert.equal(new TrackSaveStores('track1', { storage }).for('track1').bestTotalMs, null);
  });

  it('每条赛道的存档键都符合 TUNING.save.key 的前缀约定，便于排查', () => {
    const stores = new TrackSaveStores('track1', { storage: makeStorage() });
    assert.ok(stores.keyFor('track2').startsWith(TUNING.save.key));
    assert.equal(new SaveStore({ storage: makeStorage(), key: stores.keyFor('track2') }).bestTotalMs, null);
  });
});

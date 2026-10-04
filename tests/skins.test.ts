import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SKINS,
  SKINS_STORAGE_KEY,
  SKINS_VERSION,
  SKIN_IDS,
  STARTER_SKIN_ID,
  createSkinState,
  deserializeSkins,
  equipSkin,
  hasSkin,
  normalizeSkinState,
  pickSkinDrop,
  serializeSkins,
  unlockSkin,
} from '../src/game/Skins';
import { TUNING, SKIN_ASSET_SUFFIXES, ASSETS, skinAssetKey, skinAssetUrl } from '../src/game/constants';
import { SkinStore } from '../src/game/SkinStore';

/**
 * 皮肤系统的数据层（CR-15）。
 *
 * 这组测试守住三条设计约束：
 *  1. **存储与成绩存档解耦**（独立 key）—— 操控规则升版会清空纪录，
 *     但外观解锁不该跟着丢（known-issues 第 16 条）。
 *  2. **皮肤不影响任何数值** —— 收集品不能变成"花钱变快"。
 *  3. **重复抽奖必须被明确处理**，不能静默吞掉。
 */
describe('皮肤定义', () => {
  it('首版 6 款，id 唯一，且文件后缀唯一（生成器按后缀命名）', () => {
    assert.equal(SKIN_IDS.length, 6, `应有 6 款皮肤，实际 ${SKIN_IDS.length}`);
    const suffixes = SKIN_IDS.map((id) => SKINS[id].assetSuffix);
    assert.equal(new Set(suffixes).size, suffixes.length, 'assetSuffix 不能重复');
    for (const id of SKIN_IDS) {
      assert.equal(SKINS[id].id, id, `SKINS["${id}"].id 与键不一致 —— 会导致查表错位`);
    }
  });

  it('每款皮肤都有名字与说明（车库要显示）', () => {
    for (const id of SKIN_IDS) {
      const skin = SKINS[id];
      assert.ok(skin.label.length > 0, `${id} 缺少 label`);
      assert.ok(skin.desc.length > 0, `${id} 缺少 desc`);
    }
  });

  it('存储键与成绩存档的键**不同**（外观解锁不能被规则升版清掉）', () => {
    assert.ok(SKINS_STORAGE_KEY.startsWith('f1race.'));
    assert.notEqual(
      SKINS_STORAGE_KEY,
      TUNING.save.key,
      '皮肤必须走独立键，绝不能复用成绩存档的键',
    );
    assert.ok(
      !SKINS_STORAGE_KEY.startsWith(TUNING.save.key),
      '皮肤键不能挂在成绩存档键下面（否则清纪录时会连带清掉外观）',
    );
  });

  it('皮肤定义里没有任何数值字段（不能影响速度 / 抓地 / 碰撞）', () => {
    // 白名单式断言：新增字段必须在这里显式登记，防止有人偷偷加个 speedBonus
    const allowed = new Set(['id', 'label', 'assetSuffix', 'rarity', 'desc']);
    for (const id of SKIN_IDS) {
      for (const key of Object.keys(SKINS[id])) {
        assert.ok(allowed.has(key), `皮肤 ${id} 出现了预期外的字段 "${key}" —— 皮肤不许带数值`);
      }
    }
  });

  it('皮肤后缀与 constants 的 SKIN_ASSET_SUFFIXES 一一对应（漏改一边就不去加载贴图）', () => {
    // 三处必须同步：Skins.ts 的 assetSuffix、gen-assets.mjs 的 SKIN_PALETTES 键、
    // constants.ts 的 SKIN_ASSET_SUFFIXES。后者决定 BootScene 会 preload 哪几张图 ——
    // 漏登记的症状是"车库能选中，但车身变成默认贴图/空白"，很难一眼看出。
    const fromSkins = SKIN_IDS.map((id) => SKINS[id].assetSuffix).sort();
    const fromConstants = [...SKIN_ASSET_SUFFIXES].sort();
    assert.deepEqual(fromSkins, fromConstants, 'Skins.assetSuffix 与 SKIN_ASSET_SUFFIXES 必须完全一致');
    for (const suffix of SKIN_ASSET_SUFFIXES) {
      assert.ok(skinAssetKey(suffix).startsWith('car_skin_'), '皮肤贴图 key 必须有独立前缀，别和占位车贴图撞车');
      assert.ok(skinAssetUrl(suffix).endsWith(`/player_${suffix}.png`), `皮肤贴图路径不对：${skinAssetUrl(suffix)}`);
    }
  });

  it('皮肤贴图 key 与既有的玩家 / AI / 幽灵车贴图都不同（换皮肤不该连累别人）', () => {
    // 显式标注成 string：`Set<"car_player" | …>` 的 has() 只接受那几个字面量，
    // 传 skinAssetKey() 的结果会被 TS 直接拒掉（这里想验的正是"不等于"）。
    const carKeys = new Set<string>([ASSETS.carPlayerKey, ASSETS.carAiKey, ASSETS.carGhostKey]);
    for (const suffix of SKIN_ASSET_SUFFIXES) {
      assert.ok(!carKeys.has(skinAssetKey(suffix)), `${skinAssetKey(suffix)} 与既有车贴图 key 撞了`);
    }
    assert.equal(new Set(SKIN_ASSET_SUFFIXES.map((s) => skinAssetKey(s))).size, SKIN_ASSET_SUFFIXES.length);
  });
});

describe('车库状态', () => {
  it('初始只有原厂皮肤，且已装备', () => {
    const state = createSkinState();
    assert.deepEqual(state.owned, [STARTER_SKIN_ID]);
    assert.equal(state.equipped, STARTER_SKIN_ID);
  });

  it('解锁新皮肤：isNew 为 true，且不改变当前装备', () => {
    const before = createSkinState();
    const { state, isNew } = unlockSkin(before, 'gold');
    assert.equal(isNew, true);
    assert.ok(hasSkin(state, 'gold'));
    assert.equal(state.equipped, STARTER_SKIN_ID, '解锁不该自动装备');
  });

  it('重复解锁：isNew 为 false（调用方必须给出明确处理，不能静默吞掉）', () => {
    const { state } = unlockSkin(createSkinState(), 'gold');
    const again = unlockSkin(state, 'gold');
    assert.equal(again.isNew, false, '重复抽到必须能被识别出来');
    assert.deepEqual(again.state.owned, state.owned, '重复解锁不该改变拥有列表');
  });

  it('解锁不存在的 id 不生效也不抛异常', () => {
    const before = createSkinState();
    const result = unlockSkin(before, 'not-a-skin');
    assert.equal(result.isNew, false);
    assert.deepEqual(result.state.owned, before.owned);
  });

  it('装备已拥有的皮肤生效；装备未拥有的**不生效**（不替玩家解锁）', () => {
    const { state } = unlockSkin(createSkinState(), 'gold');
    assert.equal(equipSkin(state, 'gold').equipped, 'gold');
    const locked = equipSkin(createSkinState(), 'gold');
    assert.equal(locked.equipped, STARTER_SKIN_ID);
    assert.ok(!hasSkin(locked, 'gold'), '装备操作不该顺带解锁');
  });

  it('装备同一款是幂等的（返回同一引用，便于做"没变就不刷 UI"）', () => {
    const state = createSkinState();
    assert.equal(equipSkin(state, STARTER_SKIN_ID), state);
  });
});

describe('存档规范化与版本迁移', () => {
  it('过滤掉不认识的 id、去重', () => {
    const state = normalizeSkinState({ owned: ['gold', 'gold', 'bogus', 'red'], equipped: 'gold' });
    // 注意 default 会被**刻意补在最前**（见下一条），所以这里期望它也在
    assert.deepEqual(state.owned, [STARTER_SKIN_ID, 'gold', 'red']);
    assert.equal(state.equipped, 'gold');
    assert.ok(!state.owned.includes('bogus'), '不认识的 id 必须被过滤掉');
  });

  it('老档漏了初始皮肤时自动补上（不能让玩家失去默认外观）', () => {
    const state = normalizeSkinState({ owned: ['gold'], equipped: 'gold' });
    assert.ok(state.owned.includes(STARTER_SKIN_ID));
    assert.ok(state.owned.includes('gold'));
  });

  it('equipped 指向未拥有的皮肤时回落到初始款', () => {
    assert.equal(normalizeSkinState({ owned: ['red'], equipped: 'gold' }).equipped, STARTER_SKIN_ID);
    assert.equal(normalizeSkinState({ owned: ['red'], equipped: 'not-a-skin' }).equipped, STARTER_SKIN_ID);
    assert.equal(normalizeSkinState({ owned: ['red'] }).equipped, STARTER_SKIN_ID);
  });

  it('非法输入不抛异常，回落到全新状态', () => {
    for (const bad of [null, undefined, 42, 'x', [], { owned: 'nope' }, {}]) {
      assert.doesNotThrow(() => normalizeSkinState(bad));
    }
    assert.deepEqual(normalizeSkinState(null).owned, [STARTER_SKIN_ID]);
  });

  it('序列化 → 反序列化往返一致', () => {
    const { state } = unlockSkin(createSkinState(), 'carbon');
    const equipped = equipSkin(state, 'carbon');
    const round = deserializeSkins(serializeSkins(equipped));
    assert.deepEqual(round, equipped);
  });

  it('版本不一致时丢弃旧数据、返回全新状态（不报错）', () => {
    const stale = JSON.stringify({ version: SKINS_VERSION + 1, owned: ['gold'], equipped: 'gold' });
    assert.deepEqual(deserializeSkins(stale), createSkinState());
    const old = JSON.stringify({ version: 0, owned: ['gold'], equipped: 'gold' });
    assert.deepEqual(deserializeSkins(old), createSkinState());
  });

  it('坏 JSON / 空值不抛异常', () => {
    assert.deepEqual(deserializeSkins(null), createSkinState());
    assert.deepEqual(deserializeSkins('{oops'), createSkinState());
  });
});

describe('抽奖掉落', () => {
  const table = [
    { id: 'red', weight: 40 },
    { id: 'blue', weight: 40 },
    { id: 'gold', weight: 20 },
  ];

  it('随机源为 0 时落在第一项，接近 1 时落在最后一项', () => {
    assert.equal(pickSkinDrop(() => 0, table), 'red');
    assert.equal(pickSkinDrop(() => 0.999, table), 'gold');
  });

  it('权重决定区间宽度（0.4 是 red/blue 的分界）', () => {
    assert.equal(pickSkinDrop(() => 0.39, table), 'red');
    assert.equal(pickSkinDrop(() => 0.41, table), 'blue');
    assert.equal(pickSkinDrop(() => 0.81, table), 'gold');
  });

  it('全零权重时回落到初始皮肤（不产生 undefined）', () => {
    assert.equal(pickSkinDrop(() => 0.5, [{ id: 'gold', weight: 0 }]), STARTER_SKIN_ID);
    assert.equal(pickSkinDrop(() => 0.5, []), STARTER_SKIN_ID);
  });

  it('负权重被忽略（不能靠负权重把概率推成负数）', () => {
    const withNegative = [
      { id: 'red', weight: -100 },
      { id: 'gold', weight: 10 },
    ];
    assert.equal(pickSkinDrop(() => 0.5, withNegative), 'gold');
  });

  it('TUNING.skins 的掉落表只含真实存在的皮肤 id', () => {
    assert.ok(Array.isArray(TUNING.skins.dropTable), 'dropTable 必须是数组');
    assert.ok(TUNING.skins.dropTable.length > 0, 'dropTable 不能为空');
    for (const entry of TUNING.skins.dropTable) {
      assert.ok(SKINS[entry.id], `掉落表里的 "${entry.id}" 不是真实皮肤`);
      assert.ok(entry.weight > 0, `掉落表里的 "${entry.id}" 权重必须为正`);
    }
  });

  it('重复奖励配置有明确取值（不是"静默吞掉"）', () => {
    assert.ok(
      TUNING.skins.duplicateReward === 'currency' || TUNING.skins.duplicateReward === 'notice',
      `duplicateReward 必须是 'currency' 或 'notice'，实际 ${String(TUNING.skins.duplicateReward)}`,
    );
  });

  it('CR-08：抽奖发布默认中奖率不得是 0.99（99% 只能待在调试覆盖里）', () => {
    assert.notEqual(TUNING.lottery.winRate, 0.99, 'CR-08 明令禁止把测试阶段的 99% 当作发布默认值');
    assert.ok(TUNING.lottery.winRate > 0 && TUNING.lottery.winRate <= 1, `winRate 必须在 (0,1]，实际 ${TUNING.lottery.winRate}`);
    // 抽奖**发布默认开启**（CR-15 之后它有了真实产出：解锁皮肤）。
    // CR-08 的硬要求只是"默认中奖率不得是 0.99"，那条由上面的断言守着；
    // 开关本身保留，供需要纯计时的场合一键关掉。
    assert.equal(TUNING.lottery.enabled, true, '抽奖是皮肤的唯一产出通道，发布默认应当是开的');
    // 调试覆盖必须是接近必中的高概率，否则 e2e 走不通"中奖 → 解锁皮肤"这条链路
    assert.ok(TUNING.lottery.testWinRate >= 0.99, 'testWinRate 应接近必中，供自动化验收使用');
  });
});

/** 内存存储（模拟 localStorage），用于验证落盘行为。 */
function makeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/**
 * 皮肤车库的持久化（CR-15）。
 *
 * 重点验证**生命周期与成绩存档解耦**：清掉成绩不该影响皮肤，
 * 反过来也一样。这是 `docs/change-requests.md` 反复强调的一条。
 */
describe('皮肤车库持久化 SkinStore', () => {
  it('全新车库只有初始皮肤', () => {
    const store = new SkinStore({ storage: makeStorage() });
    assert.deepEqual(store.snapshot, { owned: [STARTER_SKIN_ID], equipped: STARTER_SKIN_ID });
    assert.equal(store.isPersistent, true);
  });

  it('解锁后立刻落盘，且新实例能读回来', () => {
    const storage = makeStorage();
    const first = new SkinStore({ storage });
    assert.equal(first.unlock('gold'), true, '首次解锁应返回 true');
    const second = new SkinStore({ storage });
    assert.ok(second.has('gold'), '新实例应读回已解锁的皮肤');
  });

  it('装备后立刻落盘，且新实例读到的是装备款', () => {
    const storage = makeStorage();
    const first = new SkinStore({ storage });
    first.unlock('carbon');
    assert.equal(first.equip('carbon'), true);
    assert.equal(new SkinStore({ storage }).equipped, 'carbon');
  });

  it('重复解锁返回 false 且不重复写入拥有列表', () => {
    const store = new SkinStore({ storage: makeStorage() });
    store.unlock('red');
    assert.equal(store.unlock('red'), false, '重复抽到必须能被识别');
    assert.equal(store.owned.filter((id) => id === 'red').length, 1);
  });

  it('装备未拥有的皮肤不生效、不落盘', () => {
    const storage = makeStorage();
    const store = new SkinStore({ storage });
    assert.equal(store.equip('gold'), false);
    assert.equal(store.equipped, STARTER_SKIN_ID);
    assert.equal(storage.getItem(SKINS_STORAGE_KEY), null, '失败的操作不该写盘');
  });

  it('存储键与成绩存档键不同 —— 清纪录不该弄丢外观', () => {
    const storage = makeStorage();
    const store = new SkinStore({ storage });
    store.unlock('ghost');
    // 模拟"清空成绩存档"：删掉成绩键
    storage.removeItem(TUNING.save.key);
    const after = new SkinStore({ storage });
    assert.ok(after.has('ghost'), '清成绩后外观必须还在');
  });

  it('清空车库回到初始状态', () => {
    const storage = makeStorage();
    const store = new SkinStore({ storage });
    store.unlock('gold');
    store.equip('gold');
    store.clear();
    assert.deepEqual(store.snapshot, { owned: [STARTER_SKIN_ID], equipped: STARTER_SKIN_ID });
    assert.deepEqual(new SkinStore({ storage }).snapshot, store.snapshot);
  });

  it('纯内存模式（storage: null）不抛异常，只是不落盘', () => {
    const store = new SkinStore({ storage: null });
    assert.equal(store.isPersistent, false);
    assert.doesNotThrow(() => {
      store.unlock('red');
      store.equip('red');
    });
    assert.equal(store.equipped, 'red', '内存模式下当次会话仍然有效');
  });

  it('读到的数据损坏时不抛异常，退回全新车库', () => {
    const storage = makeStorage({ [SKINS_STORAGE_KEY]: '{broken json' });
    assert.doesNotThrow(() => new SkinStore({ storage }));
    assert.deepEqual(new SkinStore({ storage }).snapshot, {
      owned: [STARTER_SKIN_ID],
      equipped: STARTER_SKIN_ID,
    });
  });

  it('存储抛异常（配额满 / 隐私模式）时降级为内存模式，不影响游戏', () => {
    const hostile = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    // 构造与使用分开写：`let store: SkinStore | null` 在闭包里赋值后
    // TS 会把它窄化成 never，直接用会在 `store.isPersistent` 上报错。
    const store = new SkinStore({ storage: hostile });
    assert.doesNotThrow(() => {
      store.unlock('red');
    });
    assert.equal(store.isPersistent, true, '注入了 storage 就仍算"有存储"');
    assert.equal(store.equipped, STARTER_SKIN_ID);
    assert.ok(store.has('red'), '写盘失败但内存状态仍应更新');
  });
});

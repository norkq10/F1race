import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONTACT,
  computeCarContact,
  draftFactor,
  isInDraftZone,
  separatePositions,
  wrapAnglePi,
} from '../src/game/CarContact';

const R = 12;

/**
 * 车车碰撞的响应计算（CR-06 第 3 项）。
 *
 * 原来的实现是"两边各 applyImpact(法线)"—— 只有减速 + 反向弹开，
 * 两车一碰就互相弹飞，没法并排跑。这组测试钉住新模型的两条性质：
 *   **并排时能贴着跑**（不弹飞），**追尾时后车明显掉速**（有撞击感）。
 */
describe('车车碰撞 computeCarContact', () => {
  it('并排同向行驶：只传递少量切向摩擦，不产生"弹飞"', () => {
    // 两车并排（y 差 20px，小于直径 24），都朝 +x、都以 400px/s 前进
    const r = computeCarContact(0, 0, 20, 0, { speed: 400, heading: 0 }, { speed: 400, heading: 0 }, R);
    // 速度相同 → 没有速度差可传递，也没有靠近趋势 → 冲量应该几乎为 0
    assert.ok(Math.abs(r.aSpeedDelta) < 1e-6, `A 车不该被推动，实际 ${r.aSpeedDelta}`);
    assert.ok(Math.abs(r.bSpeedDelta) < 1e-6, `B 车不该被推动，实际 ${r.bSpeedDelta}`);
    assert.ok(r.overlap > 0, '并排时应当检测到重叠（由位置分离负责推开）');
  });

  it('追尾：后车减速、前车加速（能量沿法线传递）', () => {
    // A 在 B 正后方 20px（重叠 4px），都朝 +x；A 快、B 慢
    const r = computeCarContact(0, 0, 20, 0, { speed: 500, heading: 0 }, { speed: 300, heading: 0 }, R);
    assert.ok(r.aSpeedDelta < 0, `后车 A 应该减速，实际 delta=${r.aSpeedDelta}`);
    assert.ok(r.bSpeedDelta > 0, `前车 B 应该被推快，实际 delta=${r.bSpeedDelta}`);
    // 动量方向守恒：两者冲量之和应接近 0（等质量）
    assert.ok(Math.abs(r.aSpeedDelta + r.bSpeedDelta) < 1e-6, '两车冲量应等大反向');
  });

  it('回弹只在"正在靠近"时生效（分开时不该越弹越远）', () => {
    // A 已经比 B 慢（A=200, B=400）——它们在分开，不该再有回弹
    const apart = computeCarContact(0, 0, 20, 0, { speed: 200, heading: 0 }, { speed: 400, heading: 0 }, R);
    // 摩擦会把速度差往中间拉：A 变快、B 变慢（这是合理的，接触期间互相拖拽）
    assert.ok(apart.aSpeedDelta > 0, 'A 应被 B 拖着加速');
    assert.ok(apart.bSpeedDelta < 0, 'B 应被 A 拖着减速');
    // 但不该出现"反向弹开"那种大冲量
    assert.ok(
      Math.abs(apart.aSpeedDelta) <= DEFAULT_CONTACT.maxSpeedTransfer,
      `冲量被上限约束住了，实际 ${apart.aSpeedDelta}`,
    );
  });

  it('单次接触的速度传递有上限（防止并排贴着跑被逐帧吸干速度）', () => {
    // 速度差极大：不设上限的话 transfer 会非常大
    const r = computeCarContact(0, 0, 20, 0, { speed: 3000, heading: 0 }, { speed: 0, heading: 0 }, R);
    assert.ok(
      Math.abs(r.aSpeedDelta) <= DEFAULT_CONTACT.maxSpeedTransfer + 1e-6,
      `A 的冲量应被 maxSpeedTransfer 限制，实际 ${r.aSpeedDelta}`,
    );
  });

  it('垂直相交（T 字）：沿法线传递，方向正确', () => {
    // A 朝 +x 从左侧撞上朝 +y 的 B
    const r = computeCarContact(0, 0, 20, 0, { speed: 400, heading: 0 }, { speed: 400, heading: Math.PI / 2 }, R);
    // 法线 +x：A 的纵向速度全在法线上，B 的纵向速度与法线垂直（投影为 0）
    assert.ok(r.aSpeedDelta < 0, 'A 应减速');
    // B 的纵向与法线垂直 → 摩擦传递不到它身上
    assert.ok(Math.abs(r.bSpeedDelta) < 1e-6, `B 纵向速度与法线垂直，不该被推动，实际 ${r.bSpeedDelta}`);
  });

  it('圆心完全重合时法线有确定默认值（结果可复现，不随调用顺序抖动）', () => {
    const a = computeCarContact(100, 100, 100, 100, { speed: 300, heading: 0 }, { speed: 300, heading: 0 }, R);
    const b = computeCarContact(100, 100, 100, 100, { speed: 300, heading: 0 }, { speed: 300, heading: 0 }, R);
    assert.deepEqual(a, b, '同一输入必须给出同一结果');
    assert.equal(a.nx, 1);
    assert.equal(a.ny, 0);
    assert.equal(a.overlap, R * 2, '完全重合时重叠深度 = 直径');
  });

  it('返回法线与重叠深度，供调用方做位置分离', () => {
    const r = computeCarContact(0, 0, 18, 0, { speed: 0, heading: 0 }, { speed: 0, heading: 0 }, R);
    assert.ok(Math.abs(r.nx - 1) < 1e-9 && Math.abs(r.ny) < 1e-9);
    assert.equal(r.distance, 18);
    assert.equal(r.overlap, R * 2 - 18);
  });
});

describe('位置分离 separatePositions', () => {
  it('重叠时两车各推一半（不偏向任何一台）', () => {
    const s = separatePositions(1, 0, 10);
    assert.equal(s.aDx, -5);
    assert.equal(s.bDx, 5);
    // 用 === 0 而不是 assert.equal：`-0 === 0` 为 true，但 assert.equal 是严格比较，
    // 会把 -0 与 0 判成不等（正交几何里很容易算出 -0）。
    assert.ok(s.aDy === 0, `aDy 应为 0，实际 ${s.aDy}`);
    assert.ok(s.bDy === 0, `bDy 应为 0，实际 ${s.bDy}`);
  });

  it('没重叠时不推（避免把本来没碰的车推开）', () => {
    for (const overlap of [0, -3]) {
      const s = separatePositions(1, 0, overlap);
      assert.ok(s.aDx === 0 && s.aDy === 0 && s.bDx === 0 && s.bDy === 0, `overlap=${overlap} 时不该推`);
    }
  });

  it('分离方向沿法线（斜向接触也正确）', () => {
    const s = separatePositions(0, 1, 8);
    assert.equal(s.aDy, -4);
    assert.equal(s.bDy, 4);
  });
});

/**
 * 尾流（CR-06 第 2 项）。
 *
 * 对玩家与 AI 同时生效 —— 它是物理规则，不是 AI 特权，
 * 所以不违反"不作弊"的立场。
 */
describe('尾流 draftFactor', () => {
  const CFG = { rangePx: 120, maxHeadingRad: 0.35, factor: 0.85 };

  it('紧跟正前方时拿到全额收益（阻力系数 = factor）', () => {
    assert.ok(Math.abs(draftFactor(0, 0, CFG) - CFG.factor) < 1e-9);
  });

  it('距离越远收益越小，到 rangePx 处完全消失', () => {
    const near = draftFactor(30, 0, CFG);
    const mid = draftFactor(60, 0, CFG);
    const edge = draftFactor(CFG.rangePx, 0, CFG);
    assert.ok(near < mid && mid < edge, `收益应随距离递减：${near} / ${mid} / ${edge}`);
    assert.equal(edge, 1, '正好在边界上应无收益');
  });

  it('超出距离 / 航向差过大时完全没有尾流', () => {
    assert.equal(draftFactor(CFG.rangePx + 1, 0, CFG), 1);
    assert.equal(draftFactor(50, CFG.maxHeadingRad + 0.1, CFG), 1);
    assert.equal(draftFactor(50, -CFG.maxHeadingRad - 0.1, CFG), 1);
  });

  it('系数永远 ≤ 1（尾流只会减阻，不会加速）', () => {
    for (const gap of [0, 1, 30, 60, 90, 119, 120, 200]) {
      const f = draftFactor(gap, 0, CFG);
      assert.ok(f <= 1 + 1e-9, `gap=${gap} 时系数 ${f} > 1`);
      assert.ok(f >= CFG.factor - 1e-9, `gap=${gap} 时系数 ${f} 小于收益下界`);
    }
  });

  it('非法输入（NaN / 负数）安全回落到"无尾流"', () => {
    assert.equal(draftFactor(Number.NaN, 0, CFG), 1);
    assert.equal(draftFactor(-10, 0, CFG), 1);
  });
});

describe('尾流判定 isInDraftZone', () => {
  const CFG = { rangePx: 120, maxHeadingRad: 0.35, minForwardPx: 8 };

  it('正前方同向的车算在尾流区里', () => {
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: 0 }, { x: 60, y: 0, heading: 0 }, CFG), true);
  });

  it('正后方的车不算（尾流只在前方）', () => {
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: 0 }, { x: -60, y: 0, heading: 0 }, CFG), false);
  });

  it('并排的车不算（距离够近但在侧面）', () => {
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: 0 }, { x: 2, y: 20, heading: 0 }, CFG), false);
  });

  it('横向交错的车不算（航向差太大）', () => {
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: 0 }, { x: 60, y: 0, heading: Math.PI / 2 }, CFG), false);
  });

  it('超出距离就出尾流区', () => {
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: 0 }, { x: 200, y: 0, heading: 0 }, CFG), false);
  });

  it('朝向不同的车头方向都正确（不是只对 heading=0 有效）', () => {
    // 车头朝 +y（南），前车在它的正前方
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: Math.PI / 2 }, { x: 0, y: 60, heading: Math.PI / 2 }, CFG), true);
    // 同样位置但车头朝 -y，前车就在背后了
    assert.equal(isInDraftZone({ x: 0, y: 0, heading: -Math.PI / 2 }, { x: 0, y: 60, heading: -Math.PI / 2 }, CFG), false);
  });

  it('跨 ±π 的航向差不影响判定（否则真实跟车会被漏掉）', () => {
    // 两车航向都在 π 附近、相差很小：不归一化的话会被算成 2π 级别的大差
    const self = { x: 0, y: 0, heading: Math.PI - 0.05 };
    const ahead = { x: -60 * Math.cos(0.05), y: -60 * Math.sin(0.05), heading: -Math.PI + 0.05 };
    assert.equal(
      isInDraftZone(self, ahead, CFG),
      true,
      '航向差应归一化到小角度，不能因为跨 ±π 就判定成"横向交错"',
    );
  });
});

describe('wrapAnglePi', () => {
  it('把角度归一化到 (-π, π]', () => {
    assert.ok(Math.abs(wrapAnglePi(0)) < 1e-12);
    assert.ok(Math.abs(wrapAnglePi(Math.PI * 2) - 0) < 1e-9);
    assert.ok(Math.abs(wrapAnglePi(Math.PI * 2 + 0.3) - 0.3) < 1e-9);
    assert.ok(Math.abs(wrapAnglePi(-Math.PI * 2 - 0.3) + 0.3) < 1e-9);
  });

  it('跨 ±π 的小差不会被放大', () => {
    // 两车航向分别落在 ±π 两侧、实际只差 0.1 弧度。
    // 不归一化的话这个差会被算成 2π − 0.1 ≈ 6.18，尾流判定必然失效。
    const raw = Math.PI - 0.05 - (-Math.PI + 0.05); // ≈ 6.183
    const diff = wrapAnglePi(raw);
    assert.ok(
      Math.abs(Math.abs(diff) - 0.1) < 1e-9,
      `归一化后绝对值应约为 0.1，实际 ${diff}（原始 ${raw}）`,
    );
    assert.ok(Math.abs(diff) <= Math.PI, '结果必须落在 (-π, π] 内');
  });
});

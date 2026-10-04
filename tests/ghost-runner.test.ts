import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GhostRunner, accumulateProgress } from '../src/game/GhostRunner';

const TOTAL = 7500;

/**
 * 幽灵车进度累计。
 *
 * 这里锁的是一个很容易被"简化"掉的细节：进度必须用 **±半圈归一的增量累加**。
 * 直接取当前 `arc` 当进度的话，幽灵车每过一次起跑线进度就从 7500 掉回 0，
 * HUD 上的时间差会在那一瞬间从"+1.2 秒"跳到"-40 秒"。
 */
describe('幽灵车进度累计 GhostRunner', () => {
  it('尚未开始时 advance 只记录基准，不产生进度', () => {
    const runner = new GhostRunner(TOTAL);
    assert.equal(runner.progress, 0);
    assert.equal(runner.advance(1234), 0, '第一次 advance 只该建立基准');
    assert.equal(runner.progress, 0);
    assert.equal(runner.arc, 1234);
  });

  it('同向推进时进度单调累加', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(0);
    runner.advance(100);
    runner.advance(250);
    runner.advance(400);
    assert.equal(runner.progress, 400);
  });

  it('过起跑线时进度**不回跳**（跨线用负增量归一）', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(TOTAL - 100);
    // 已经跑到 7400，下一帧过线回到 50 —— 归一后应算出 +150
    runner.advance(TOTAL - 20);
    assert.equal(runner.progress, 80);
    // 再次过线，进度继续涨（不能掉回去）
    runner.advance(50);
    assert.ok(runner.progress >= 80, `过线后进度不该变小，实际 ${runner.progress}`);
    assert.ok(runner.progress < TOTAL, '单帧不该凭空多出大半圈');
  });

  it('连续多圈累加结果与真实里程一致', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(0);
    // 模拟跑满 3 圈，每圈 1000 个采样点
    for (let lap = 0; lap < 3; lap++) {
      for (let i = 1; i <= 1000; i++) runner.advance(((TOTAL * i) / 1000) % TOTAL);
    }
    // 3 圈整，进度应约等于 3 × TOTAL（末点取模后落在 0 附近，允许一个采样点的误差）
    assert.ok(
      Math.abs(runner.progress - 3 * TOTAL) < TOTAL / 100,
      `3 圈后进度应约 ${3 * TOTAL}，实际 ${runner.progress.toFixed(0)}`,
    );
  });

  it('reset 会清零进度并重建基准', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(0);
    runner.advance(3000);
    assert.equal(runner.progress, 3000);
    runner.reset(TOTAL - 10);
    assert.equal(runner.progress, 0);
    assert.equal(runner.arc, TOTAL - 10);
  });

  it('时间差：玩家领先为正、落后为负', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(0);
    runner.advance(1000);
    // 玩家 2000px、幽灵 1000px、车速 500px/s → 领先 1000px = 2 秒
    assert.equal(runner.gapMs(2000, 500), 2000);
    assert.equal(runner.gapMs(0, 500), -2000);
  });

  it('玩家静止时时间差不会变成 Infinity（分母有下限）', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(0);
    const gap = runner.gapMs(500, 0);
    assert.ok(Number.isFinite(gap), `静止时不该算出 Infinity，实际 ${gap}`);
    assert.ok(gap > 0, '玩家进度更靠前时仍应显示领先');
  });

  it('倒退（负增量）被钳到 0，进度不会变负', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(500);
    runner.advance(400); // 理论上是"倒退 100"
    assert.ok(runner.progress >= 0, `进度不该为负，实际 ${runner.progress}`);
  });
});

describe('accumulateProgress 纯函数版', () => {
  it('连续前进的跨线序列：进度严格递增（不会在过线处掉下去）', () => {
    // 一路向前、中途跨过起跑线：这是真实回放的样子
    const arcs = [TOTAL - 200, TOTAL - 50, 10, 120, 400, 900, 1600];
    const out = accumulateProgress(arcs, TOTAL);
    assert.equal(out.length, arcs.length);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i] > out[i - 1], `第 ${i} 步进度没涨：${out[i - 1]} → ${out[i]}`);
    }
    assert.equal(out[0], 0);
    // 净位移 = 从 7300 绕过 0 走到 1600 = 200 + 50 + 1600 = 1800
    // （若跨线没做归一，这里会算成 1600 − 7300 = −5700，被钳成 0）
    assert.equal(out[out.length - 1], 1800, '跨线处的增量必须按"绕一圈"归一');
  });

  it('记录倒退时进度被钳住而不是变负（刻意行为，不是 bug）', () => {
    const runner = new GhostRunner(TOTAL);
    runner.reset(600);
    runner.advance(300); // 理论上是"倒退 300"
    assert.equal(runner.progress, 0, '负增量被钳到 0');
    assert.equal(runner.arc, 300, '但弧长基准要跟着更新，否则下一帧增量会算错');
  });

  it('单点序列返回 0', () => {
    assert.deepEqual(accumulateProgress([500], TOTAL), [0]);
  });

  it('空序列返回空数组', () => {
    assert.deepEqual(accumulateProgress([], TOTAL), []);
  });

  it('与 GhostRunner 的逐帧推进结果一致（同一实现，两条路径不该分叉）', () => {
    const arcs = [0, 1000, 2000, TOTAL - 100, 50, 900, TOTAL - 500];
    const viaFn = accumulateProgress(arcs, TOTAL);

    const runner = new GhostRunner(TOTAL);
    const viaRunner: number[] = [];
    for (const arc of arcs) {
      runner.advance(arc);
      viaRunner.push(runner.progress);
    }
    assert.deepEqual(viaRunner, viaFn);
  });
});

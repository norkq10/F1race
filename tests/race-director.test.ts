import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COUNTDOWN_LABELS, RaceDirector } from '../src/game/RaceDirector';

/** 造一个把副作用记下来的 director，方便断言"什么时候发生了什么"。 */
function makeDirector(countdownStepMs = 1000, countdownMs = 3000) {
  const log: string[] = [];
  const director = new RaceDirector(
    { countdownStepMs, countdownMs },
    {
      onCountdownStep: (label) => log.push(`step:${label}`),
      onBeginRacing: () => log.push('begin'),
      onPausedChanged: (paused) => log.push(paused ? 'pause' : 'resume'),
      onFinished: () => log.push('finish'),
    },
  );
  return { director, log };
}

/** 按 16ms 一帧推进到指定毫秒。 */
function advance(director: RaceDirector, ms: number, frameMs = 16): void {
  let left = ms;
  while (left > 0) {
    director.tick(Math.min(frameMs, left));
    left -= frameMs;
  }
}

/**
 * 状态机契约。
 *
 * 这里的每一条都对应一个真实踩过的坑（见 `docs/known-issues.md`）：
 * 「倒计时期间车辆不可动」曾经因为输入锁判断写在场景里而漏掉；
 * 「暂停不推进计时」曾经因为暂停只停物理、没停状态机而失效。
 */
describe('比赛状态机 RaceDirector', () => {
  it('初始处于倒计时，且不接受驾驶输入（REQ-015）', () => {
    const { director } = makeDirector();
    assert.equal(director.state, 'countdown');
    assert.equal(director.acceptsInput, false, '倒计时期间绝不能接受驾驶输入');
    assert.equal(director.paused, false);
  });

  it('倒计时按 3 → 2 → 1 依次播报，到时自动发车', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    assert.deepEqual(log.filter((x) => x.startsWith('step:')), ['step:3', 'step:2', 'step:1']);
    assert.ok(log.includes('begin'), '倒计时结束必须发车');
    assert.equal(director.state, 'racing');
    assert.equal(director.acceptsInput, true);
  });

  it('发车跃迁只发生一次（tick 返回 true 只在该帧，副作用也不重复）', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 2000);
    assert.equal(log.filter((x) => x === 'begin').length, 0, '还没到点就发车了');

    // 逐帧推进到发车那一帧，数一下 tick 返回了多少次 true
    let transitions = 0;
    let framesToBegin = 0;
    while (director.state === 'countdown' && framesToBegin < 500) {
      if (director.tick(16)) transitions += 1;
      framesToBegin += 1;
    }
    assert.equal(transitions, 1, '整个倒计时只应有**一次**发车跃迁');
    assert.equal(log.filter((x) => x === 'begin').length, 1, 'begin 副作用只该触发一次');

    // 已经进入 racing，后续 tick 不该再报跃迁
    for (let i = 0; i < 200; i++) {
      assert.equal(director.tick(16), false, '已在 racing，tick 不该再返回 true');
    }
  });

  it('倒计时期间暂停会**冻住倒计时**，恢复后接着走（不跳过暂停的那段）', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 500);
    assert.equal(director.pause(), true);
    assert.equal(director.paused, true);

    // 暂停期间推进 10 秒都不该发车
    advance(director, 10000);
    assert.equal(director.state, 'countdown', '暂停期间比赛不该开始');
    assert.equal(director.acceptsInput, false);

    director.resume();
    assert.ok(log.includes('pause') && log.includes('resume'));
    // 恢复后还需要再走 2.5 秒才发车（不是"已经过了 10 秒所以立刻发车"）
    advance(director, 2000);
    assert.equal(director.state, 'countdown', '剩余倒计时被错误地跳过了');
    advance(director, 700);
    assert.equal(director.state, 'racing');
  });

  it('暂停时状态机完全冻结：连续 tick 不推进任何计时', () => {
    const { director } = makeDirector(1000, 3000);
    advance(director, 3100); // 先进入 racing
    director.pause();
    const before = director.state;
    for (let i = 0; i < 100; i++) director.tick(16);
    assert.equal(director.state, before);
    assert.equal(director.paused, true);
  });

  it('racing 期间可以暂停与恢复', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    assert.equal(director.acceptsInput, true);
    director.togglePause();
    assert.equal(director.paused, true);
    assert.equal(director.acceptsInput, false, '暂停期间不接受驾驶输入');
    director.togglePause();
    assert.equal(director.paused, false);
    assert.equal(director.acceptsInput, true);
    assert.deepEqual(log.filter((x) => x === 'pause' || x === 'resume'), ['pause', 'resume']);
  });

  it('暂停期间切换回倒计时（reset）会清掉暂停态与覆盖层', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    director.pause();
    const logLen = log.length;
    director.reset();
    assert.equal(director.state, 'countdown');
    assert.equal(director.paused, false, '重开后不该还处于暂停态');
    assert.ok(log.slice(logLen).includes('resume'), '重开必须把暂停覆盖层收掉');
    assert.equal(director.countdownLabel, null, '重开后倒计时数字应重新从 3 开始');
  });

  it('结束后状态是 finished，且不接受输入', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    assert.equal(director.finish(), true);
    assert.equal(director.state, 'finished');
    assert.equal(director.acceptsInput, false);
    assert.ok(log.includes('finish'));
  });

  it('重复 finish 只生效一次（结算不会跑两遍）', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    director.finish();
    assert.equal(director.finish(), false, '第二次 finish 应返回 false');
    assert.equal(log.filter((x) => x === 'finish').length, 1);
  });

  it('已完赛时不能暂停（否则暂停层会压住结算面板）', () => {
    const { director } = makeDirector(1000, 3000);
    advance(director, 3100);
    director.finish();
    assert.equal(director.pause(), false);
    assert.equal(director.paused, false);
  });

  it('完赛时若正处于暂停，finish 会顺手解除暂停', () => {
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 3100);
    director.pause();
    director.finish();
    assert.equal(director.paused, false);
    assert.equal(log[log.length - 2] ?? log[log.length - 1], 'resume');
  });

  it('倒计时数字标签只包含 3/2/1，且索引越界时不播报', () => {
    assert.deepEqual([...COUNTDOWN_LABELS], ['3', '2', '1']);
    const { director, log } = makeDirector(1000, 3000);
    advance(director, 5000);
    // 第 4 个 step（elapsed >= 3000）应触发发车而不是播报一个空标签
    assert.ok(!log.includes('step:undefined'));
    assert.equal(log.filter((x) => x.startsWith('step:')).length, 3);
  });

  it('skipCountdown 式的立即发车只对倒计时期间有效', () => {
    const { director } = makeDirector(1000, 3000);
    assert.equal(director.state, 'countdown');
    director.beginRacing();
    assert.equal(director.state, 'racing');
    // 再叫一次不该有副作用（已在 racing）
    const before = director.state;
    director.beginRacing();
    assert.equal(director.state, before);
  });

  it('不注册任何副作用回调也能正确推进（状态机不依赖监听者）', () => {
    const bare = new RaceDirector({ countdownStepMs: 1000, countdownMs: 3000 });
    advance(bare, 3100);
    assert.equal(bare.state, 'racing');
    bare.finish();
    assert.equal(bare.state, 'finished');
  });
});

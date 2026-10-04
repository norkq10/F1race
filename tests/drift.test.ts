import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TUNING } from '../src/game/constants';
import { createDriveInput, type DriveInput } from '../src/game/DriveInput';
import { VehicleDynamics } from '../src/game/VehicleDynamics';

const V = TUNING.vehicle;
const D = V.drift;
const FRAME = 1 / 60;
/** 赛道元数据（public/assets/maps/track1.meta.json）里的地表参数。 */
const GRASS_FACTOR = 0.6;
const GRASS_RECOVER_SECONDS = 0.6;

function makeDynamics(): VehicleDynamics {
  return new VehicleDynamics({ grassFactor: GRASS_FACTOR, grassRecoverSeconds: GRASS_RECOVER_SECONDS });
}

/** 复用同一个输入对象，模拟"每帧采样键盘"的用法。 */
function drive(throttle: number, steer: number, drift = false, out = createDriveInput()): DriveInput {
  out.throttle = throttle;
  out.steer = steer;
  out.drift = drift;
  return out;
}

interface RunOptions {
  onTrack?: boolean;
  allowDrive?: boolean;
  /** 每帧 step 之后回调，用来做逐帧断言。 */
  onFrame?: () => void;
}

/** 以 60fps 推进 seconds 秒。 */
function run(dyn: VehicleDynamics, seconds: number, input: DriveInput, options: RunOptions = {}): void {
  const steps = Math.round(seconds / FRAME);
  const onTrack = options.onTrack ?? true;
  const allowDrive = options.allowDrive ?? true;
  for (let i = 0; i < steps; i++) {
    dyn.step(FRAME, input, onTrack, allowDrive);
    options.onFrame?.();
  }
}

/** 满油门直线加速到极速（约 7 秒收敛，这里留够余量）。 */
function topSpeedInput(dyn: VehicleDynamics): DriveInput {
  const input = drive(1, 0);
  run(dyn, 8, input);
  return input;
}

describe('M3 漂移 · 模块边界', () => {
  it('DriveInput 工厂不依赖 Phaser，drift 默认为 false', () => {
    const input = createDriveInput();
    assert.deepEqual(input, { throttle: 0, steer: 0, drift: false });
  });

  it('VehicleDynamics 不 import Phaser 的值（import type 会被类型剥离抹掉）', () => {
    // 单元测试本身能 import 到 VehicleDynamics 就是第一层证据（有 DOM 依赖会直接崩），
    // 这里再静态检查一遍，避免以后有人手滑加回 `import Phaser from 'phaser'`。
    const source = readFileSync(new URL('../src/game/VehicleDynamics.ts', import.meta.url), 'utf8');
    assert.equal(/import\s+Phaser\s+from\s+'phaser'/.test(source), false, '不得 import Phaser 的值');
    assert.equal(/from\s+'phaser'/.test(source), false, '纯逻辑模块不应出现任何 phaser 导入');
  });
});

describe('M3 漂移 · D1 不按 Space 时与 M1/M2 一致', () => {
  it('满转向跑 2 秒，横向速度始终接近 0，纵向收敛到极速', () => {
    const dyn = makeDynamics();
    const input = drive(1, 1, false);
    let maxLateral = 0;
    run(dyn, 2, input, {
      onFrame: () => {
        maxLateral = Math.max(maxLateral, Math.abs(dyn.lateral));
      },
    });
    assert.ok(maxLateral < 5, `不按漂移键时 |lateral| 必须 < 5px/s，实际峰值 ${maxLateral}`);
    assert.equal(dyn.lateral, 0, '没有漂移输入时横向速度应恒为 0');

    // 纵向：M1 的极速收敛点就是 TUNING.vehicle.maxSpeed
    const straight = makeDynamics();
    topSpeedInput(straight);
    assert.ok(
      Math.abs(straight.speed - V.maxSpeed) < 1,
      `满油门 8 秒应收敛到 ${V.maxSpeed}px/s，实际 ${straight.speed}`,
    );
    // 组成世界速度：lateral 为 0 时与 M1 的 cos/sin * speed 完全相同
    assert.ok(Math.abs(dyn.velocityX - Math.cos(dyn.heading) * dyn.speed) < 1e-12);
    assert.ok(Math.abs(dyn.velocityY - Math.sin(dyn.heading) * dyn.speed) < 1e-12);
  });

  it('倒计时（allowDrive=false）期间不产生漂移，也不接受油门与转向', () => {
    const dyn = makeDynamics();
    const input = drive(1, 1, true);
    run(dyn, 1, input, { allowDrive: false });
    assert.equal(dyn.speed, 0);
    assert.equal(dyn.heading, 0);
    assert.equal(dyn.lateral, 0);
    assert.equal(dyn.isDrifting, false);
  });
});

describe('M3 漂移 · D2 按住 Space + 打方向会明显侧滑', () => {
  it('极速下 0.6 秒内侧滑角超过 0.25 弧度', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    assert.ok(dyn.speed >= V.maxSpeed - 1, '前置条件：先加速到极速');

    input.steer = 1;
    input.drift = true;
    let elapsed = 0;
    let reachedAt = -1;
    run(dyn, 0.6, input, {
      onFrame: () => {
        elapsed += FRAME;
        if (reachedAt < 0 && dyn.driftAngle > 0.25) reachedAt = elapsed;
      },
    });
    assert.ok(reachedAt > 0, `0.6 秒内 driftAngle 必须 > 0.25，实际 ${dyn.driftAngle.toFixed(3)}`);
    assert.ok(dyn.driftAngle > 0.25, `0.6 秒末 driftAngle=${dyn.driftAngle.toFixed(3)}`);
    assert.equal(dyn.isDrifting, true);
  });

  it('380px/s 起漂同样成立，且左打方向同样能甩出去（driftAngle 恒非负）', () => {
    for (const steer of [1, -1]) {
      const dyn = makeDynamics();
      const input = drive(1, 0);
      run(dyn, 3, input); // 约 430px/s，满足"车速 ≥ 380"
      assert.ok(dyn.speed >= 380, `前置条件：车速 ${dyn.speed.toFixed(0)}px/s`);

      input.steer = steer;
      input.drift = true;
      let minAngle = Infinity;
      run(dyn, 0.6, input, {
        onFrame: () => {
          minAngle = Math.min(minAngle, dyn.driftAngle);
          assert.ok(dyn.driftAngle >= 0, 'driftAngle 恒为非负');
        },
      });
      assert.ok(dyn.driftAngle > 0.25, `steer=${steer} 时 driftAngle=${dyn.driftAngle.toFixed(3)}`);
      assert.equal(steer === 1 ? dyn.lateral > 0 : dyn.lateral < 0, true, 'steer=1 向右甩、steer=-1 向左甩');
      assert.ok(minAngle >= 0);
    }
  });
});

describe('M3 漂移 · D3 松开 Space 后 0.5～1.5 秒恢复抓地', () => {
  /** 从漂移状态松开，返回 isDrifting 变为 false 的耗时（秒）。 */
  function recoverySeconds(driftSeconds: number): number {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.steer = 1;
    input.drift = true;
    run(dyn, driftSeconds, input);
    assert.equal(dyn.isDrifting, true, `漂移 ${driftSeconds} 秒后应处于漂移状态`);

    input.drift = false; // 只松开漂移键，油门与转向保持
    let seconds = 0;
    let recovered = -1;
    run(dyn, 4, input, {
      onFrame: () => {
        seconds += FRAME;
        if (recovered < 0 && !dyn.isDrifting) recovered = seconds;
      },
    });
    assert.ok(recovered > 0, '松开后必须能恢复抓地');
    return recovered;
  }

  it('刚起漂就松开（0.6 秒）与漂到稳态（2 秒）都落在 [0.5, 1.5] 秒', () => {
    for (const driftSeconds of [0.6, 2]) {
      const seconds = recoverySeconds(driftSeconds);
      assert.ok(
        seconds >= 0.5 && seconds <= 1.5,
        `漂移 ${driftSeconds} 秒后松开，恢复耗时 ${seconds.toFixed(3)}s 应落在 [0.5, 1.5]`,
      );
    }
  });

  it('两种"恢复抓地"读法（跌破 driftAngleThreshold / 跌破 recoverAngleThreshold）都在窗口内', () => {
    // 文档 D3 的措辞是"恢复抓地"，常量注释把 recoverAngleThreshold 定义为"恢复抓地，
    // 而 isDrifting 的判据写的是 driftAngleThreshold。两者都测，避免踩到歧义。
    for (const driftSeconds of [0.6, 1, 2]) {
      const dyn = makeDynamics();
      const input = topSpeedInput(dyn);
      input.steer = 1;
      input.drift = true;
      run(dyn, driftSeconds, input);
      input.drift = false;

      let seconds = 0;
      let driftingOff = -1;
      let gripBack = -1;
      run(dyn, 4, input, {
        onFrame: () => {
          seconds += FRAME;
          if (driftingOff < 0 && !dyn.isDrifting) driftingOff = seconds;
          if (gripBack < 0 && dyn.driftAngle < D.recoverAngleThreshold) gripBack = seconds;
        },
      });
      for (const [label, value] of [
        ['isDrifting=false', driftingOff],
        ['driftAngle<recoverAngleThreshold', gripBack],
      ] as const) {
        assert.ok(
          value >= 0.5 && value <= 1.5,
          `漂移 ${driftSeconds}s 后松开，${label} 用时 ${value.toFixed(3)}s 应落在 [0.5, 1.5]`,
        );
      }
    }
  });

  it('恢复期结束后横向速度被强抓地力迅速吃掉（不会一直横着滑）', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.steer = 1;
    input.drift = true;
    run(dyn, 1, input);
    input.drift = false;
    run(dyn, 2, input); // 给足恢复时间
    assert.equal(dyn.isDrifting, false);
    assert.ok(Math.abs(dyn.lateral) < 5, `恢复后 |lateral|=${Math.abs(dyn.lateral).toFixed(3)} 应接近 0`);
  });

  it('isDrifting 就是"|speed| > 1 且 driftAngle > driftAngleThreshold"，没有隐藏迟滞', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.steer = 1;
    input.drift = true;
    const check = (): void => {
      const expected = Math.abs(dyn.speed) > 1 && dyn.driftAngle > D.driftAngleThreshold;
      assert.equal(dyn.isDrifting, expected, `driftAngle=${dyn.driftAngle} speed=${dyn.speed}`);
    };
    run(dyn, 1.5, input, { onFrame: check });
    input.drift = false;
    run(dyn, 2, input, { onFrame: check });
  });

  it('侧滑中把车刹停后不再是"漂移中"（避免 driftAngle 在 speed→0 时趋向 90°卡住状态）', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.steer = 1;
    input.drift = true;
    run(dyn, 1, input);
    assert.equal(dyn.isDrifting, true);

    const coast = drive(0, 0, false); // 松开漂移键 + 松油门滑行
    run(dyn, 3, coast);
    assert.equal(dyn.speed, 0, '应已滑行到停住');
    assert.equal(dyn.isDrifting, false, '停住的车不应被判成漂移中');
    // 停住后残余横向速度会被强抓地力清掉，不会一直横着滑
    run(dyn, 0.5, coast);
    assert.ok(Math.abs(dyn.lateral) < 5, `停稳后 |lateral|=${Math.abs(dyn.lateral).toFixed(3)}`);
  });
});

describe('M3 漂移 · D4 横向速度有硬上限', () => {
  it('极速 + 漂移 + 满转向狂甩 5 秒，|lateral| 任何一帧都不越界', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.steer = 1;
    input.drift = true;
    let peak = 0;
    run(dyn, 5, input, {
      onFrame: () => {
        peak = Math.max(peak, Math.abs(dyn.lateral));
        assert.ok(
          Math.abs(dyn.lateral) <= D.maxLateral + 1e-9,
          `|lateral|=${dyn.lateral} 超过上限 ${D.maxLateral}`,
        );
      },
    });
    assert.ok(peak > 100, `横向速度应真的甩起来，实际峰值 ${peak.toFixed(1)}`);
  });

  it('先往右甩再往左甩（横摆方向反转）也不越界', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    input.drift = true;
    input.steer = 1;
    run(dyn, 1.5, input, {
      onFrame: () => assert.ok(Math.abs(dyn.lateral) <= D.maxLateral + 1e-9),
    });
    input.steer = -1;
    run(dyn, 1.5, input, {
      onFrame: () => assert.ok(Math.abs(dyn.lateral) <= D.maxLateral + 1e-9),
    });
  });
});

describe('M3 漂移 · D5 合成速度不超过地表极速', () => {
  it('赛道上全油门漂移 6 秒，合速度始终不超过 maxSpeed', () => {
    const dyn = makeDynamics();
    const input = drive(1, 1, true);
    run(dyn, 6, input, {
      onFrame: () => {
        const composite = Math.hypot(dyn.speed, dyn.lateral);
        const cap = V.maxSpeed * dyn.surfaceFactor * 1.02;
        assert.ok(composite <= cap, `合速度 ${composite.toFixed(2)} 超过地表极速 ${cap.toFixed(2)}`);
      },
    });
  });

  it('草地上限同样成立（先等 surfaceFactor 与纵向速度收敛，再漂移）', () => {
    const dyn = makeDynamics();
    const input = drive(1, 0);
    run(dyn, 8, input); // 赛道极速
    const grass = drive(1, 0);
    run(dyn, 2, grass, { onTrack: false }); // 进草地：surfaceFactor 掉到 0.6，纵向收敛到 312
    assert.ok(Math.abs(dyn.surfaceFactor - GRASS_FACTOR) < 1e-6);
    assert.ok(Math.abs(dyn.speed - V.maxSpeed * GRASS_FACTOR) < 1);

    grass.steer = 1;
    grass.drift = true;
    run(dyn, 4, grass, {
      onTrack: false,
      onFrame: () => {
        const composite = Math.hypot(dyn.speed, dyn.lateral);
        const cap = V.maxSpeed * dyn.surfaceFactor * 1.02;
        assert.ok(composite <= cap, `草地上合速度 ${composite.toFixed(2)} 超过上限 ${cap.toFixed(2)}`);
      },
    });
  });
});

describe('M3 漂移 · D6 漂移不是白嫖', () => {
  it('同样 3 秒、同样转向输入，漂移后的纵向速度低于抓地', () => {
    const grip = makeDynamics();
    const drift = makeDynamics();
    const gripInput = topSpeedInput(grip);
    const driftInput = topSpeedInput(drift);

    gripInput.steer = 1;
    driftInput.steer = 1;
    driftInput.drift = true;
    run(grip, 3, gripInput);
    run(drift, 3, driftInput);

    assert.ok(
      drift.speed < grip.speed,
      `漂移 ${drift.speed.toFixed(1)}px/s 必须低于抓地 ${grip.speed.toFixed(1)}px/s`,
    );
    // 漂移稳态速度 = engineAccel / (dragK + driftSpeedScrub)，是"慢一点"而不是"慢到停"
    const expected = V.engineAccel / (V.dragK + D.driftSpeedScrub);
    assert.ok(
      Math.abs(drift.speed - expected) < 30,
      `漂移稳态速度 ${drift.speed.toFixed(1)}px/s 应接近设计值 ${expected.toFixed(1)}px/s`,
    );
  });
});

describe('M3 漂移 · D7 漂移让车头转得更快', () => {
  it('同样初始速度与 steer=1，漂移 1 秒的 heading 变化量更大', () => {
    const grip = makeDynamics();
    const drift = makeDynamics();
    const gripInput = topSpeedInput(grip);
    const driftInput = topSpeedInput(drift);
    assert.ok(Math.abs(grip.speed - drift.speed) < 0.5, '前置条件：两者初始速度一致');

    const gripStart = grip.heading;
    const driftStart = drift.heading;
    gripInput.steer = 1;
    driftInput.steer = 1;
    driftInput.drift = true;
    run(grip, 1, gripInput);
    run(drift, 1, driftInput);

    const gripTurn = Math.abs(grip.heading - gripStart);
    const driftTurn = Math.abs(drift.heading - driftStart);
    assert.ok(
      driftTurn > gripTurn,
      `漂移转向 ${driftTurn.toFixed(3)}rad 应大于抓地 ${gripTurn.toFixed(3)}rad`,
    );
  });
});

describe('M3 漂移 · D8 草地惩罚仍然生效', () => {
  it('草地稳态速度约为赛道的 0.6 倍', () => {
    const track = makeDynamics();
    topSpeedInput(track);

    const grass = makeDynamics();
    const input = drive(1, 0);
    run(grass, 4, input, { onTrack: false });

    assert.ok(Math.abs(track.speed - V.maxSpeed) < 1, `赛道极速 ${track.speed.toFixed(1)}`);
    assert.ok(
      Math.abs(grass.speed - V.maxSpeed * GRASS_FACTOR) < 1,
      `草地稳态 ${grass.speed.toFixed(1)} 应约等于 ${(V.maxSpeed * GRASS_FACTOR).toFixed(1)}`,
    );
    assert.ok(
      Math.abs(grass.speed / track.speed - GRASS_FACTOR) < 0.005,
      `草地/赛道速度比 ${(grass.speed / track.speed).toFixed(4)} 应约等于 ${GRASS_FACTOR}`,
    );
  });

  it('从极速冲进草地会明显掉速，回赛道后恢复', () => {
    const dyn = makeDynamics();
    const input = topSpeedInput(dyn);
    run(dyn, 1.5, input, { onTrack: false });
    assert.ok(dyn.speed < V.maxSpeed * 0.75, `进草地 1.5 秒后应掉到 ${(V.maxSpeed * 0.75).toFixed(0)} 以下`);
    run(dyn, 3, input);
    assert.ok(dyn.speed > V.maxSpeed * 0.99, '回赛道后应恢复到极速附近');
  });
});

describe('M3 漂移 · D9 倒车 / 刹车行为不变', () => {
  it('从静止全刹车倒车，极速为 maxSpeed * reverseRatio', () => {
    const dyn = makeDynamics();
    const input = drive(-1, 0);
    run(dyn, 8, input);
    const maxReverse = V.maxSpeed * V.reverseRatio;
    assert.ok(
      Math.abs(dyn.speed + maxReverse) < 1,
      `倒车极速 ${dyn.speed.toFixed(1)} 应约等于 -${maxReverse.toFixed(1)}`,
    );
  });

  it('刹车到 0 后不会继续往前冲，也不会越过倒车上限', () => {
    const dyn = makeDynamics();
    const input = drive(1, 0);
    run(dyn, 3, input); // 约 430px/s
    const speedBefore = dyn.speed;
    assert.ok(speedBefore > 400);

    const brake = drive(-1, 0);
    // 刹车减速度 1100px/s²，从 430 到 0 约 0.39 秒
    run(dyn, 0.2, brake);
    assert.ok(dyn.speed > 0 && dyn.speed < speedBefore, `刹车中 ${dyn.speed.toFixed(1)}`);
    run(dyn, 0.4, brake);
    assert.ok(dyn.speed <= 0, `刹车 0.6 秒后应已停住或开始倒车，实际 ${dyn.speed.toFixed(1)}`);
    run(dyn, 4, brake);
    assert.ok(dyn.speed >= -V.maxSpeed * V.reverseRatio - 1e-9);
  });

  it('按住漂移键倒车也不会改变倒车极速（横向推力按 speed 符号取反，纵向语义不变）', () => {
    const plain = makeDynamics();
    run(plain, 8, drive(-1, 0));

    const drifting = makeDynamics();
    run(drifting, 8, drive(-1, 0, true));
    assert.ok(
      Math.abs(drifting.speed - plain.speed) < 1e-9,
      '倒车时的漂移键不应影响纵向速度',
    );
    assert.ok(Math.abs(drifting.lateral) <= D.maxLateral);
  });

  it('碰撞冲击：减速 + 横向速度被墙面吃掉，lateral 为 0 时数值与 M1 完全一致', () => {
    const dyn = makeDynamics();
    topSpeedInput(dyn);
    const before = dyn.speed;
    dyn.applyImpact(0, -1); // 撞上侧墙，法线指回赛道
    assert.ok(
      Math.abs(dyn.speed - before * V.collisionSpeedKeep) < 1e-9,
      '不漂移时撞墙减速与 M1 相同（speed *= collisionSpeedKeep）',
    );
    assert.equal(dyn.lateral, 0, 'lateral 为 0 时撞墙不产生横向速度');

    // 漂移中撞墙：横向速度也要被吃掉
    const sliding = makeDynamics();
    const input = topSpeedInput(sliding);
    input.steer = 1;
    input.drift = true;
    run(sliding, 1, input);
    assert.ok(sliding.lateral > 50);
    const lateralBefore = sliding.lateral;
    // 车头沿 +x，右向为 +y；法线 -y 正对着横向速度 → 应被削减
    sliding.heading = 0;
    sliding.applyImpact(0, -1);
    assert.ok(sliding.lateral < lateralBefore, '朝墙的横向速度应被墙面吃掉');
  });
});

/**
 * 逐帧数值回归：把 M1/M2 的 `Vehicle.update` 纵向模型**原样抄一份**在这里，
 * 与不按 Space 的 VehicleDynamics 逐步对比。用严格相等（Object.is）比较，
 * 只有浮点运算顺序完全一致才能通过 —— 这是"不按漂移键时行为与现在完全一致"的最强证据。
 * （e2e 的对应断言：赛道极速、草地上限、撞墙停在 x≈79 都建立在这条路径上。）
 */
interface M1State {
  heading: number;
  speed: number;
  surfaceFactor: number;
}

function m1Step(
  state: M1State,
  dt: number,
  input: DriveInput,
  onTrack: boolean,
  allowDrive: boolean,
): void {
  const V = TUNING.vehicle;
  const targetFactor = onTrack ? 1 : GRASS_FACTOR;
  if (targetFactor < state.surfaceFactor) {
    state.surfaceFactor = Math.max(targetFactor, state.surfaceFactor - V.surfaceDropRate * dt);
  } else {
    const recoverRate = GRASS_RECOVER_SECONDS > 0 ? 1 / GRASS_RECOVER_SECONDS : 1;
    state.surfaceFactor = Math.min(targetFactor, state.surfaceFactor + recoverRate * dt);
  }

  const maxSpeed = V.maxSpeed * state.surfaceFactor;
  const maxReverse = V.maxSpeed * V.reverseRatio * state.surfaceFactor;
  const throttle = allowDrive ? input.throttle : 0;
  const steer = allowDrive ? input.steer : 0;

  if (throttle === 0) {
    const coast = V.coastDecel * dt;
    if (Math.abs(state.speed) <= coast) state.speed = 0;
    else state.speed -= Math.sign(state.speed) * coast;
  }
  state.speed -= state.speed * V.dragK * dt;

  if (throttle > 0) {
    if (state.speed < maxSpeed) {
      const accel = state.speed < 0 ? V.brakeDecel : V.engineAccel;
      state.speed = Math.min(maxSpeed, state.speed + accel * throttle * dt);
    }
  } else if (throttle < 0) {
    if (state.speed > 0) {
      state.speed = Math.max(0, state.speed + throttle * V.brakeDecel * dt);
    } else {
      state.speed = Math.max(-maxReverse, state.speed + throttle * V.engineAccel * V.reverseRatio * dt);
    }
  }

  if (state.speed > maxSpeed) {
    state.speed -= (state.speed - maxSpeed) * V.overspeedDecel * dt;
  }
  if (state.speed < -maxReverse) state.speed = -maxReverse;

  const absSpeed = Math.abs(state.speed);
  if (absSpeed > 1) {
    const authority = Math.min(1, absSpeed / V.steerSpeedRef);
    const highSpeedLoss = 1 - V.highSpeedSteerLoss * Math.min(1, absSpeed / V.maxSpeed);
    const direction = state.speed >= 0 ? 1 : -1;
    state.heading += steer * V.maxSteerRate * authority * highSpeedLoss * direction * dt;
  }
}

interface ScriptFrame {
  dt: number;
  throttle: number;
  steer: number;
  onTrack: boolean;
  allowDrive: boolean;
}

function assertMatchesM1(script: readonly ScriptFrame[]): void {
  const dyn = makeDynamics();
  const m1: M1State = { heading: 0, speed: 0, surfaceFactor: 1 };
  const input = createDriveInput();
  script.forEach((frame, index) => {
    input.throttle = frame.throttle;
    input.steer = frame.steer;
    input.drift = false; // 关键：不按 Space
    dyn.step(frame.dt, input, frame.onTrack, frame.allowDrive);
    m1Step(m1, frame.dt, input, frame.onTrack, frame.allowDrive);
    assert.equal(dyn.lateral, 0, `第 ${index} 帧 lateral 应为 0`);
    assert.equal(dyn.heading, m1.heading, `第 ${index} 帧 heading 与 M1 不一致`);
    assert.equal(dyn.speed, m1.speed, `第 ${index} 帧 speed 与 M1 不一致`);
    assert.equal(dyn.surfaceFactor, m1.surfaceFactor, `第 ${index} 帧 surfaceFactor 与 M1 不一致`);
  });
}

describe('M3 漂移 · 回归：不按 Space 时与 M1 逐帧数值一致', () => {
  it('固定 60fps 的混合输入（油门/滑行/刹车/倒车/左右打方向）600 帧', () => {
    const throttles = [1, 1, 0, -1, 1, 0];
    const steers = [0, 1, -1, 0.5, -0.5, 0.25];
    const script: ScriptFrame[] = [];
    for (let i = 0; i < 600; i++) {
      script.push({
        dt: FRAME,
        throttle: throttles[i % throttles.length],
        steer: steers[i % steers.length],
        onTrack: true,
        allowDrive: true,
      });
    }
    assertMatchesM1(script);
  });

  it('赛道 / 草地反复横跳（含高速冲进草地的超速回收）', () => {
    const script: ScriptFrame[] = [];
    for (let i = 0; i < 600; i++) {
      script.push({
        dt: FRAME,
        throttle: 1,
        steer: 0.7,
        onTrack: i % 240 < 120, // 每 2 秒切换一次地表
        allowDrive: true,
      });
    }
    assertMatchesM1(script);
  });

  it('倒计时期间 allowDrive=false，之后解锁', () => {
    const script: ScriptFrame[] = [];
    for (let i = 0; i < 300; i++) {
      script.push({ dt: FRAME, throttle: 1, steer: 1, onTrack: true, allowDrive: i >= 180 });
    }
    assertMatchesM1(script);
  });

  it('不规则 dt（30fps / 抖动帧长）下也一致', () => {
    const script: ScriptFrame[] = [];
    for (let i = 0; i < 300; i++) {
      script.push({
        dt: i % 5 === 0 ? 1 / 30 : FRAME + (i % 7) * 0.0004,
        throttle: i % 60 < 45 ? 1 : -1,
        steer: Math.sin(i / 9),
        onTrack: i % 100 < 70,
        allowDrive: true,
      });
    }
    assertMatchesM1(script);
  });
});


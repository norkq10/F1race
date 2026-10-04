import Phaser from 'phaser';
import type { DriveInput } from './DriveInput';

// DriveInput / createDriveInput 已搬到不依赖 Phaser 的 DriveInput.ts（M3）。
// 这里原样转发，保证既有 `from './InputController'` 的调用点（RaceScene / AutoPilot）不用改。
export type { DriveInput } from './DriveInput';
export { createDriveInput } from './DriveInput';

/**
 * 键盘输入（REQ-001）。
 * W/↑ 油门，S/↓ 刹车与倒车，A/← 与 D/→ 转向，Space 预留漂移，
 * G 车库（CR-15），R 重开，Esc / P 暂停。
 *
 * 注意：单次动作（重开 / 暂停 / 车库）不用 `Phaser.Input.Keyboard.JustDown`。
 * Phaser 的 `Key.onUp` 会清掉 `_justDown`，如果按下与抬起落在同一帧内
 * （快速点一下），`JustDown` 永远读不到。这里改用键盘插件的 keydown 事件做边沿闩锁。
 */
export class InputController {
  private readonly keys: Record<string, Phaser.Input.Keyboard.Key>;
  private pauseQueued = false;
  private restartQueued = false;
  private garageQueued = false;

  constructor(scene: Phaser.Scene) {
    const keyboard = scene.input.keyboard;
    if (!keyboard) throw new Error('[F1race] 键盘插件不可用');
    this.keys = keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE,R,ESC,P,G') as Record<
      string,
      Phaser.Input.Keyboard.Key
    >;
    // 阻止方向键/空格滚动页面
    keyboard.addCapture(['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE', 'R', 'ESC', 'P', 'G']);

    keyboard.on('keydown-ESC', (event: KeyboardEvent) => {
      if (!event.repeat) this.pauseQueued = true;
    });
    keyboard.on('keydown-P', (event: KeyboardEvent) => {
      if (!event.repeat) this.pauseQueued = true;
    });
    keyboard.on('keydown-R', (event: KeyboardEvent) => {
      if (!event.repeat) this.restartQueued = true;
    });
    keyboard.on('keydown-G', (event: KeyboardEvent) => {
      if (!event.repeat) this.garageQueued = true;
    });
  }

  private down(name: string): boolean {
    const key = this.keys[name];
    return key !== undefined && key.isDown;
  }

  /** 采样当前键盘状态写入 target（复用对象，避免每帧分配）。 */
  sampleInto(target: DriveInput): DriveInput {
    const up = this.down('W') || this.down('UP');
    const down = this.down('S') || this.down('DOWN');
    const left = this.down('A') || this.down('LEFT');
    const right = this.down('D') || this.down('RIGHT');
    target.throttle = (up ? 1 : 0) - (down ? 1 : 0);
    target.steer = (right ? 1 : 0) - (left ? 1 : 0);
    target.drift = this.down('SPACE');
    return target;
  }

  /** 取出并清空"重开"闩锁（边沿触发）。 */
  consumeRestartPressed(): boolean {
    const value = this.restartQueued;
    this.restartQueued = false;
    return value;
  }

  /** 取出并清空"暂停/继续"闩锁（边沿触发）。 */
  consumePausePressed(): boolean {
    const value = this.pauseQueued;
    this.pauseQueued = false;
    return value;
  }

  /**
   * 取出并清空"车库"闩锁（边沿触发，CR-15）。
   *
   * 与暂停共用同一套边沿闩锁：车库既要在比赛中能开（想换皮肤看一眼），
   * 也要在暂停 / 结算界面下能开。
   */
  consumeGaragePressed(): boolean {
    const value = this.garageQueued;
    this.garageQueued = false;
    return value;
  }

  /** 测试 / 演示用：直接注入输入。 */
  injectInto(target: DriveInput, throttle: number, steer: number, drift = false): void {
    target.throttle = throttle;
    target.steer = steer;
    target.drift = drift;
  }
}

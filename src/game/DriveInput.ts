/**
 * 一帧的驾驶输入（M3 从 InputController.ts 拆出来）。
 *
 * 拆分的理由：`VehicleDynamics` / 后续的 `AIDriver` 都是纯逻辑模块，
 * 只想要一个 `DriveInput` 类型。如果它们从 `InputController.ts` import，
 * 就会顺着那条 import 链把 Phaser 的**值**一起拉进来，
 * 单元测试（Node 原生类型剥离，没有 DOM）直接跑不起来。
 * 这里只有接口与工厂函数，不依赖任何引擎。
 */
export interface DriveInput {
  /** 1 = 油门，-1 = 刹车/倒车，0 = 松开。 */
  throttle: number;
  /** 1 = 右转，-1 = 左转。 */
  steer: number;
  /** Space 漂移键（M3 实装，M1/M2 只做预留）。 */
  drift: boolean;
}

export function createDriveInput(): DriveInput {
  return { throttle: 0, steer: 0, drift: false };
}

import { TUNING } from './constants';
import type { DriveInput } from './DriveInput';

/**
 * 恢复期的抓地力相对 `driftGripRate` 的倍率。
 *
 * 为什么不是直接用满 `driftGripRate`：D3 要求"松开 Space 后 0.5～1.5 秒恢复抓地"，
 * 而侧滑角是指数衰减的，用满 1.9/s 时 0.6 秒的漂移松手后 0.42 秒就跌破进入阈值了
 * （低于 0.5 秒下界）；再慢到 0.5 倍（0.95/s）时，长漂移（侧滑角约 0.43）要 1.38 秒
 * 才跌破恢复阈值，又顶到 1.5 秒上界。
 * 取 0.75 倍（1.425/s）后，无论是按"侧滑角 < driftAngleThreshold"还是按
 * "侧滑角 < recoverAngleThreshold"去量，恢复时间都稳稳落在 [0.5, 1.5] 秒内。
 * 这段横向模型属于文档里明确允许自行调参的部分（1.3「横向演化建议」）。
 */
const RECOVERY_GRIP_SCALE = 0.75;

/**
 * 车辆纵向 + 横向运动学（M3 漂移，REQ-004）。
 *
 * 纯逻辑模块：只 import `constants` 与 `DriveInput` 的**类型**，不引用任何 Phaser 的值，
 * 所以能直接在 Node 原生类型剥离下跑单元测试（tests/drift.test.ts）。
 *
 * 设计要点：
 *  - 纵向（速度/朝向）与 M1/M2 的 `Vehicle.update` 逐行等价，不按漂移键时物理行为完全不变（D1）；
 *  - 横向（lateral，车体右侧为正）只在「按住漂移键且在前进行驶」或
 *    「松开后仍在动且侧滑角大于恢复阈值」时演化，其余时间恒为 0，
 *    因此正常跑圈与 M1 的位移完全一致；
 *  - 没有任何隐藏状态：档位完全由 speed / lateral 决定，测试与调试都容易复现；
 *  - 位移仍交给 Arcade 物理推进，这里只产出速度分量。
 *
 * 坐标系：屏幕 y 向下，heading 顺时针为正，0 = +x 方向。
 * 车体右向单位向量 = (-sin(heading), cos(heading))。
 */
export class VehicleDynamics {
  /** 车头朝向（弧度，0 = +x，顺时针为正）。 */
  heading: number;
  /** 沿车头方向的纵向速度（px/s，负值 = 倒车）。 */
  speed = 0;
  /** 横向速度（px/s，车体右侧为正）。 */
  lateral = 0;
  /** 当前地表速度上限系数（1 = 赛道）。 */
  surfaceFactor = 1;
  /** 是否在赛道上。 */
  onTrack = true;

  /** 草地速度上限系数与恢复时间，来自赛道元数据。 */
  private readonly grassFactor: number;
  private readonly grassRecoverSeconds: number;

  constructor(options: { grassFactor: number; grassRecoverSeconds: number }) {
    this.grassFactor = options.grassFactor;
    this.grassRecoverSeconds = options.grassRecoverSeconds;
    this.heading = 0;
  }

  /**
   * 推进一帧。dt 单位为秒。
   * @param onTrack 当前是否在赛道上
   * @param allowDrive 是否接受驾驶输入（倒计时 / 暂停期间为 false）
   * @param draftFactor 尾流阻力倍率（≤ 1，1 = 没有尾流）。见 `CarContact.draftFactor`。
   */
  step(dt: number, input: DriveInput, onTrack: boolean, allowDrive: boolean, draftFactor = 1): void {
    const V = TUNING.vehicle;
    const D = V.drift;
    this.onTrack = onTrack;

    // --- 1. 地表速度上限系数平滑：进草地掉得快，回赛道逐渐恢复
    const targetFactor = onTrack ? 1 : this.grassFactor;
    if (targetFactor < this.surfaceFactor) {
      this.surfaceFactor = Math.max(targetFactor, this.surfaceFactor - V.surfaceDropRate * dt);
    } else {
      const recoverRate = this.grassRecoverSeconds > 0 ? 1 / this.grassRecoverSeconds : 1;
      this.surfaceFactor = Math.min(targetFactor, this.surfaceFactor + recoverRate * dt);
    }

    const maxSpeed = V.maxSpeed * this.surfaceFactor;
    const maxReverse = V.maxSpeed * V.reverseRatio * this.surfaceFactor;
    const throttle = allowDrive ? input.throttle : 0;
    const steer = allowDrive ? input.steer : 0;
    // 倒计时 / 暂停时按"没按漂移键"处理，避免起步前就甩尾。
    // 另外漂移只对"往前进"有意义：倒车（或刹车到 0）时按住 Space 不应改变 M1/M2 的纵向语义（D9），
    // 所以这里要求 speed > 0；横向推力里的 sign(speed) 因此恒为 +1。
    const drifting = allowDrive && input.drift && this.speed > 0;

    // --- 2. 自然减速 + 空气阻力
    // 先算阻力、再由油门补齐，极速才会稳定收敛到 maxSpeed 而不是越飘越高。
    if (throttle === 0) {
      const coast = V.coastDecel * dt;
      if (Math.abs(this.speed) <= coast) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * coast;
    }
    this.speed -= this.speed * V.dragK * dt;

    // --- 3. 油门 / 刹车 / 倒车。当前地表上限是硬上限，顶到上限后油门不再起作用。
    //         尾流只影响**发动机输出**（空气阻力变小），不改极速上限 ——
    //         改上限会让跟车的人凭空突破车辆性能，那是作弊而不是尾流。
    if (throttle > 0) {
      if (this.speed < maxSpeed) {
        const accel = this.speed < 0 ? V.brakeDecel : V.engineAccel;
        this.speed = Math.min(maxSpeed, this.speed + accel * throttle * draftFactor * dt);
      }
    } else if (throttle < 0) {
      if (this.speed > 0) {
        this.speed = Math.max(0, this.speed + throttle * V.brakeDecel * dt);
      } else {
        this.speed = Math.max(-maxReverse, this.speed + throttle * V.engineAccel * V.reverseRatio * dt);
      }
    }

    // --- 4. 已经超过当前地表上限时（例如高速冲进草地）快速往回收，
    //        这是"草地明显减速"的关键；离开草地后由 surfaceFactor 平滑恢复。
    if (this.speed > maxSpeed) {
      this.speed -= (this.speed - maxSpeed) * V.overspeedDecel * dt;
    }
    if (this.speed < -maxReverse) this.speed = -maxReverse;

    // --- 5. 漂移时的额外纵向阻力：漂移不是白嫖（D6），
    //        它让漂移稳态速度收敛到大约 370px/s（= engineAccel / (dragK + driftSpeedScrub)）。
    if (drifting) this.speed -= this.speed * D.driftSpeedScrub * dt;

    // --- 6. 转向：速度越低转向越弱，高速时转向能力下降；漂移时车头甩得更快（D7）。
    const absSpeed = Math.abs(this.speed);
    if (absSpeed > 1) {
      const authority = Math.min(1, absSpeed / V.steerSpeedRef);
      const highSpeedLoss = 1 - V.highSpeedSteerLoss * Math.min(1, absSpeed / V.maxSpeed);
      const direction = this.speed >= 0 ? 1 : -1;
      const steerBoost = drifting ? D.driftSteerBoost : 1;
      this.heading += steer * V.maxSteerRate * authority * highSpeedLoss * direction * steerBoost * dt;
    }

    // --- 7. 横向维度（漂移）演化
    this.updateLateral(dt, steer, drifting, maxSpeed);
  }

  /**
   * 横向速度演化。三种档位完全由当前状态决定，没有额外闩锁：
   *  - 漂移中（按住 Space 且在前进行驶）：抓地力低 + 横向推力，侧滑角迅速涨起来（D2）；
   *  - 侧滑恢复期（松开 Space 但侧滑角仍大于 recoverAngleThreshold）：半抓地，慢慢把横向速度吃掉（D3）；
   *  - 正常抓地：横向速度按 gripRate 快速归零。不按漂移键时 lateral 恒为 0，与 M1 一致（D1）。
   */
  private updateLateral(dt: number, steer: number, drifting: boolean, maxSpeed: number): void {
    const V = TUNING.vehicle;
    const D = V.drift;

    if (drifting) {
      // 横向推力：方向跟着转向输入与前进方向走，大小按速度缩放，
      // 并在 75% 极速处饱和 —— 再快轮胎也给不出更大的侧向力，
      // 这样"低速几乎甩不动、高速一打方向就出去"的手感才对。
      const speedRatio = Math.min(1, Math.abs(this.speed) / (V.maxSpeed * 0.75));
      const push = steer * D.driftLateralPush * speedRatio * Math.sign(this.speed) * dt;
      this.lateral -= this.lateral * D.driftGripRate * dt;
      this.lateral += push;
    } else if (Math.abs(this.speed) > 1 && this.driftAngle > D.recoverAngleThreshold) {
      // 恢复期：轮胎还在打滑，只按半抓地力衰减。
      // 用满 gripRate（16/s）的话 0.1 秒就归零，D3 的 0.5 秒下界无从谈起。
      // 前置 |speed| > 1 与 isDrifting 的判定同源：车停住就不该再横滑，
      // 直接回到强抓地档把残余横向速度清掉。
      this.lateral -= this.lateral * D.driftGripRate * RECOVERY_GRIP_SCALE * dt;
    } else {
      this.lateral -= this.lateral * D.gripRate * dt;
    }

    // --- 横向硬上限（D4）
    if (this.lateral > D.maxLateral) this.lateral = D.maxLateral;
    else if (this.lateral < -D.maxLateral) this.lateral = -D.maxLateral;

    // --- 合成速度不超过地表极速（D5）：横向占掉多少额度，纵向就少多少。
    // 只在 lateral 不为 0 时介入，避免干扰 M1/M2「高速冲进草地时纵向靠 overspeedDecel 回收」的既有手感
    // （那时 lateral 恒为 0，这段代码根本不会执行）。
    // 副作用：横向额度被吃光时车在草地上甩不动 —— 草地没有抓地力，符合直觉。
    if (this.lateral !== 0) {
      const budgetSq = maxSpeed * maxSpeed - this.speed * this.speed;
      const lateralCap = budgetSq > 0 ? Math.min(D.maxLateral, Math.sqrt(budgetSq)) : 0;
      if (this.lateral > lateralCap) this.lateral = lateralCap;
      else if (this.lateral < -lateralCap) this.lateral = -lateralCap;
    }
  }

  /** 碰撞冲击：减速 + 沿法线弹开（横向也要受影响）。 */
  applyImpact(normalX: number, normalY: number, speedKeep = TUNING.vehicle.collisionSpeedKeep): void {
    this.speed *= speedKeep;

    // 法线在车体右向上的投影与该侧横向速度反向时，说明横向速度正往墙里钻，
    // 按同样的比例吃掉它；lateral 为 0（不漂移）时这一步没有任何影响，
    // 所以 M1/M2 的撞墙回归（弹开 + 贴墙约束）逐位不变。
    const rightX = -Math.sin(this.heading);
    const rightY = Math.cos(this.heading);
    const intoLateral = rightX * normalX + rightY * normalY;
    if (intoLateral * this.lateral < 0) this.lateral *= speedKeep;
  }

  /** 世界速度分量（已合成纵向与横向）。 */
  get velocityX(): number {
    return Math.cos(this.heading) * this.speed - Math.sin(this.heading) * this.lateral;
  }

  get velocityY(): number {
    return Math.sin(this.heading) * this.speed + Math.cos(this.heading) * this.lateral;
  }

  /**
   * 侧滑角（弧度，atan2(lateral, |speed|)），恒为非负。
   * 取绝对值是为了让左右漂移对称：方向盘往哪打都得到同样大小的侧滑角。
   */
  get driftAngle(): number {
    return Math.atan2(Math.abs(this.lateral), Math.abs(this.speed));
  }

  /**
   * 是否处于"漂移中"：侧滑角 > `driftAngleThreshold`。
   *
   * 额外要求车还在动（|speed| > 1px/s）：`driftAngle` 按冻结定义是
   * `atan2(|lateral|, |speed|)`，车停住时它会趋向 90°，于是"停着不动"也会被判成漂移中。
   * 加上这一条，撞停 / 刹停 / 被顶停之后漂移状态会立刻解除，不会卡在仪表盘上。
   */
  get isDrifting(): boolean {
    return Math.abs(this.speed) > 1 && this.driftAngle > TUNING.vehicle.drift.driftAngleThreshold;
  }

  get speedKmh(): number {
    return Math.abs(this.speed) * TUNING.vehicle.speedToKmh;
  }

  /** 重置到指定状态（瞬移 / 重开用）。 */
  reset(heading: number, speed = 0, lateral = 0): void {
    this.heading = heading;
    this.speed = speed;
    this.lateral = lateral;
    this.surfaceFactor = 1;
  }
}

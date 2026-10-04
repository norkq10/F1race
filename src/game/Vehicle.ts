import Phaser from 'phaser';
import { TUNING } from './constants';
import { createDriveInput, type DriveInput } from './DriveInput';
import { VehicleDynamics } from './VehicleDynamics';

/**
 * 车辆（M3 起改为薄封装）。
 *
 * 它只负责 Phaser 相关的事情：sprite / 圆形 Arcade body / 撞墙与车车碰撞响应 / 弹开速度合成。
 * 纵向与横向运动学全部委托给 `VehicleDynamics`——那是纯逻辑，能在单元测试里跑。
 *
 * 公开 API 保持 M1/M2 原样（heading / speed / surfaceFactor / onTrack 等），
 * 只是改成转发到 dynamics 的读写器，所以 RaceScene / AutoPilot / Hud 的调用点不用改。
 */
export class Vehicle {
  readonly sprite: Phaser.Physics.Arcade.Sprite;
  readonly body: Phaser.Physics.Arcade.Body;
  readonly input: DriveInput = createDriveInput();
  readonly isPlayer: boolean;
  /** 纯逻辑运动学状态（M3：漂移相关的一切都在这里，可直接读）。 */
  readonly dynamics: VehicleDynamics;

  private knockX = 0;
  private knockY = 0;
  private knockTime = 0;
  private contactCooldown = 0;
  private wasBlocked = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    heading: number,
    textureKey: string,
    options: { isPlayer: boolean; grassFactor: number; grassRecoverSeconds: number },
  ) {
    this.isPlayer = options.isPlayer;
    this.dynamics = new VehicleDynamics({
      grassFactor: options.grassFactor,
      grassRecoverSeconds: options.grassRecoverSeconds,
    });
    this.dynamics.heading = heading;

    this.sprite = scene.physics.add.sprite(x, y, textureKey);
    this.sprite.setDepth(10);
    this.sprite.setRotation(heading + Math.PI / 2); // 贴图车头朝上，转到 heading 方向

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    const radius = TUNING.vehicle.bodyRadius;
    body.setCircle(radius, this.sprite.width / 2 - radius, this.sprite.height / 2 - radius);
    body.setBounce(0, 0);
    body.setDrag(0, 0);
    body.setMaxVelocity(3000, 3000);
    body.setCollideWorldBounds(false);
    this.body = body;

    this.sprite.setData('vehicle', this);
  }

  get x(): number {
    return this.sprite.x;
  }

  get y(): number {
    return this.sprite.y;
  }

  /** 车头朝向（弧度，0 = +x，顺时针为正）。 */
  get heading(): number {
    return this.dynamics.heading;
  }

  set heading(value: number) {
    this.dynamics.heading = value;
  }

  /** 沿车头方向的速度（px/s，负值 = 倒车）。 */
  get speed(): number {
    return this.dynamics.speed;
  }

  set speed(value: number) {
    this.dynamics.speed = value;
  }

  /** 横向速度（px/s，车体右侧为正，M3 新增）。 */
  get lateral(): number {
    return this.dynamics.lateral;
  }

  set lateral(value: number) {
    this.dynamics.lateral = value;
  }

  /** 当前地表速度上限系数（1 = 赛道，草地目标值约 0.6）。 */
  get surfaceFactor(): number {
    return this.dynamics.surfaceFactor;
  }

  set surfaceFactor(value: number) {
    this.dynamics.surfaceFactor = value;
  }

  /** 是否在赛道上。 */
  get onTrack(): boolean {
    return this.dynamics.onTrack;
  }

  set onTrack(value: boolean) {
    this.dynamics.onTrack = value;
  }

  /** 侧滑角（弧度，非负）。 */
  get driftAngle(): number {
    return this.dynamics.driftAngle;
  }

  /** 是否处于漂移中（迟滞判定，见 VehicleDynamics）。 */
  get isDrifting(): boolean {
    return this.dynamics.isDrifting;
  }

  /** 显示用速度（km/h）。 */
  get speedKmh(): number {
    return this.dynamics.speedKmh;
  }

  /**
   * 本帧是否撞到了墙或其他车。
   * AI 的脱困逻辑（AIDriver）靠它立刻察觉撞击；只靠低速判定会晚约 900ms。
   */
  get blocked(): boolean {
    return !this.body.blocked.none;
  }

  /** 被撞/撞墙时的减速与弹开（REQ-014）。 */
  applyImpact(normalX: number, normalY: number, speedKeep = TUNING.vehicle.collisionSpeedKeep): void {
    this.dynamics.applyImpact(normalX, normalY, speedKeep);
    this.knockX = normalX * TUNING.vehicle.knockSpeed;
    this.knockY = normalY * TUNING.vehicle.knockSpeed;
    this.knockTime = TUNING.vehicle.knockSeconds;
    this.contactCooldown = TUNING.vehicle.contactCooldown;
  }

  /** 瞬移到指定位置（重开 / 测试用）。 */
  placeAt(x: number, y: number, heading: number, speed = 0, lateral = 0): void {
    this.sprite.setPosition(x, y);
    this.body.reset(x, y);
    this.dynamics.reset(heading, speed, lateral);
    this.knockTime = 0;
    this.contactCooldown = 0;
    this.wasBlocked = false;
    this.sprite.setRotation(heading + Math.PI / 2);
  }

  /**
   * 推进一帧。
   * @param dt 秒
   * @param onTrack 当前是否在赛道上
   * @param allowDrive 是否接受驾驶输入（倒计时期间为 false）
   * @param draftFactor 尾流阻力倍率（≤ 1，1 = 没有尾流；由集成层按"前方是否有车"算）
   */
  update(dt: number, onTrack: boolean, allowDrive: boolean, draftFactor = 1): void {
    // --- 1~5. 运动学全部交给纯逻辑模块
    this.dynamics.step(dt, this.input, onTrack, allowDrive, draftFactor);

    // --- 6. 碰撞响应
    this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    this.handleContacts(dt);

    // --- 7. 交给 Arcade 推进位移（纵向 + 横向合成，再叠加撞墙弹开速度）
    let vx = this.dynamics.velocityX;
    let vy = this.dynamics.velocityY;
    if (this.knockTime > 0) {
      this.knockTime = Math.max(0, this.knockTime - dt);
      const k = this.knockTime / TUNING.vehicle.knockSeconds;
      vx += this.knockX * k;
      vy += this.knockY * k;
    }
    this.body.setVelocity(vx, vy);
    this.sprite.setRotation(this.heading + Math.PI / 2);
  }

  /** 墙壁接触处理：首次接触减速弹开，持续接触按墙面约束吃掉法向速度。 */
  private handleContacts(dt: number): void {
    const V = TUNING.vehicle;
    const blocked = this.body.blocked;
    let nx = 0;
    let ny = 0;
    if (blocked.left) nx += 1;
    if (blocked.right) nx -= 1;
    if (blocked.up) ny += 1;
    if (blocked.down) ny -= 1;

    if (nx === 0 && ny === 0) {
      this.wasBlocked = false;
      return;
    }

    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;

    // 首次接触：减速 + 轻微弹开（REQ-014）
    if (!this.wasBlocked && this.contactCooldown <= 0) {
      this.applyImpact(nx, ny);
    }
    this.wasBlocked = true;

    // 墙面约束：只保留沿墙滑动的速度分量。
    // 少了这一步，"模型速度"会在顶住墙时一直被油门推高，出现贴墙引擎空转、时速表虚高。
    const sign = this.dynamics.speed >= 0 ? 1 : -1;
    const dirX = Math.cos(this.heading) * sign;
    const dirY = Math.sin(this.heading) * sign;
    const into = -(dirX * nx + dirY * ny); // > 0 表示正在往墙里推
    if (into > 0) {
      this.dynamics.speed *= Math.sqrt(Math.max(0, 1 - into * into));
      this.dynamics.speed -= this.dynamics.speed * Math.min(1, V.collisionScrub * dt);
    }
  }

  /** 幽灵车模式：不参与物理碰撞，半透明。 */
  makeGhost(): void {
    this.sprite.setAlpha(0.45);
    this.sprite.setDepth(9);
    this.body.enable = false;
  }
}

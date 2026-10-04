import Phaser from 'phaser';
import { TUNING } from './constants';
import type { DriveInput } from './InputController';
import type { Track } from './Track';
import type { Vehicle } from './Vehicle';

/** AutoPilot 可调参数。 */
export interface AutoPilotOptions {
  lookAheadBase?: number;
  lookAheadPerSpeed?: number;
  steerGain?: number;
  corneringGrip?: number;
  speedCapRatio?: number;
}

/**
 * 纯追踪（pure pursuit）自动驾驶。
 *
 * M1 里它有两个用途：
 *  1. 自动化验收——让"车能不能跑完 3 圈"变成可重复的自动测试，而不是靠人肉试玩；
 *  2. M5 的 AI 对手会复用这套前视点 + 曲率限速逻辑，再叠加难度参数与脱困行为。
 */
export class AutoPilot {
  /** 前视距离基准（像素）。 */
  lookAheadBase: number;
  /** 前视距离随速度增长的比例。 */
  lookAheadPerSpeed: number;
  /** 转向增益。 */
  steerGain: number;
  /** 过弯允许的横向加速度，越小越保守。 */
  corneringGrip: number;
  /** 目标速度上限（相对车辆极速的比例）。 */
  speedCapRatio: number;

  constructor(options: AutoPilotOptions = {}) {
    this.lookAheadBase = options.lookAheadBase ?? 110;
    this.lookAheadPerSpeed = options.lookAheadPerSpeed ?? 0.45;
    this.steerGain = options.steerGain ?? 2.6;
    this.corneringGrip = options.corneringGrip ?? 1250;
    this.speedCapRatio = options.speedCapRatio ?? 0.9;
  }

  /** 计算一帧的驾驶输入写入 out。 */
  drive(vehicle: Vehicle, track: Track, out: DriveInput): void {
    const progress = track.progressAt(vehicle.x, vehicle.y);
    const speed = Math.abs(vehicle.speed);

    // --- 转向：对准前方中心线上的前视点
    const lookAhead = this.lookAheadBase + speed * this.lookAheadPerSpeed;
    const target = track.pointAtArc(progress.arc + lookAhead);
    const desired = Math.atan2(target.y - vehicle.y, target.x - vehicle.x);
    const headingError = Phaser.Math.Angle.Wrap(desired - vehicle.heading);
    // progress.signedLateral > 0 表示车在前进方向右侧，需要向左修正
    const lateralCorrection = Phaser.Math.Clamp(-progress.signedLateral * 0.0045, -0.35, 0.35);
    out.steer = Phaser.Math.Clamp(headingError * this.steerGain + lateralCorrection, -1, 1);

    // --- 限速：用前方一段路的曲率估算可安全通过的速度
    const look = 70 + speed * 0.9;
    const tangentA = track.tangentAtArc(progress.arc + look * 0.4);
    const tangentB = track.tangentAtArc(progress.arc + look);
    const turn = Math.abs(Phaser.Math.Angle.Wrap(tangentB - tangentA));
    const curvature = turn / (look * 0.6);

    let targetSpeed = TUNING.vehicle.maxSpeed * this.speedCapRatio;
    if (curvature > 1e-5) {
      targetSpeed = Math.min(targetSpeed, Math.sqrt(this.corneringGrip / curvature));
    }
    // 偏离赛道中心太多时先收油，给自己留出修正空间
    targetSpeed -= Math.min(120, progress.lateralDistance * 1.2);
    targetSpeed = Phaser.Math.Clamp(targetSpeed, 150, TUNING.vehicle.maxSpeed);

    if (speed < targetSpeed * 0.97) out.throttle = 1;
    else if (speed > targetSpeed * 1.06) out.throttle = -0.55;
    else out.throttle = 0;

    out.drift = false;
  }
}

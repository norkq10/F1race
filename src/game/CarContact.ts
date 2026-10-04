/**
 * CarContact.ts
 * 车与车碰撞的响应计算（纯逻辑，**不 import Phaser**，可直接单元测试）。
 *
 * 从 `RaceScene.onVehicleCollision()` 抽出来。原来的做法是"两边各
 * `applyImpact(法线)`"—— 那只是"减速 + 反向弹开"，结果是**两车一碰就互相弹飞**，
 * 根本没法并排跑（CR-06 第 3 项要解决的就是这个）。
 *
 * 现在的模型分两层，正是真实赛车接触的两个环节：
 *
 *  1. **法向分离（硬约束）**：两车不能重叠。把重叠量摊到两车的纵向上，
 *     让靠前的那台被推着走、靠后的那台被顶慢。这一层负责"贴着跑而不穿模"。
 *  2. **切向摩擦（能量传递）**：并排时速度差主要在**切向**上，
 *     它不会让两车分开，只会互相拖拽。按 `friction` 比例把速度差传递过去，
 *     再叠一点 `bounce` 让撞击有"被撞了一下"的手感。
 *
 * 刻意不做的事：不改朝向、不改横向速度。转向与横向是车手自己的控制量，
 * 被撞一下就自己拐弯会很晕；横向的"被挤开"效果由法向分离自然产生。
 */

/**
 * 把角度归一化到 (-π, π]。
 *
 * 放在这里而不是让调用方自己写：航向差必须归一化之后才能比较，
 * 否则"从 359° 到 1°"会被算成 358° 而不是 2° —— 尾流判定会漏掉
 * 几乎所有真实的跟车情况，而且不会报错，只会"尾流好像没生效"。
 */
export function wrapAnglePi(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) wrapped -= twoPi;
  else if (wrapped <= -Math.PI) wrapped += twoPi;
  return wrapped;
}

/** 参与接触的一台车（`Vehicle` 天然满足）。 */
export interface ContactBody {
  /** 纵向速度（沿车头方向，px/s，负 = 倒车）。 */
  speed: number;
  /** 车头朝向（弧度）。 */
  heading: number;
}

export interface ContactOptions {
  /**
   * 切向摩擦系数（0..1）：把两车速度差的多大比例传递过去。
   *
   * 0 = 完全弹性（像台球），1 = 完全非弹性（撞完速度相同）。
   * 0.35 是"能并排推挤、但撞击仍有明显失速"的中间值。
   */
  friction: number;
  /**
   * 弹性回弹系数（0..1）：沿法线的额外弹开速度占比。
   *
   * 不能太大 —— 大了就是原来那个"互相弹飞"。0.18 大约等于
   * "撞一下会分开，但不会飞出去"。
   */
  bounce: number;
  /**
   * 单次接触最多吃掉多少纵向速度（px/s）。
   *
   * 上限的作用：并排贴着跑时两车会**每帧**接触，没有上限的话
   * 切向摩擦会逐帧累积，几帧之内就把速度吸干，表现为"一贴上去就双双停车"。
   */
  maxSpeedTransfer: number;
}

export const DEFAULT_CONTACT: ContactOptions = {
  friction: 0.35,
  bounce: 0.18,
  maxSpeedTransfer: 90,
};

export interface ContactImpulse {
  /** A 车纵向速度该增加多少。 */
  aSpeedDelta: number;
  /** B 车纵向速度该增加多少。 */
  bSpeedDelta: number;
  /**
   * 法线（由 A 指向 B，单位向量）。
   *
   * 调用方还需要它来做"位置分离"（把重叠的两车推开），
   * 所以一并返回，免得再算一遍。
   */
  nx: number;
  ny: number;
  /** 两车中心距离（像素）。 */
  distance: number;
  /** 重叠深度（像素），≤ 0 表示没重叠。 */
  overlap: number;
}

/**
 * 计算一次车车接触的速度冲量。
 *
 * @param ax A 车中心 x
 * @param ay A 车中心 y
 * @param bx B 车中心 x
 * @param by B 车中心 y
 * @param bodyA A 车车体（需要 speed / heading）
 * @param bodyB B 车车体
 * @param bodyRadius 车身半径（像素），两车都用同一个值
 * @param options 摩擦 / 回弹参数
 */
export function computeCarContact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  bodyA: ContactBody,
  bodyB: ContactBody,
  bodyRadius: number,
  options: ContactOptions = DEFAULT_CONTACT,
): ContactImpulse {
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.hypot(dx, dy);
  // 圆心完全重合时法线没有定义：用一个确定的默认方向（+x），
  // 保证同一帧多次调用结果一致，不会让 HUD / 排名随调用顺序抖动。
  const nx = distance > 1e-6 ? dx / distance : 1;
  const ny = distance > 1e-6 ? dy / distance : 0;
  const overlap = bodyRadius * 2 - distance;

  // --- 各自沿法线的速度分量（把纵向速度投影到法线上）
  const aAlong = Math.cos(bodyA.heading) * nx + Math.sin(bodyA.heading) * ny;
  const bAlong = Math.cos(bodyB.heading) * nx + Math.sin(bodyB.heading) * ny;
  const aNormalSpeed = bodyA.speed * aAlong;
  const bNormalSpeed = bodyB.speed * bAlong;

  // --- 1. 切向摩擦：把两车在法线方向上的速度差往中间拉
  const relative = bNormalSpeed - aNormalSpeed;
  const transfer = relative * options.friction * 0.5;

  let aSpeedDelta = transfer * aAlong;
  let bSpeedDelta = -transfer * bAlong;

  // --- 2. 弹性回弹：只有当两车**正在靠近**时才给弹开速度。
  //     正在分开时再加回弹会让它们越弹越远（经典的"撞完飞出去"）。
  const closing = aNormalSpeed - bNormalSpeed;
  if (closing > 0) {
    const bounceDelta = closing * options.bounce;
    aSpeedDelta -= bounceDelta * aAlong;
    bSpeedDelta += bounceDelta * bAlong;
  }

  // --- 3. 上限：摩擦与回弹**叠加之后**再钳一次。
  //     只在摩擦那一层钳是不够的 —— 回弹是在钳完之后加上的，
  //     高速追尾时可以轻松把总冲量顶到 maxSpeedTransfer 的好几倍
  //     （实测 600px/s 相对速度下会到 -630，本该 ≤ 90）。
  aSpeedDelta = clampMagnitude(aSpeedDelta, options.maxSpeedTransfer);
  bSpeedDelta = clampMagnitude(bSpeedDelta, options.maxSpeedTransfer);

  return { aSpeedDelta, bSpeedDelta, nx, ny, distance, overlap };
}

/** 保留符号地把绝对值钳到上限。 */
function clampMagnitude(value: number, limit: number): number {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return value;
}

/**
 * 把两车的位置沿法线分开，消除重叠。
 *
 * 各推一半 —— 只推一台的话，被推的那台会觉得自己"莫名其妙被传送了"，
 * 而且先推谁取决于遍历顺序，会让同一场景在不同帧率下结果不同。
 *
 * @returns 各车需要施加的位置偏移
 */
export function separatePositions(
  nx: number,
  ny: number,
  overlap: number,
): { aDx: number; aDy: number; bDx: number; bDy: number } {
  if (overlap <= 0) return { aDx: 0, aDy: 0, bDx: 0, bDy: 0 };
  const half = overlap / 2;
  return {
    aDx: -nx * half,
    aDy: -ny * half,
    bDx: nx * half,
    bDy: ny * half,
  };
}

/**
 * 尾流（draft）系数：跟车时空气阻力变小（CR-06 第 2 项）。
 *
 * 对**玩家和 AI 同时生效** —— 这是"物理规则"而不是"AI 特权"，
 * 所以不违反项目"AI 不作弊"的立场（见 README 的"不建议改"第 1 条）。
 *
 * @param gapPx 与前方车的距离（像素）
 * @param headingDiffRad 两车航向差（弧度，取绝对值后再传入）
 * @param config 生效距离 / 容差角 / 阻力系数
 * @returns 本帧的"额外阻力倍率"（≤ 1；1 = 没有尾流）。乘到发动机输出上即可。
 */
export function draftFactor(
  gapPx: number,
  headingDiffRad: number,
  config: { rangePx: number; maxHeadingRad: number; factor: number },
): number {
  if (!Number.isFinite(gapPx) || gapPx < 0) return 1;
  if (gapPx > config.rangePx) return 1;
  if (Math.abs(headingDiffRad) > config.maxHeadingRad) return 1;
  // 距离越近效果越强：贴着车尾拿满收益，到 rangePx 处线性归零。
  // 线性而不是阶跃，是为了避免"进/出尾流"时阻力突然跳变导致速度抖一下。
  const closeness = 1 - gapPx / config.rangePx;
  return 1 - (1 - config.factor) * closeness;
}

/**
 * 判断 `candidate` 是否在 `self` 正前方的尾流区里。
 *
 * 抽成独立函数是因为"正前方"的判定很容易写错方向：
 * 它同时要求**距离近**、**航向接近**、**确实在车头一侧**。
 * 只看距离的话，并排的车也会被算成尾流。
 */
export function isInDraftZone(
  self: { x: number; y: number; heading: number },
  candidate: { x: number; y: number; heading: number },
  config: { rangePx: number; maxHeadingRad: number; minForwardPx: number },
): boolean {
  const dx = candidate.x - self.x;
  const dy = candidate.y - self.y;
  const gap = Math.hypot(dx, dy);
  if (gap > config.rangePx || gap < 1e-6) return false;

  // 必须在前方：把位移投影到车头方向上，投影长度要为正且不能太短
  const forward = dx * Math.cos(self.heading) + dy * Math.sin(self.heading);
  if (forward < config.minForwardPx) return false;

  // 航向要接近（否则那是横向交错，不是跟车）
  return Math.abs(wrapAnglePi(candidate.heading - self.heading)) <= config.maxHeadingRad;
}

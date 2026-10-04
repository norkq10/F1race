import Phaser from 'phaser';
import { ASSETS } from './constants';
import { TrackGeometry } from './TrackGeometry';
import type { CenterlineSample, TrackMeta, TrackProgress } from './types';

/** 中心线取点结果由 types.ts 统一定义，供纯逻辑模块（AI / 幽灵车）共用。 */

/**
 * 赛道：瓦片地图 + 分层 + 中心线。
 *
 * - 地表（赛道/草地）由 track 层的瓦片决定，替换地图后自动生效；
 * - 圈数与名次用的进度由中心线弧长决定，比"压线检测"稳健得多；
 * - 中心线同时是 M5 AI 的路径点来源与 M4 幽灵车的参考线。
 *
 * **几何查询全部委托给 `TrackGeometry`**（纯逻辑、可单测）：本类只负责 Phaser 那一半
 * —— 瓦片图层、碰撞标志、以及把几何读数接上引擎。这么分是因为"弧长怎么算"
 * 出过好几次事（known-issues 第 8 / 10 条，以及"压草地被判切弯"），
 * 而它以前埋在场景里，没法写测试。
 */
export class Track {
  readonly meta: TrackMeta;
  readonly map: Phaser.Tilemaps.Tilemap;
  readonly groundLayer: Phaser.Tilemaps.TilemapLayer;
  readonly trackLayer: Phaser.Tilemaps.TilemapLayer;
  readonly decorLayer: Phaser.Tilemaps.TilemapLayer;
  readonly wallsLayer: Phaser.Tilemaps.TilemapLayer;

  readonly totalLength: number;
  /** 是否是单程赛道（点对点）。见 `TrackMeta.open`。 */
  readonly isOpen: boolean;
  /** 比赛圈数（单程赛道为 1）。由地图元数据决定，不是全局常量。 */
  readonly lapCount: number;

  /** 中心线几何（纯逻辑）。 */
  private readonly geometry: TrackGeometry;
  /** 赛道瓦片查表（索引 = 瓦片 gid），避免每帧 Array.includes。 */
  private readonly trackTileFlags: Uint8Array;

  constructor(scene: Phaser.Scene, mapKey: string, metaKey: string) {
    const meta = scene.cache.json.get(metaKey) as TrackMeta | undefined;
    if (!meta) throw new Error(`[F1race] 缺少赛道元数据：${metaKey}`);
    this.meta = meta;

    const map = scene.make.tilemap({ key: mapKey });
    const tileset = map.addTilesetImage('tiles', ASSETS.tilesetKey, meta.tileSize, meta.tileSize, 0, 0);
    if (!tileset) throw new Error('[F1race] 瓦片集加载失败：tiles');

    this.map = map;
    this.groundLayer = Track.requireLayer(map.createLayer(meta.layers.ground, tileset, 0, 0), meta.layers.ground);
    this.trackLayer = Track.requireLayer(map.createLayer(meta.layers.track, tileset, 0, 0), meta.layers.track);
    this.decorLayer = Track.requireLayer(map.createLayer(meta.layers.decor, tileset, 0, 0), meta.layers.decor);
    this.wallsLayer = Track.requireLayer(map.createLayer(meta.layers.walls, tileset, 0, 0), meta.layers.walls);

    this.groundLayer.setDepth(0);
    this.trackLayer.setDepth(1);
    this.decorLayer.setDepth(2);
    this.wallsLayer.setDepth(3);

    this.wallsLayer.setCollision(meta.tiles.wall);

    // tile.index 就是 Tiled 的 gid（空瓦片为 -1），直接用 gid 建查表
    let maxGid = 0;
    for (const v of Object.values(meta.tiles)) maxGid = Math.max(maxGid, v);
    this.trackTileFlags = new Uint8Array(maxGid + 1);
    for (const gid of meta.surface.trackGids) {
      if (gid >= 0 && gid < this.trackTileFlags.length) this.trackTileFlags[gid] = 1;
    }

    this.isOpen = meta.open === true;
    this.lapCount = Math.max(1, meta.laps);
    this.geometry = new TrackGeometry({ points: meta.centerline.points, open: this.isOpen });
    this.totalLength = this.geometry.totalLength;
  }

  private static requireLayer(layer: Phaser.Tilemaps.TilemapLayer | null, name: string): Phaser.Tilemaps.TilemapLayer {
    if (!layer) throw new Error(`[F1race] 地图缺少图层：${name}`);
    return layer;
  }

  /** 世界坐标是否在赛道上（草地 = false）。 */
  isOnTrack(worldX: number, worldY: number): boolean {
    const tile = this.trackLayer.getTileAtWorldXY(worldX, worldY);
    if (!tile) return false;
    return this.trackTileFlags[tile.index] === 1;
  }

  /** 重置进度搜索缓存。M5 起改用无状态全量扫描，这里保留为空实现以兼容既有调用点。 */
  resetProgressSearch(): void {
    /* 无状态查询，无需重置 */
  }

  /**
   * 查询世界坐标在赛道上的进度（**全局**最近点）。
   *
   * M5 起场上有 4～5 台车，每台车每帧都要查一次。这里**故意不做"记住上次搜索位置"的缓存**：
   * 缓存只有一个槽位，多台车轮流调用时会拿别人的位置当起点，局部搜索就会命中赛道上
   * 另一段距离更近的路线，返回完全错误的弧长（M5 集成时真踩过：所有圈被判无效、AI 进度恒为 0）。
   * 561 个采样点 × 5 台车 × 60fps 只有约 17 万次投影/秒，全量扫描的开销可以忽略。
   *
   * ⚠️ 语义是"你在图上离哪段路最近"，不是"你正在跑哪段路"。
   * **每帧推进计时请用 `arcNear()`**，否则发夹弯里冲出赛道会被算成进度跳跃。
   */
  progressAt(worldX: number, worldY: number): TrackProgress {
    return this.geometry.progressAt(worldX, worldY);
  }

  /**
   * **连续**进度查询：只看上一次弧长附近的一小段，且不允许瞬移式跳变。
   *
   * 这是"过弯冲出赛道压了草地却被判切弯、整圈作废"的修法 —— 见 `TrackGeometry.arcNear`
   * 的详细说明。场景每帧推进计时用它（并传入"这一帧物理上最多走多远"），
   * `progressAt` 留给"瞬移 / 摆位 / 排名"这些本来就要问"你在哪"的场合。
   *
   * @param maxTravelPx 这一帧车实际移动的距离（像素）。
   * @param fromX / fromY 上一帧的世界坐标（用来判断位移方向）。
   * @param trustProjection true = 跳过物理判据，直接采信窗口内投影（锚点卡住时的兜底）。
   */
  arcNear(
    worldX: number,
    worldY: number,
    prevArc: number,
    windowPx?: number,
    maxTravelPx?: number,
    fromX?: number,
    fromY?: number,
    trustProjection = false,
  ): TrackProgress {
    return this.geometry.arcNear(worldX, worldY, prevArc, windowPx, maxTravelPx, fromX, fromY, trustProjection);
  }

  /**
   * 把弧长归一化到本赛道的规范区间（闭环 `[0, total)`，单程 `[0, total]`）。
   *
   * 场景里除了计时器还有一份"这辆车在哪段弧长"（连续进度查询的窗口锚点），
   * 两份状态必须用同一套约定，所以归一化也由几何层统一提供。
   */
  normalizeArc(arc: number): number {
    return this.geometry.normalizeArc(arc);
  }

  /**
   * 取弧长 arc 处的中心线位置与切线（用于 AI 前视点 / 幽灵车对照）。
   *
   * ⚠️ 闭环做 `% total`（绕回起点），**单程必须夹在 [0, total] 内** ——
   * 单程的终点不是起点，绕回来会取到赛道另一头的位置与切线。
   * AI 的前视点在最末尾会越过终点（`look` 有 70~200px），夹住才能让它继续朝前看，
   * 而不是"突然看向起点"然后打死方向。
   */
  pointAtArc(arc: number): CenterlineSample {
    return this.geometry.pointAtArc(arc);
  }

  /** 取弧长 arc 处的切线方向。 */
  tangentAtArc(arc: number): number {
    return this.geometry.tangentAtArc(arc);
  }

  get centerlinePoints(): readonly (readonly [number, number])[] {
    return this.geometry.centerlinePoints;
  }
}

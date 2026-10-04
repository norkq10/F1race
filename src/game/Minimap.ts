/**
 * Minimap.ts
 * 右上角固定小地图。
 *
 * 需求：
 *   - 放在画面右上角；
 *   - 玩家、每个 AI、以及幽灵车的实时位置都要显示；
 *   - **小地图本身不随镜头移动**。
 *
 * 为什么用一块独立的 2D canvas 而不是放进 Phaser 场景：
 *   1. "不移动"最稳的做法就是它根本不属于世界坐标系 —— 放进场景就得每帧
 *      反向抵消 camera 的 scroll，任何一次镜头补间/缩放抖动都会传染到它；
 *   2. 它是纯覆盖层 UI，尺寸固定、只需要几十个点，用 DOM canvas 的
 *      2D 上下文画起来比走一遍 Phaser 渲染管线简单得多，也不会被
 *      camera 的缩放/滤镜影响。
 *
 * 坐标换算：赛道元数据里已经有 `grid`（瓦片数）与 `centerline.points`（世界像素），
 * 所以在构造时算一次包围盒 + 缩放比例（**含等比缩放与居中留白**），
 * 之后每帧只做一次线性映射。
 */

/** 小地图上要画的一个光点。 */
export interface MinimapDot {
  x: number;
  y: number;
  /** 0xRRGGBB 颜色，与车身 tint 一致。 */
  color: number;
  /** 玩家额外画一圈白描边，方便一眼找到自己。 */
  isPlayer?: boolean;
  /** 幽灵车画成半透明空心圈，和实心的真车区分开。 */
  isGhost?: boolean;
  /** 是否已完赛（画成小方块，表示"已经跑完不再动"）。 */
  finished?: boolean;
}

export interface MinimapOptions {
  /** CSS 尺寸（像素）。内部分辨率会乘 devicePixelRatio 以保持清晰。 */
  width: number;
  height: number;
  /** 赛道边界（世界像素）。 */
  worldWidth: number;
  worldHeight: number;
  /** 中心线（世界像素），用来画赛道轮廓。 */
  centerline: readonly (readonly [number, number])[];
  /** 本道具/格宽度（世界像素），用来把轮廓画成"有宽度的路"。 */
  trackWidthPx: number;
  /** 背景与轮廓配色，跟随赛道主题时可以不传。 */
  colors?: {
    background: string;
    trackFill: string;
    trackLine: string;
  };
}

/** 世界坐标 → 小地图像素的换算结果。 */
export interface MinimapProjection {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** 小地图内侧留白（CSS 像素），避免赛道轮廓贴着面板边框。 */
export const MINIMAP_PADDING = 6;

/**
 * 算"世界 → 小地图"的等比缩放与居中偏移（纯函数，可单元测试）。
 *
 * 必须**等比**：横竖用两个不同比例会把赛道拉变形，玩家就没法从小地图上
 * 读出正确的弯道形状了。多出来的那一边用留白补上（居中）。
 */
export function computeMinimapProjection(
  width: number,
  height: number,
  worldWidth: number,
  worldHeight: number,
): MinimapProjection {
  const usableW = width - MINIMAP_PADDING * 2;
  const usableH = height - MINIMAP_PADDING * 2;
  const scale = Math.min(usableW / worldWidth, usableH / worldHeight);
  return {
    scale,
    offsetX: (width - worldWidth * scale) / 2,
    offsetY: (height - worldHeight * scale) / 2,
  };
}

/** 按投影把世界坐标换成小地图 CSS 像素坐标。 */
export function projectToMinimap(
  projection: MinimapProjection,
  worldX: number,
  worldY: number,
): [number, number] {
  return [projection.offsetX + worldX * projection.scale, projection.offsetY + worldY * projection.scale];
}

/**
 * 按赛道的横宽比算小地图的 CSS 尺寸。
 *
 * 长边固定：长方形的赛道（track3 是 168×88）就不会被塞进一个正方形里、
 * 左右空出一大片。纯函数，方便单测。
 */
export function minimapSizeFor(worldWidth: number, worldHeight: number, longSide = 176): { width: number; height: number } {
  const ratio = worldWidth / worldHeight;
  if (ratio >= 1) return { width: longSide, height: Math.round(longSide / ratio) };
  return { width: Math.round(longSide * ratio), height: longSide };
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly projection: MinimapProjection;
  private readonly options: MinimapOptions;
  private readonly dpr: number;
  /** 已静态绘制好的赛道底图，避免每帧重画轮廓（轮廓有几百个点）。 */
  private baseImage: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement, options: MinimapOptions) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[F1race] 小地图无法获取 2D 上下文');

    this.canvas = canvas;
    this.ctx = ctx;
    this.options = options;
    // 高 DPI 屏上按物理像素渲染，否则线条会糊
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(options.width * this.dpr);
    canvas.height = Math.round(options.height * this.dpr);
    canvas.style.width = `${options.width}px`;
    canvas.style.height = `${options.height}px`;

    this.projection = computeMinimapProjection(
      options.width,
      options.height,
      options.worldWidth,
      options.worldHeight,
    );
    this.renderBase();
  }

  /** 世界坐标 → 小地图 CSS 像素坐标。 */
  private project(worldX: number, worldY: number): [number, number] {
    return projectToMinimap(this.projection, worldX, worldY);
  }

  /**
   * 预渲染赛道轮廓到一张离屏 canvas。
   *
   * 中心线有几百个点，每帧都重画一遍纯属浪费；小地图的赛道部分一场比赛里
   * 完全不变，画一次贴上去就行。
   */
  private renderBase(): void {
    const { width, height, centerline, trackWidthPx } = this.options;
    const colors = this.options.colors ?? {
      background: 'rgba(10, 14, 20, 0.72)',
      trackFill: '#3a4050',
      trackLine: '#9aa4b8',
    };

    const off = document.createElement('canvas');
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const g = off.getContext('2d');
    if (!g) return;
    g.scale(this.dpr, this.dpr);

    // 1. 底色
    g.fillStyle = colors.background;
    g.fillRect(0, 0, width, height);

    if (centerline.length >= 2) {
      const lineWidth = Math.max(2, trackWidthPx * this.projection.scale);

      // 2. 路面：粗线画一遍，看起来就是"有宽度的赛道"
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = colors.trackFill;
      g.lineWidth = lineWidth;
      g.beginPath();
      centerline.forEach(([wx, wy], i) => {
        const [px, py] = this.project(wx, wy);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
      g.stroke();

      // 3. 中心线：细亮线，让弯道走向一眼可读
      g.strokeStyle = colors.trackLine;
      g.lineWidth = Math.max(1, lineWidth * 0.16);
      g.stroke();
    }

    this.baseImage = off;
  }

  /**
   * 重画一帧：先贴静态底图，再画所有光点。
   *
   * @param dots 本帧要显示的所有车（玩家 / AI / 幽灵车）
   */
  draw(dots: readonly MinimapDot[]): void {
    const { width, height } = this.options;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.baseImage) g.drawImage(this.baseImage, 0, 0);
    else {
      g.fillStyle = 'rgba(10, 14, 20, 0.72)';
      g.fillRect(0, 0, width, height);
    }

    g.scale(this.dpr, this.dpr);
    // 越界的光点会被画到面板外；裁剪一下保证看起来干净
    g.save();
    g.beginPath();
    g.rect(0, 0, width, height);
    g.clip();

    // 幽灵车先画，真车压在上面；玩家最后画，保证它在最上层
    const ordered = [...dots].sort((a, b) => {
      const rank = (d: MinimapDot) => (d.isGhost ? 0 : d.isPlayer ? 2 : 1);
      return rank(a) - rank(b);
    });
    for (const dot of ordered) this.drawDot(g, dot);
    g.restore();
  }

  private drawDot(g: CanvasRenderingContext2D, dot: MinimapDot): void {
    const [px, py] = this.project(dot.x, dot.y);
    const css = `#${(dot.color & 0xffffff).toString(16).padStart(6, '0')}`;

    if (dot.isGhost) {
      // 幽灵车：空心圈 + 半透明，和实心真车区分开
      g.globalAlpha = 0.85;
      g.strokeStyle = css;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, 3.2, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      return;
    }

    if (dot.finished) {
      // 完赛的车画成方块，表示"它已经停在那了"
      g.fillStyle = css;
      g.fillRect(px - 3, py - 3, 6, 6);
      if (dot.isPlayer) {
        g.strokeStyle = '#ffffff';
        g.lineWidth = 1.5;
        g.strokeRect(px - 3.75, py - 3.75, 7.5, 7.5);
      }
      return;
    }

    g.fillStyle = css;
    g.beginPath();
    g.arc(px, py, dot.isPlayer ? 4 : 3.2, 0, Math.PI * 2);
    g.fill();
    if (dot.isPlayer) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6;
      g.stroke();
    }
  }
}

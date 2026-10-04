import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  MINIMAP_PADDING,
  computeMinimapProjection,
  minimapSizeFor,
  projectToMinimap,
} from '../src/game/Minimap';
// @ts-expect-error 生成器是无类型的 .mjs 脚本，运行时由 Node 直接加载
import { TRACKS as RAW_TRACKS } from '../tools/gen-track.mjs';
import type { TrackMeta } from '../src/game/types';

/** 生成器是无类型的 .mjs，这里给它一份最小类型别名。 */
const TRACKS = RAW_TRACKS as { id: string }[];

/**
 * 生成器里**已登记**、且**已经生成出素材**的赛道 id。
 *
 * ⚠️ 这里刻意不直接用 `TRACKS`：`tools/gen-track.mjs` 的 `TRACKS` 是"生成器的完整
 * 目录"，里面可能有还没落盘素材的图（例如 track4「超级 S 弯道」—— 见 CR-16）。
 * 拿完整目录去 `readFileSync` 会直接 ENOENT 挂掉整组测试，而缺的其实是素材不是逻辑。
 *
 * 正确的口径是"**当前真正可玩的赛道**"：public/assets/maps/ 下存在 `.meta.json` 的那些。
 * 这样新增赛道只要跑了生成器就自动纳入覆盖，删掉未完成的图也不会连累测试。
 */
const PLAYABLE_TRACK_IDS = TRACKS.map((track) => track.id).filter((id) =>
  existsSync(new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url)),
);

function loadMeta(id: string): TrackMeta {
  const url = new URL(`../public/assets/maps/${id}.meta.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as TrackMeta;
}

/**
 * 小地图的坐标换算。
 *
 * 这块最容易出的错是"横竖用了两个不同的缩放比"——赛道会被拉变形，
 * 玩家从小地图上读到的弯道形状就是错的；而且它不会报错，只会静默画歪。
 * 所以这里把"等比 / 居中 / 不出界"三件事都钉死。
 */
describe('小地图坐标换算', () => {
  const CASES = [
    { name: '正方形世界', w: 2560, h: 2560 },
    { name: '宽世界', w: 3840, h: 2560 },
    { name: '很宽的世界', w: 5376, h: 2816 },
  ];

  it('横竖缩放比完全相同（等比，赛道不会被拉变形）', () => {
    for (const c of CASES) {
      const size = minimapSizeFor(c.w, c.h);
      const p = computeMinimapProjection(size.width, size.height, c.w, c.h);
      // 把世界的一条水平线和一条垂直线都投影过去，两边的比必须一致
      const [x0, y0] = projectToMinimap(p, 0, 0);
      const [x1] = projectToMinimap(p, c.w, 0);
      const [, y1] = projectToMinimap(p, 0, c.h);
      const sx = (x1 - x0) / c.w;
      const sy = (y1 - y0) / c.h;
      assert.ok(Math.abs(sx - sy) < 1e-9, `${c.name}：横向比 ${sx} ≠ 纵向比 ${sy}`);
      // 用容差比而不是严格相等：反推出来的比会有最后一位的浮点误差
      assert.ok(Math.abs(p.scale - sx) < 1e-12, `${c.name}：投影 scale ${p.scale} 与实测 ${sx} 不一致`);
    }
  });

  it('赛道四角都落在画布内、且四周留白对称', () => {
    for (const c of CASES) {
      const size = minimapSizeFor(c.w, c.h);
      const p = computeMinimapProjection(size.width, size.height, c.w, c.h);
      const corners = [
        projectToMinimap(p, 0, 0),
        projectToMinimap(p, c.w, 0),
        projectToMinimap(p, 0, c.h),
        projectToMinimap(p, c.w, c.h),
      ];
      for (const [x, y] of corners) {
        assert.ok(x >= MINIMAP_PADDING - 1e-6 && x <= size.width - MINIMAP_PADDING + 1e-6, `x=${x} 越界`);
        assert.ok(y >= MINIMAP_PADDING - 1e-6 && y <= size.height - MINIMAP_PADDING + 1e-6, `y=${y} 越界`);
      }
      // 左右留白相等、上下留白相等（居中）
      const leftPad = corners[0][0];
      const rightPad = size.width - corners[1][0];
      const topPad = corners[0][1];
      const bottomPad = size.height - corners[2][1];
      assert.ok(Math.abs(leftPad - rightPad) < 1e-6, `${c.name}：左右留白不对称 ${leftPad} vs ${rightPad}`);
      assert.ok(Math.abs(topPad - bottomPad) < 1e-6, `${c.name}：上下留白不对称 ${topPad} vs ${bottomPad}`);
    }
  });

  it('尺寸按赛道横宽比来（长边固定，不会塞进正方形里空一片）', () => {
    const wide = minimapSizeFor(3840, 2560);
    assert.equal(wide.width, 176);
    assert.equal(wide.height, Math.round(176 / 1.5));

    const taller = minimapSizeFor(2560, 3840);
    assert.equal(taller.height, 176);
    assert.equal(taller.width, Math.round(176 * (2560 / 3840)));

    const square = minimapSizeFor(2560, 2560);
    assert.deepEqual(square, { width: 176, height: 176 });
  });

  it('已生成赛道的中心线全部落在小地图范围内', () => {
    assert.ok(PLAYABLE_TRACK_IDS.length >= 2, `至少应有 2 条赛道已生成素材，实际 ${PLAYABLE_TRACK_IDS.length}`);
    for (const id of PLAYABLE_TRACK_IDS) {
      const meta = loadMeta(id);
      const size = minimapSizeFor(meta.world.width, meta.world.height);
      const p = computeMinimapProjection(size.width, size.height, meta.world.width, meta.world.height);
      for (const [wx, wy] of meta.centerline.points) {
        const [px, py] = projectToMinimap(p, wx, wy);
        assert.ok(
          px >= 0 && px <= size.width && py >= 0 && py <= size.height,
          `${id} 中心线点 (${wx}, ${wy}) 投影到 (${px}, ${py}) 越出 ${size.width}x${size.height}`,
        );
      }
    }
  });

  it('起跑点投影到小地图内的合理位置（不贴边）', () => {
    for (const id of PLAYABLE_TRACK_IDS) {
      const meta = loadMeta(id);
      const size = minimapSizeFor(meta.world.width, meta.world.height);
      const p = computeMinimapProjection(size.width, size.height, meta.world.width, meta.world.height);
      const [px, py] = projectToMinimap(p, meta.start.x, meta.start.y);
      assert.ok(px > 2 && px < size.width - 2 && py > 2 && py < size.height - 2, `${id} 起跑点贴边：(${px}, ${py})`);
    }
  });
});

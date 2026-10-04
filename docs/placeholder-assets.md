# 占位素材规范（REQ-010）

M1 阶段所有美术资源都是**程序化生成的像素占位素材**，目标是：

1. 名称固定、可预测，后续用同名正式素材直接覆盖，**不需要改任何代码**；
2. 尺寸与锚点固定，替换后不会破坏物理与渲染；
3. 生成过程可复现（确定性随机种子），方便 diff。

---

## 一、命名规范

```
public/assets/<类别>/<名称>_placeholder.png
```

- 类别：`tiles` / `cars` / `maps` /（后续）`ui` / `sfx` / `bgm`
- 名称：全部小写，单词用下划线分隔
- 占位素材一律以 `_placeholder` 结尾；替换成正式素材时**保留 `_placeholder` 后缀或同步修改 `src/game/constants.ts` 的 `ASSETS`**（推荐前者，改动最小）

代码里的资源键名与 URL 集中在 `src/game/constants.ts` 的 `ASSETS` 对象，替换素材只需改这一处。

---

## 二、当前素材清单

| 文件 | 尺寸 | 说明 |
| --- | --- | --- |
| `tiles/tileset_placeholder.png` | 256 × 32（8 格，每格 32×32） | 地图瓦片集，见下表 |
| `cars/car_player_placeholder.png` | 28 × 42 | 玩家车（旧占位），车头朝上 |
| `cars/car_ai_placeholder.png` | 28 × 42 | AI 车（M5 使用），车头朝上 |
| `cars/car_ghost_placeholder.png` | 28 × 42 | 幽灵车（M4 使用），车头朝上 |
| `cars/player_<suffix>.png` | 28 × 42 | **CR-15 的 6 张皮肤贴图**，suffix ∈ `default/red/blue/carbon/ghost/gold`，车头朝上 |
| `maps/track1.json` | — | Tiled 格式分层瓦片地图 |
| `maps/track1.meta.json` | — | 赛道元数据（起跑点、中心线、圈数、地表规则） |

> 皮肤贴图由 `tools/gen-assets.mjs` 的 `SKIN_PALETTES` 生成：6 张图走**同一个 `buildCar()`**，
> 28×42 的像素布局逐位相同、只换调色板 —— 这是"皮肤不带任何数值"的物质基础
> （连"看起来更小"的错觉都不该有）。键名由 `constants.skinAssetKey(suffix)` 推导，
> 加载在 `BootScene.preload()` 里一次性完成。

### 瓦片 gid

Tiled 的瓦片编号叫 gid，从 1 开始；**Phaser 运行时 `tile.index` 存的就是 gid**（空瓦片是 -1），
所以 `track1.meta.json` 的 `tiles` / `surface.trackGids` 里统一使用 gid，不需要再做 `gid - firstgid` 换算。

| gid | 名称 | 用途 |
| --- | --- | --- |
| 1 | `grassA` | 基础草地 |
| 2 | `grassB` | 草地色块变化 |
| 3 | `asphalt` | 赛道沥青 |
| 4 | `kerb` | 红白路肩（视觉效果，M1 与赛道同抓地力） |
| 5 | `startline` | 起跑线（黑白格） |
| 6 | `wall` | 护栏，**参与碰撞** |
| 7 | `tree` | 装饰树（不碰撞） |
| 8 | `tire` | 装饰轮胎堆（不碰撞） |

> 哪些瓦片算"赛道"由 `track1.meta.json` 的 `surface.trackGids` 决定（默认 `[3, 4, 5]`），不是硬编码。

---

## 三、替换正式素材的步骤

### 换车辆

1. 新素材尺寸保持 **28 × 42**，背景透明，**车头朝上**（北方）。
2. 覆盖 `public/assets/cars/car_player_placeholder.png`（AI 与幽灵车同理）。
3. 完成——碰撞体是半径 12px 的圆（居中），与贴图细节无关。若要改车身大小，同时调整 `src/game/constants.ts` 的 `TUNING.vehicle.bodyRadius`。

### 换 / 加皮肤（CR-15）

1. 尺寸同样保持 **28 × 42**、车头朝上；**像素布局必须与其它皮肤逐位一致**（只换颜色），
   否则会出现"某款皮肤看起来更小"的错觉，那是变相的数值差异。
2. 覆盖 `public/assets/cars/player_<suffix>.png`；新增一款要**同时**改三处：
   - `tools/gen-assets.mjs` 的 `SKIN_PALETTES`（或直接替换 PNG）
   - `src/game/Skins.ts` 的 `SKINS`（`id` / `assetSuffix` / `label` / `rarity` / `desc`）
   - `src/game/constants.ts` 的 `SKIN_ASSET_SUFFIXES`（决定 BootScene 会不会去加载它）
   `tests/skins.test.ts` 有一条断言把后两者锁在一起，漏改哪边都会红。
3. 想让新皮肤能从抽奖里抽到，还要加进 `TUNING.skins.dropTable`。

### 换瓦片集

1. 新瓦片集保持 **32 × 32 一格、共 8 格横排**（256 × 32）。
2. 覆盖 `public/assets/tiles/tileset_placeholder.png`。
3. 如格子顺序变化，同步更新 `track1.meta.json` 的 `tiles` 与 `surface.trackGids`。

### 换整张地图

见 README 的「赛道」一节：用 Tiled 重做 `track1.json`（保持图层名），再同步 `track1.meta.json` 的中心线。

---

## 四、重新生成占位素材

```bash
node tools/gen-assets.mjs      # 瓦片集 + 车辆
node tools/gen-track.mjs       # 地图 + 赛道元数据
node tools/preview-assets.mjs  # 生成 tools/out/preview.png 放大预览
```

生成器只用 Node 内置模块（`node:zlib`），不依赖任何第三方库；随机数使用固定种子，同样输入必得同样输出。

- 调色板在 `tools/gen-assets.mjs` 顶部的常量区；
- 赛道控制点在 `tools/gen-track.mjs` 顶部的 `CONTROL_POINTS`。

---

## 五、已知的美术欠账（留给 M6）

- HUD 使用系统字体 + CSS 像素风样式，尚未替换为像素位图字体；
- 路肩使用红白方格而非沿赛道方向的红白条纹；
- 车辆只有一张静态图，没有轮胎痕迹、没有尾灯/刹车灯；
- 装饰物只有树与轮胎堆两种。

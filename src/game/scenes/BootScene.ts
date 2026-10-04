import Phaser from 'phaser';
import { ASSETS, GAME_VERSION, MILESTONE, SKIN_ASSET_SUFFIXES, TRACK_ORDER, skinAssetKey, skinAssetUrl, trackAssetKeys } from '../constants';

/**
 * 启动场景：加载全部占位素材、**全部车辆皮肤贴图**与**全部赛道地图**，
 * 并在失败时把错误抛给页面而不是静默黑屏。
 *
 * 三张地图在这里一次性载入（每张只有几百 KB 的 JSON），
 * 这样切换赛道时不用重新走一遍加载流程，也不会出现"切图后黑一帧"。
 *
 * CR-15 的 6 张皮肤贴图同理：每张只有约 1 KB（28×42 像素），
 * 一次性全载入意味着**换皮肤不需要任何加载流程** —— 车库里点一下就能立刻看到车身变化，
 * 也不会出现"换完皮肤黑一帧"。少这一条就得在换皮肤时走动态加载，得不偿失。
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    this.load.image(ASSETS.tilesetKey, ASSETS.tilesetUrl);
    this.load.image(ASSETS.carPlayerKey, ASSETS.carPlayerUrl);
    this.load.image(ASSETS.carAiKey, ASSETS.carAiUrl);
    this.load.image(ASSETS.carGhostKey, ASSETS.carGhostUrl);

    // 玩家皮肤（CR-15）：全部预载，键由 skinAssetKey 推导，不要在别处硬编码
    for (const suffix of SKIN_ASSET_SUFFIXES) {
      this.load.image(skinAssetKey(suffix), skinAssetUrl(suffix));
    }

    for (const id of TRACK_ORDER) {
      const assets = trackAssetKeys(id);
      this.load.tilemapTiledJSON(assets.mapKey, assets.mapUrl);
      this.load.json(assets.metaKey, assets.metaUrl);
    }

    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      const message = `资源加载失败：${file.key} (${file.src ?? '未知路径'})`;
      window.dispatchEvent(new CustomEvent('f1race-fatal', { detail: message }));
    });
  }

  create(): void {
    // 便于自动化测试确认游戏已启动
    (window as unknown as Record<string, unknown>)['__F1RACE_VERSION__'] = `${GAME_VERSION} (${MILESTONE})`;
    this.scene.start('Race');
  }
}

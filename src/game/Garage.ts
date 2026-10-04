/**
 * Garage.ts
 * 「车库」皮肤选择界面（CR-15）：纯 DOM，**不 import Phaser**。
 *
 * 为什么不做在 canvas 里：本项目的 HUD / 结算 / 抽奖全是 DOM 覆盖层
 * （`index.html` 的 `.overlay` + `.hud-panel`），中文可读性靠系统字体保证。
 * 皮肤选择是一屏静态列表 + 点选，没有一帧一帧的动画需求，跟着既有做法走最省事，
 * 也天然满足了"选中即时生效" —— 换的只是精灵的贴图，不需要重开场景。
 *
 * 职责边界刻意收得很窄：
 *   - 本类**只管画**：读 `SkinStore` 的快照，把 6 款皮肤的拥有 / 装备状态画出来；
 *   - **装备决策在场景手里**（`SkinStore.equip` 会落盘、会同步车身贴图）。
 *     点一下换不了皮肤时，本类不会自己"顺手解锁"，只把状态重画一遍 ——
 *     `Skins.equipSkin` 对未拥有的皮肤不生效是刻意的（装备是玩家意图，不该顺带解锁）。
 */

import { SKINS, SKIN_IDS, type SkinState } from './Skins';
import { SkinStore } from './SkinStore';

/** 皮肤稀有度的显示名（只影响文案，不影响任何数值）。 */
const RARITY_LABELS: Record<string, string> = {
  starter: '初始',
  common: '常见',
  rare: '稀有',
};

/** 贴图前缀：与 `constants.ASSETS.skinUrlPrefix` / `skinUrlDir` 保持一致。 */
const SKIN_IMAGE_DIR = 'assets/cars/player_';

export interface GarageHandlers {
  /** 关闭车库（点"返回"或按 Esc / G）。 */
  onClose: () => void;
  /** 装备一款皮肤。返回是否真的换了（未拥有的皮肤会返回 false）。 */
  onEquip: (id: string) => boolean;
}

export class Garage {
  private readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly ownedCount: HTMLElement;
  private readonly equippedLabel: HTMLElement;
  /**
   * 车库状态与交互回调。
   *
   * ⚠️ 这里**必须显式声明字段再在构造函数里赋值**，不能用 TypeScript 的
   * "参数属性"（`constructor(private readonly store: SkinStore)`）：
   * 单元测试跑的是 Node 的类型剥离模式，它不支持参数属性，
   * 会直接抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。见 `docs/cr15-skins-handoff.md` 3.4。
   */
  private readonly store: SkinStore;
  private readonly handlers: GarageHandlers;
  /** 解锁了新皮肤之后，下次打开车库时高亮一下（"上一次抽到的是这款"）。 */
  private highlightId: string | null = null;

  constructor(store: SkinStore, handlers: GarageHandlers) {
    this.store = store;
    this.handlers = handlers;
    this.root = Garage.require('garage');
    this.grid = Garage.require('garage-grid');
    this.ownedCount = Garage.require('garage-owned-count');
    this.equippedLabel = Garage.require('garage-equipped');
    this.render();
  }

  private static require(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`[F1race] 缺少车库 DOM 元素 #${id}`);
    return el;
  }

  get isVisible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** 打开车库并重画（每次打开都重画：抽奖可能在关着的时候解锁了新皮肤）。 */
  open(highlightId: string | null = null): void {
    this.highlightId = highlightId;
    this.render();
    this.root.classList.remove('hidden');
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  /** 按当前 `SkinStore` 状态重画整张表。 */
  render(): void {    const state: SkinState = this.store.snapshot;
    const owned = new Set(state.owned);

    this.grid.replaceChildren(...SKIN_IDS.map((id) => this.buildCard(id, owned.has(id), state.equipped === id)));
    this.ownedCount.textContent = `${state.owned.length}/${SKIN_IDS.length}`;
    this.equippedLabel.textContent = SKINS[state.equipped]?.label ?? state.equipped;
  }

  /**
   * 生成一张皮肤卡片。
   *
   * 卡片本身就是按钮：语义正确（键盘能 Tab 到、能回车触发），也省掉一层嵌套。
   * 未拥有的卡片**不禁用** —— 点一下应当有反馈（toast "还没解锁"），
   * 直接 disabled 的按钮点下去毫无动静，玩家会以为界面卡了。
   */
  private buildCard(id: string, isOwned: boolean, isEquipped: boolean): HTMLElement {
    const skin = SKINS[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'garage-card';
    card.dataset['skin'] = id;
    card.dataset['owned'] = isOwned ? '1' : '0';
    if (isOwned) card.classList.add('is-owned');
    if (isEquipped) card.classList.add('is-equipped');
    if (!isOwned) card.classList.add('is-locked');
    if (this.highlightId === id) card.classList.add('is-new');

    const thumb = document.createElement('div');
    thumb.className = 'garage-thumb';
    const img = document.createElement('img');
    img.src = `${SKIN_IMAGE_DIR}${skin.assetSuffix}.png`;
    img.alt = skin.label;
    img.draggable = false;
    thumb.append(img);
    if (!isOwned) {
      const lock = document.createElement('span');
      lock.className = 'garage-lock';
      lock.textContent = '未拥有';
      thumb.append(lock);
    }

    const name = document.createElement('div');
    name.className = 'garage-name';
    name.textContent = skin.label;
    const rarity = document.createElement('span');
    rarity.className = `garage-rarity rarity-${skin.rarity}`;
    rarity.textContent = RARITY_LABELS[skin.rarity] ?? skin.rarity;
    name.append(rarity);

    const desc = document.createElement('div');
    desc.className = 'garage-desc';
    desc.textContent = skin.desc;

    const status = document.createElement('div');
    status.className = 'garage-status';
    status.textContent = isEquipped
      ? '使用中'
      : isOwned
        ? '点击装备'
        : '通过刷新纪录抽奖获得';

    card.append(thumb, name, desc, status);
    card.addEventListener('click', () => {
      const changed = this.handlers.onEquip(id);
      // 无论成功与否都重画：未拥有的卡片点了不该"看起来什么都没发生"
      this.highlightId = null;
      this.render();
      // 点了"已拥有但不是当前使用"的皮肤却没换成功，才算没生效
      if (!changed && !isEquipped) this.flashCard(id, 'is-denied');
    });
    return card;
  }

  /** 给某张卡片加一个短命的状态类（用于"点了但没生效"的反馈）。 */
  private flashCard(id: string, className: string): void {
    const card = this.grid.querySelector<HTMLElement>(`.garage-card[data-skin="${id}"]`);
    if (!card) return;
    card.classList.add(className);
    window.setTimeout(() => card.classList.remove(className), 420);
  }
}

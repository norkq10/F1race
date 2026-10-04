# CR-15 车辆皮肤系统 — 交接文档

> **给新对话用。** 这份文档交代皮肤系统「已经做了什么 / 还剩什么 / 有哪些不能违背的约束」。
> 读完之后应当能直接接手，不需要重新推导设计决策。
>
> 生成时间：2026-10-04
> 对应 `docs/change-requests.md` 的 **CR-15**（以及 CR-08 抽奖收口）

---

## 一、一句话背景

抽奖（老虎机）原本只决定"放不放中奖动画"，中奖道具**不接任何实际效果**。
在一个以「刷时间 = 实力证明」为核心的游戏里，**没有产出的随机奖励比没有奖励更伤** ——
它稀释了刷新纪录本身的成就感。

皮肤是最轻的「可累积产出」：**不影响任何数值**、不破坏公平、有收集欲、成本低
（全部是程序化生成的像素 PNG，零第三方素材）。

---

## 二、当前状态（务必先看这段）

**数据层 100% 完成，渲染层 0%。皮肤目前对玩家完全不可见。**

| 部分 | 状态 |
|---|---|
| `src/game/Skins.ts`（数据层） | ✅ 完成，33 条单测 |
| `src/game/SkinStore.ts`（持久化） | ✅ 完成，含在上面 33 条里 |
| `TUNING.skins`（掉落表等） | ✅ 完成 |
| `tests/skins.test.ts` | ✅ 34 条用例，全绿 |
| **6 张皮肤贴图** | ✅ 已生成（`public/assets/cars/player_*.png`） |
| BootScene 预加载皮肤贴图 | ❌ 未做 |
| RaceScene 按装备皮肤选贴图 | ❌ 未做 |
| 车库 / 皮肤选择 UI | ❌ 未做 |
| 抽奖中奖 → 解锁皮肤 | ❌ 未做 |
| e2e 验收 | ❌ 未做 |

**当前全量验收是绿的**：`307 单元测试 / 119 e2e / typecheck / build` 全部通过。
皮肤模块是**孤立新增**，没有接进游戏，所以不存在"半成品导致崩溃"的问题。

---

## 三、必须先读完的约束（违反任何一条都会被打回）

### 3.1 皮肤**不许带任何数值**

皮肤只描述「长什么样」。不许有速度 / 抓地 / 碰撞 / 计时 / 重量上的差异，
连"看起来更小"的错觉都不该有 —— 6 张贴图都走同一个 `buildCar()`，
28×42 的像素布局逐位相同，只换调色板。

`tests/skins.test.ts` 里有一条**白名单断言**守着这件事：

```ts
const allowed = new Set(['id', 'label', 'assetSuffix', 'rarity', 'desc']);
// 出现任何预期外字段 → 测试失败
```

加字段必须同步改这个白名单 —— 这是故意的摩擦，别绕过它。

### 3.2 存储必须走**独立键**，与成绩存档解耦

- 皮肤键：`f1race.skins.v1`（在 `Skins.ts` 的 `SKINS_STORAGE_KEY`）
- 成绩键：`TUNING.save.key` = `f1race.save.v3`

**为什么**：`SaveStore` 里的纪录会在**操控规则升版**时被**有意清空**
（`rulesetVersion`，见 `docs/known-issues.md` 第 16 条）—— 物理改了，旧成绩不再可比，
这个设计是对的。但**外观解锁不该跟着丢**：玩家抽到的皮肤与跑得快不快毫无关系。

`tests/skins.test.ts` 有断言守着：皮肤键不能等于、也不能挂在成绩键下面。

### 3.3 `Skins.ts` / `SkinStore.ts` **不许 import Phaser**

这是本项目的铁律：那批单元测试能在 Node 原生类型剥离下跑起来，
全靠这些模块不依赖 Phaser。`docs/change-requests.md` 第六节第 2 条明确点名了
CR-15 的皮肤模块要守这条线。

推论：`Skins.ts` 里**不能出现** `Phaser.GameObjects` / `Phaser.Scene` 之类的类型；
需要与引擎交互的部分（贴图 key 解析、精灵创建）放到场景或一个新的"薄适配层"里。

### 3.4 ⚠️ 不要用 TypeScript 的**参数属性**

```ts
// ❌ 单元测试会抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
constructor(private readonly totalLength: number) {}

// ✅ 显式声明字段再赋值
private readonly totalLength: number;
constructor(totalLength: number) { this.totalLength = totalLength; }
```

Node 的类型剥离模式不支持参数属性。`GhostRunner.ts` 里有这条注释，可参考。

### 3.5 覆盖已有文件前先 `read`

本仓库的约定：覆盖已存在文件前必须先读它，改动优先用精确替换而不是整份重写。

### 3.6 ⚠️ 绝对不要用 PowerShell 改文本文件

`Get-Content` / `Set-Content` 会按系统 ANSI 代码页处理 UTF-8 中文，
**文件会当场损坏**（本项目已经这样坏过三次，其中一次只能整份重写）。
一律用 read / edit / write 工具。

---

## 四、已完成部分的精确清单

### 4.1 `src/game/Skins.ts`

```ts
export interface SkinDefinition {
  id: string;           // 稳定 id，存储与掉落表都用它，**永远不要改**
  label: string;        // 界面显示名
  assetSuffix: string;  // 贴图后缀 → player_<assetSuffix>.png
  rarity: 'starter' | 'common' | 'rare';
  desc: string;         // 车库说明文案
}

export const SKINS: Record<string, SkinDefinition>   // 6 款
export const SKIN_IDS: string[]
export const STARTER_SKIN_ID = 'default'
export const SKINS_VERSION = 1
export const SKINS_STORAGE_KEY = 'f1race.skins.v1'

export interface SkinState { owned: string[]; equipped: string }

export function createSkinState(): SkinState
export function normalizeSkinState(raw: unknown): SkinState
export function hasSkin(state, id): boolean
export function unlockSkin(state, id): { state: SkinState; isNew: boolean }
export function equipSkin(state, id): SkinState
export function pickSkinDrop(random, dropTable): string
export function serializeSkins(state): string
export function deserializeSkins(raw: string | null): SkinState
export function formatEstimate(...)   // 这是别处的，勿混淆
```

6 款皮肤：

| id | 名字 | 稀有度 |
|---|---|---|
| `default` | 原厂 | starter（初始拥有） |
| `red` | 烈焰红 | common |
| `blue` | 深海蓝 | common |
| `carbon` | 碳纤维 | common |
| `ghost` | 幽灵白 | rare |
| `gold` | 黄金 | rare |

**几个已经想清楚的行为**（改之前先看测试）：

- `normalizeSkinState` 会**把 `default` 补在最前**，即使存档里漏了它 ——
  不能让玩家因为老档缺字段就失去默认外观。
- `equipSkin` 对**未拥有**的皮肤**不生效**，且**不替玩家解锁**。
  装备是玩家意图，不该顺带解锁。
- `unlockSkin` 对重复解锁返回 `isNew: false`。**调用方必须对它给出明确处理**，
  不许静默吞掉 —— 这是玩家最容易记恨的做法。
- `deserializeSkins` 版本不一致时**丢弃旧数据返回全新状态，不抛异常** ——
  为外观数据弹错误窗不值得。

### 4.2 `src/game/SkinStore.ts`

```ts
export interface StorageLike { getItem; setItem; removeItem }  // 用于注入内存实现

export class SkinStore {
  constructor(options?: { storage?: StorageLike | null; key?: string })
  get isPersistent(): boolean      // 纯内存模式为 false
  get snapshot(): SkinState        // 只读快照（已拷贝）
  get equipped(): string
  get owned(): readonly string[]
  has(id): boolean
  unlock(id): boolean              // 返回"是否首次获得"
  equip(id): boolean               // 返回"是否真的换了"
  clear(): void
  restore(raw: unknown): void      // 测试 / 调试用
}
```

**设计要点**：

- `storage` 不传时自动探测 `localStorage`，并且**探一次写入**（Safari 隐私模式下
  `localStorage` 存在但 `setItem` 会抛）。
- 读 / 写失败（配额满、权限）**静默降级为内存模式，不抛异常** ——
  皮肤是外观数据，写不进去不值得打断比赛。
- `isPersistent` 反映的是"有没有注入 storage"，不是"写入是否成功"。

### 4.3 `TUNING.skins`

```ts
skins: {
  dropTable: [
    { id: 'red',    weight: 30 },
    { id: 'blue',   weight: 30 },
    { id: 'carbon', weight: 25 },
    { id: 'ghost',  weight: 8  },
    { id: 'gold',   weight: 7  },
  ],
  duplicateReward: 'notice' as 'notice' | 'currency',
}
```

注意 `default` **刻意不在掉落表里** —— 那是初始皮肤，抽到它等于空奖。
测试会断言掉落表里每一项都是真实存在的皮肤、且权重为正。

### 4.4 贴图（已生成）

`tools/gen-assets.mjs` 里的 `SKIN_PALETTES`，输出到：

```
public/assets/cars/player_default.png
public/assets/cars/player_red.png
public/assets/cars/player_blue.png
public/assets/cars/player_carbon.png
public/assets/cars/player_ghost.png
public/assets/cars/player_gold.png
```

尺寸与现有车贴图一致（28×42），生成命令：`node tools/gen-assets.mjs`。

⚠️ `SKIN_PALETTES` 的键必须与 `Skins.ts` 的 `assetSuffix` **一一对应**，
改一边必须同步改另一边。目前两边都是
`default / red / blue / carbon / ghost / gold`。

现有的另外三张车贴图不受影响：
`car_player_placeholder.png`（玩家默认）、`car_ai_placeholder.png`（AI）、
`car_ghost_placeholder.png`（幽灵车）。

---

## 五、还剩什么（按建议顺序）

### 5.1 BootScene 预加载皮肤贴图

`src/game/scenes/BootScene.ts` 现在只加载：
`ASSETS.tilesetKey` / `carPlayerKey` / `carAiKey` / `carGhostKey` + 各赛道地图。

**6 张贴图数量少、体积小，建议一次性全载入** ——
切皮肤就不用再走一遍加载流程，也不会出现"换皮肤黑一帧"。

`ASSETS` 在 `src/game/constants.ts`，需要加一个按 suffix 取路径的辅助函数，
例如 `skinAssetKey(suffix)` / `skinAssetUrl(suffix)`。

### 5.2 RaceScene 按装备皮肤选贴图

`src/game/scenes/RaceScene.ts` 的 `buildRacers()` 里现在硬编码：

```ts
isPlayer ? ASSETS.carPlayerKey : ASSETS.carAiKey
```

改成玩家用 `skinAssetKey(skinStore.equipped 对应的 assetSuffix)`。

⚠️ **AI 与幽灵车不受皮肤影响**（AI 用自己的贴图 + tint，幽灵车有自己的贴图）。

### 5.3 车库 UI

需要新做（现在 `index.html` 只有 200 多行、**没有任何菜单**）。参考已有的覆盖层做法：
`#pause` / `#result` / `#lottery` 都是 `.overlay.hidden` 加一个 `.hud-panel`。

建议：
- 显示 6 款皮肤，已拥有 / 未拥有状态可区分
- 选中即时生效，**下一场比赛**使用（不用重开场景）
- 未拥有的显示锁定态 + 说明怎么获得
- 增加一个入口按钮（放在难度条附近，或做成 `Esc` 之外的独立键）

⚠️ 车库打开时应当**暂停比赛**，否则玩家会在菜单里被 AI 超过。

### 5.4 抽奖 → 解锁皮肤

`src/game/SlotMachine.ts` 现在是纯演出，`play()` 返回是否中奖但**不产出任何东西**。

接线点：`RaceScene.scheduleLottery()` 里的 `onSettled` 回调。

流程：
1. 中奖 → `pickSkinDrop(random, TUNING.skins.dropTable)` 抽一款
2. `skinStore.unlock(id)` → 返回 `isNew`
3. `isNew === true`：显示"获得新皮肤：<label>"
4. `isNew === false`：按 `TUNING.skins.duplicateReward` 处理
   （当前是 `'notice'`，即提示"已拥有"）

### 5.5 CR-08 收口

`docs/change-requests.md` 的 CR-08 要求：**`lottery.winRate` 的发布默认值不得是 0.99**。
现在 `TUNING.lottery.winRate = 0.99`，注释写着"测试阶段"。

CR-15 落地后 CR-08 只剩这一条。做法二选一：
- 加 `TUNING.lottery.enabled`（默认 `false`）
- 或把 99% 挪到 `?lottery=test` 的调试覆盖里

### 5.6 e2e 验收（CR-15 验收标准）

必须真操作真断言（本项目不接受伪造数据）：

1. 抽奖获得皮肤 → 车库可见
2. 装备后下一场比赛外观变化
3. **刷新页面后已拥有与装备状态保留**
4. **皮肤不影响成绩**：装备非默认皮肤跑 3 圈，成绩曲线与默认皮肤一致
5. 重复抽奖有明确处理，不静默吞掉

第 4 条是最重要的一条 —— 它是"皮肤不破坏公平"的机器验证。

---

## 六、已经踩过的坑（直接照抄结论，别再踩）

### 6.1 按 `name` 查表会失败，必须用 `id`

**背景**：我做「AI 预计完赛时间」时，`finishEstimatesMs` 是按 **racer id**（`ai1`）索引的，
但结算里我用了 **`entry.name`**（`蓝队`）去查 —— 结果时间算出来了却**一直显示"第 N 圈"**，
而且类型检查完全通过（`Map.get(string)` 接受任何字符串）。

**根因**：`StandingEntry` 当初**没有 id 字段**。

**已修**：`StandingEntry` 加了 `id`，`toStandingEntries` 会带出来。

**教训（做皮肤时同样适用）**：`name` 是**显示文案**，随时可能改成本地化文本；
只有 `id` 是稳定键。任何"按车手查东西"的地方都用 `id`。

### 6.2 上下文对象里传**值**会固化成快照

**背景**：抽 `RaceDebugApi` 时，调试接口的 context 是在 `create()` 里**构造一次**的。
我写了 `difficulty: this.difficulty`（传值），于是那个值在构造瞬间被**拷贝**了 ——
之后场景改难度，`ctx.difficulty` 还是老值。结果 `changeDifficulty` 永远早退、
比赛不重开、**所有车停在原地**。

**症状很迷惑**：类型检查通过（`readonly` 反而让"传了个死值"看起来天经地义），
是 e2e 抓出来的。

**规则**：只在 `create()` 构造一次的对象，**所有会变的值都必须用 getter**：

```ts
difficulty: () => this.difficulty,   // ✅
difficulty: this.difficulty,         // ❌ 快照
```

只有**对象引用**（`track` / `save` / `hud`）可以直接传 —— 对象本身不换，字段变化能看见。

### 6.3 删字段会让 e2e 静默失去手段

我把调试接口的 `scene: this` 删掉时，e2e 当场抛
`Cannot read properties of undefined (reading 'sprite')` ——
它有 **10 处**直接读 `__F1RACE__.scene.track` / `.cameras.main` / `.player.sprite`。

**教训**：改 `F1RaceDebugApi` 的形状前，先 `grep` 一遍 `tools/e2e-check.mjs`。

### 6.4 测试里的 `-0 !== 0`

`assert.equal(dot, 0)` 在正交几何里会因为算出 `-0` 而误报。
用 `assert.ok(dot === 0)` 或 `assert.ok(x === 0)`。

### 6.5 `restart()` 是异步的

调试接口的 `restart()` 内部走 `scene.restart()`，**紧随其后的调用会作用在旧场景上**。
需要等状态回到 `countdown` 再继续：

```js
await page.evaluate(() => window.__F1RACE__.restart());
await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown');
```

### 6.6 `restart()` 会清掉 AI 进度

做「预计完赛时间」的 e2e 时我踩了这个：`finishRaceQuickly()` 里先 `restart()`，
把 AI 跑了半圈的进度清零，于是估算样本不足、永远显示"第 N 圈"。

**规则**：要验"依赖累计进度"的功能，**不要 restart**，直接 `skipCountdown()` 继续跑。

---

## 七、验收命令

```bash
# 类型检查
node node_modules/typescript/bin/tsc --noEmit

# 单元测试（当前 307 项）
node --import ./tools/ts-register.mjs --test "tests/**/*.test.ts"

# 只跑皮肤相关
node --import ./tools/ts-register.mjs --test "tests/skins.test.ts"

# 构建（e2e 前必须先构建）
node node_modules/vite/bin/vite.js build

# 浏览器端验收（当前 119 项，约 4 分钟）
node tools/e2e-check.mjs

# 重新生成素材（改过 SKIN_PALETTES 之后）
node tools/gen-assets.mjs

# 刷新 README / known-issues 里的测试数字（不要手写这些数字）
node tools/doc-stats.mjs --write
```

**验收基线**：`307 单元测试 / 119 e2e / typecheck / build` 全绿。
改动后如果数字下降，先查是不是自己弄坏的。

---

## 八、参考文件

| 文件 | 作用 |
|---|---|
| `src/game/Skins.ts` | 皮肤定义 + 车库状态 + 掉落抽奖（**已完成**） |
| `src/game/SkinStore.ts` | 持久化（**已完成**） |
| `tests/skins.test.ts` | 34 条用例（**已完成**） |
| `tools/gen-assets.mjs` | `SKIN_PALETTES` + 6 张贴图生成（**已完成**） |
| `src/game/constants.ts` | `TUNING.skins`、`ASSETS`（`ASSETS` 需扩展） |
| `src/game/scenes/BootScene.ts` | 需加载皮肤贴图 |
| `src/game/scenes/RaceScene.ts` | `buildRacers()` 需按装备皮肤选贴图；`scheduleLottery()` 是抽奖接线点 |
| `src/game/SlotMachine.ts` | 老虎机演出，`play()` 返回是否中奖 |
| `src/game/Hud.ts` | 各种覆盖层与面板的 DOM 操作参考 |
| `index.html` | 覆盖层的 HTML 结构（`#pause` / `#result` / `#lottery`） |
| `src/style.css` | `.overlay` / `.hud-panel` 等样式 |
| `docs/change-requests.md` | CR-15 原始需求与验收标准、CR-08 抽奖收口 |

---

## 九、一句话总结给接手的人

**数据层、持久化、6 张贴图、34 条单测都好了，你要做的是把它接进游戏**：
BootScene 加载 → RaceScene 用装备贴图 → 做一个车库 UI → 抽奖中奖时解锁 →
补 5 条 e2e（其中"皮肤不影响成绩"最重要）→ 顺便把 `lottery.winRate` 的
发布默认值从 0.99 收掉（CR-08 最后一条）。

**四条铁律**：皮肤不带数值、存储独立键、`Skins.ts` 不 import Phaser、
不用 PowerShell 改文本。

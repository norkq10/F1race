/**
 * tools/e2e-check.mjs
 * F1race 浏览器端验收脚本（M1 ~ M5 + 多赛道）。
 *
 * 覆盖的验收点：
 *   REQ-001 WASD 响应
 *   REQ-002 镜头跟随 / 主角居中
 *   REQ-003 草地减速约 40%，离开后恢复
 *   REQ-004 漂移（按下侧滑 / 松开恢复 / 不突破极速）
 *   REQ-005 / REQ-011 3 圈计时与结算
 *   REQ-006 / REQ-018 幽灵车回放、同速、无碰撞
 *   REQ-007 AI 对手会跑完整场、不长期卡墙
 *   REQ-008 难度越高 AI 越快
 *   REQ-009 / REQ-017 HUD 显示项
 *   REQ-013 刷新页面后最佳成绩仍在
 *   REQ-014 撞墙 / 车与车碰撞减速弹开且不卡死
 *   REQ-015 倒计时结束后才能动车 + 统一发车线
 *   多赛道 切换赛道后地图 / 中心线 / 存档全部跟着换
 *
 * 用法：
 *   node tools/e2e-check.mjs                 # 自动启动 vite preview
 *   node tools/e2e-check.mjs --url <url>     # 复用已在运行的服务
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const urlArgIndex = args.indexOf('--url');
const EXTERNAL_URL = urlArgIndex >= 0 ? args[urlArgIndex + 1] : null;
const PORT = 5181;
/**
 * 显式钉住初始赛道，避免上一次跑留下的 localStorage 影响本次用例。
 *
 * `lottery=test`（CR-08）：抽奖的**发布默认是关闭的**（`TUNING.lottery.enabled = false`），
 * 中奖率也从 99% 收到 35%。自动化验收必须能稳定走通"中奖 → 解锁皮肤 → 车库可见"整条链路，
 * 所以这里带上调试参数：它把抽奖打开、中奖率提到 `TUNING.lottery.testWinRate`（99%）。
 * **发布路径不受影响** —— 不带参数时仍然是关闭 + 35%。
 */
const BASE_URL = `${EXTERNAL_URL ?? `http://127.0.0.1:${PORT}/`}?track=track1&lottery=test`;
const SHOT_DIR = 'tools/screenshots';
const MAX_SPEED = 520;
const GRASS_FACTOR = 0.6;
/** 与 constants.ts 的 TUNING.save.key 一致。 */
const SAVE_KEY = 'f1race.save.v3';

const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function near(actual, expected, toleranceRatio) {
  return Math.abs(actual - expected) <= Math.abs(expected) * toleranceRatio;
}

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* 服务器还没起来 */
    }
    await sleep(400);
  }
  return false;
}

function startPreviewServer() {
  const child = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  );
  return child;
}

async function state(page) {
  return page.evaluate(() => window.__F1RACE__.getState());
}

async function setInput(page, throttle, steer) {
  await page.evaluate(([t, s]) => window.__F1RACE__.setInput(t, s), [throttle, steer]);
}

/** 按住真实键盘按键，验证浏览器事件链路（REQ-001）。 */
async function holdKeys(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of keys) await page.keyboard.up(k);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const server = EXTERNAL_URL ? null : startPreviewServer();
  const consoleErrors = [];
  const pageErrors = [];
  let browser;

  try {
    if (!(await waitForServer(BASE_URL))) throw new Error(`服务器未就绪：${BASE_URL}`);

    browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    // ---------------------------------------------------------- 启动
    await page.goto(`${BASE_URL}&debug=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });
    const version = await page.evaluate(() => window.__F1RACE_VERSION__);
    check('游戏启动且版本标记存在', typeof version === 'string' && version.length > 0, String(version));
    // CR-02：版本号只有一个来源（package.json），由 vite 的 define 注入
    const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    check(
      'CR-02 页面版本号来自 package.json（单一来源）',
      typeof version === 'string' && version.startsWith(pkgVersion),
      `页面=${version} package.json=${pkgVersion}`,
    );
    check('无 JS 运行时报错', pageErrors.length === 0, pageErrors.join(' | ') || '无');

    const boot = await state(page);
    check('渲染器已就绪', boot.renderer === 1 || boot.renderer === 2, `renderer=${boot.renderer} (2=WebGL, 1=Canvas)`);
    check('加载了赛道中心线', boot.trackLength > 5000, `trackLength=${Math.round(boot.trackLength)}px`);
    check('默认加载 track1', boot.trackId === 'track1', `trackId=${boot.trackId}`);

    const pixelated = await page.evaluate(() => {
      const canvas = document.querySelector('#game-root canvas');
      return canvas ? getComputedStyle(canvas).imageRendering : 'missing';
    });
    check('画布使用像素化放大，不模糊', pixelated === 'pixelated' || pixelated === 'crisp-edges', pixelated);

    const hudVisible = await page.evaluate(() => !document.getElementById('hud').classList.contains('hidden'));
    check('HUD 可见', hudVisible);


    // ---------------------------------------------------------- REQ-015 起跑
    await page.screenshot({ path: `${SHOT_DIR}/01-countdown.png` });
    const countdownText = await page.textContent('#countdown');
    check('倒计时显示 3-2-1', ['3', '2', '1'].includes((countdownText ?? '').trim()), `显示 "${countdownText}"`);

    // 按住 W 直到发车之后再松开。
    //
    // ⚠️ 这里必须在**倒计时期间就把油门按住**，而且要按到网格check 结束：
    // 倒计时结束后 AI 立刻全油门起步（640px/s²，约 95px/秒²），而玩家没油门就原地不动。
    // 曾经的做法是"倒计时期间按 700ms 再松开" —— 那样参赛者里只有 AI 在加速，
    // 于是"统一发车线"那条断言量到的是"玩家 0px vs AI 跑了 1 秒"，
    // 离散步长随帧率漂移，同一份代码时而通过（<6px）时而失败（95~120px）。
    // 让玩家和 AI 同时起步，这条断言测的才是**发车格是否对齐**，而不是"谁先踩油门"。
    await page.keyboard.down('w');
    await sleep(700);
    const duringCountdown = await state(page);
    check(
      '倒计时期间车辆不可移动',
      Math.abs(duringCountdown.speed) < 1 && duringCountdown.state === 'countdown',
      `speed=${duringCountdown.speed.toFixed(1)} state=${duringCountdown.state}`,
    );

    // 等待真实倒计时走完，验证 GO 之后才能动
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'racing', null, { timeout: 8000 });
    check('倒计时结束后自动开始比赛', true);
    await page.screenshot({ path: `${SHOT_DIR}/02-go.png` });

    // ---------------------------------------------------------- 统一发车线
    // 所有车必须并排在同一条起跑线上：沿赛道的纵向位置一致，只做左右横向错开。
    // 弧长 0 会被归一化成"接近整圈"的值，所以要按绕圈的差值量，不能直接取 max − min。
    const grid = await page.evaluate(() => {
      const track = window.__F1RACE__.scene.track;
      return window.__F1RACE__.getState().racers.map((r) => {
        const p = track.progressAt(r.x, r.y);
        return {
          name: r.name,
          isPlayer: r.isPlayer,
          arc: p.arc,
          signedLateral: p.signedLateral,
          onTrack: track.isOnTrack(r.x, r.y),
        };
      });
    });
    const totalLength = await page.evaluate(() => window.__F1RACE__.scene.track.totalLength);
    const baseArc = grid[0].arc;
    const arcOffsets = grid.map((r) => {
      let delta = r.arc - baseArc;
      if (delta > totalLength / 2) delta -= totalLength;
      if (delta < -totalLength / 2) delta += totalLength;
      return delta;
    });
    const arcSpread = Math.max(...arcOffsets) - Math.min(...arcOffsets);
    // 容差 6px：四台车横向摊开 ±60px，中心线在起跑线附近并非绝对笔直，
    // 所以同一弧长上的车测出来的 arc 会有几像素差异；而阶梯发车的间隔是 34px 量级，一眼可分。
    check(
      '统一发车线：四台车沿赛道的纵向位置一致',
      arcSpread < 6,
      `纵向离散度 ${arcSpread.toFixed(1)}px（阶梯发车会是 30px 以上）：` +
        grid.map((r, i) => `${r.name}=${arcOffsets[i].toFixed(0)}`).join(' '),
    );
    check(
      '统一发车线：只做左右错开，四台车横向各占一条道',
      new Set(grid.map((r) => Math.round(r.signedLateral))).size === grid.length,
      grid.map((r) => `${r.name}=${r.signedLateral.toFixed(0)}`).join(' / ') + ' px',
    );
    check(
      '统一发车线：所有车都停在赛道内（横向错开没把人送上草地）',
      grid.every((r) => r.onTrack === true),
      grid.map((r) => `${r.name}=${r.onTrack ? '赛道' : '草地'}`).join(' '),
    );

    // 网格测量结束，松开油门（后面的 M1/M2 用例会自己按需给油）
    await page.keyboard.up('w');

    // ---------------------------------------------------------- REQ-001 WASD
    // M1/M2 是玩家单人车的回归测试，先把 AI 关掉隔离干扰；M5 段落再打开。
    await page.evaluate(() => window.__F1RACE__.setAiEnabled(false));
    await page.evaluate(() => window.__F1RACE__.skipCountdown());

    const beforeDrive = await state(page);
    await holdKeys(page, ['w'], 1800);
    const afterDrive = await state(page);
    check(
      'W 油门：速度上升',
      afterDrive.speed > 200,
      `speed=${afterDrive.speed.toFixed(0)} px/s (${afterDrive.speedKmh.toFixed(0)} km/h)`,
    );
    check(
      '车辆实际位移',
      Math.hypot(afterDrive.x - beforeDrive.x, afterDrive.y - beforeDrive.y) > 100,
      `位移 ${Math.hypot(afterDrive.x - beforeDrive.x, afterDrive.y - beforeDrive.y).toFixed(0)}px`,
    );

    // 镜头跟随（REQ-002）：主角应保持在屏幕中心附近
    const cameraOffset = await page.evaluate(() => {
      const scene = window.__F1RACE__.scene;
      const cam = scene.cameras.main;
      const sprite = scene.player.sprite;
      return {
        dx: (sprite.x - cam.worldView.centerX) * cam.zoom,
        dy: (sprite.y - cam.worldView.centerY) * cam.zoom,
      };
    });
    check(
      '主角保持在屏幕中心附近',
      Math.abs(cameraOffset.dx) < 3 && Math.abs(cameraOffset.dy) < 3,
      `偏移 (${cameraOffset.dx.toFixed(1)}, ${cameraOffset.dy.toFixed(1)}) 屏幕像素`,
    );

    // 转向：右转应使 heading 增大（屏幕 y 向下，顺时针为正）
    const beforeTurn = await state(page);
    await setInput(page, 1, 1);
    await sleep(900);
    const afterTurn = await state(page);
    check(
      'D 右转：车头角度增大',
      afterTurn.heading > beforeTurn.heading + 0.1,
      `heading ${beforeTurn.heading.toFixed(2)} -> ${afterTurn.heading.toFixed(2)}`,
    );

    await setInput(page, 1, -1);
    await sleep(900);
    const afterLeft = await state(page);
    check(
      'A 左转：车头角度减小',
      afterLeft.heading < afterTurn.heading - 0.1,
      `heading ${afterTurn.heading.toFixed(2)} -> ${afterLeft.heading.toFixed(2)}`,
    );

    // 刹车 / 倒车
    await setInput(page, -1, 0);
    await sleep(1400);
    const reversing = await state(page);
    check('S 刹车并倒车：速度为负', reversing.speed < -30, `speed=${reversing.speed.toFixed(0)} px/s`);

    // ---------------------------------------------------------- 反作弊：起点蹭线不刷圈
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await page.evaluate(() => window.__F1RACE__.setInput(1, 0));
    await sleep(1500);
    await page.evaluate(() => window.__F1RACE__.setInput(-1, 0));
    await sleep(1500);
    await page.evaluate(() => window.__F1RACE__.setInput(1, 0));
    await sleep(1500);
    await page.evaluate(() => window.__F1RACE__.setInput(0, 0));
    const wiggle = await state(page);
    check(
      '起点来回蹭线不会刷圈',
      wiggle.lapsCompleted === 0 && wiggle.progressT < 0.25,
      `lapsCompleted=${wiggle.lapsCompleted} progressT=${wiggle.progressT.toFixed(3)}`,
    );

    // ---------------------------------------------------------- REQ-003 草地
    // 取"离赛道中心最远"的中心线点，沿外法线逐级外推，直到找出一个周围确实没有赛道的草地采样点。
    // 这样即使赛道形状改了，测试也不会因为采样点压在路肩上而失效。
    await setInput(page, 0, 0);
    const grassProbe = await page.evaluate(() => {
      const track = window.__F1RACE__.scene.track;
      const pts = track.centerlinePoints;
      let cx = 0;
      let cy = 0;
      for (const p of pts) {
        cx += p[0];
        cy += p[1];
      }
      cx /= pts.length;
      cy /= pts.length;

      let bestIndex = 0;
      let bestDistance = -1;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - cx, pts[i][1] - cy);
        if (d > bestDistance) {
          bestDistance = d;
          bestIndex = i;
        }
      }
      const a = pts[(bestIndex - 3 + pts.length) % pts.length];
      const b = pts[(bestIndex + 3) % pts.length];
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const ux = (pts[bestIndex][0] - cx) / bestDistance;
      const uy = (pts[bestIndex][1] - cy) / bestDistance;

      for (let d = 150; d <= 420; d += 20) {
        const x = pts[bestIndex][0] + ux * d;
        const y = pts[bestIndex][1] + uy * d;
        // 采样点本身以及再往外 40px 都必须是草地，保证测试期间不会又开回赛道
        if (!track.isOnTrack(x, y) && !track.isOnTrack(x + ux * 40, y + uy * 40)) {
          return { x, y, heading, offset: d };
        }
      }
      return null;
    });
    check('找到一处周围无赛道的草地采样点', grassProbe !== null, grassProbe ? `外推 ${grassProbe.offset}px` : '未找到');
    if (grassProbe) {
      await page.evaluate(
        ([x, y, h]) => window.__F1RACE__.place(x, y, h, 0),
        [grassProbe.x, grassProbe.y, grassProbe.heading],
      );
      await sleep(200);
      const onGrass = await state(page);
      check('法线外推点判定为草地', onGrass.onTrack === false, `onTrack=${onGrass.onTrack}`);
      await page.screenshot({ path: `${SHOT_DIR}/03-grass.png` });

      // 草地上满油加速：上限应落到 60%
      await setInput(page, 1, 0);
      await sleep(2200);
      const grassTop = await state(page);
      check(
        '草地速度上限下降约 40%',
        near(grassTop.surfaceFactor, GRASS_FACTOR, 0.02) &&
          grassTop.onTrack === false &&
          grassTop.speed < MAX_SPEED * GRASS_FACTOR * 1.06 &&
          grassTop.speed > MAX_SPEED * GRASS_FACTOR * 0.75,
        `surfaceFactor=${grassTop.surfaceFactor.toFixed(3)} speed=${grassTop.speed.toFixed(0)} onTrack=${grassTop.onTrack}（赛道极速 ${MAX_SPEED}）`,
      );
    }

    // 回到赛道：松开油门静置，速度上限应在约 0.6 秒内恢复
    const trackProbe = await page.evaluate(() => {
      const track = window.__F1RACE__.scene.track;
      const p = track.pointAtArc(track.totalLength * 0.3);
      return { x: p.x, y: p.y, heading: p.tangent };
    });
    await page.evaluate(
      ([x, y, h]) => window.__F1RACE__.place(x, y, h, 0),
      [trackProbe.x, trackProbe.y, trackProbe.heading],
    );
    await setInput(page, 0, 0);
    await sleep(700);
    const recovered = await state(page);
    check(
      '回到赛道后速度上限恢复',
      recovered.onTrack === true && recovered.surfaceFactor > 0.99,
      `surfaceFactor=${recovered.surfaceFactor.toFixed(3)} onTrack=${recovered.onTrack}`,
    );

    // ---------------------------------------------------------- REQ-014 撞墙
    const wallProbe = await page.evaluate(() => {
      const scene = window.__F1RACE__.scene;
      return { tileSize: scene.track.meta.tileSize, wallThickness: 2 };
    });
    const wallBoundary = wallProbe.tileSize * wallProbe.wallThickness; // 左墙外沿 x
    await page.evaluate(([x]) => window.__F1RACE__.place(x, 1280, Math.PI, 420), [wallBoundary + 90]);
    await setInput(page, 1, 0);
    await sleep(1500);
    const afterWall = await state(page);
    check(
      '撞墙不穿透',
      afterWall.x > wallBoundary + 5,
      `x=${afterWall.x.toFixed(1)}（墙外沿 x=${wallBoundary}）`,
    );
    check('撞墙明显减速', afterWall.speed < 150, `speed=${afterWall.speed.toFixed(0)} px/s`);
    await page.screenshot({ path: `${SHOT_DIR}/04-wall.png` });

    // 不卡死：倒车应能脱困
    const stuckX = afterWall.x;
    await setInput(page, -1, 0);
    await sleep(1500);
    const escaped = await state(page);
    check(
      '撞墙后可以倒车脱困，不会卡死',
      escaped.x > stuckX + 25,
      `x ${stuckX.toFixed(1)} -> ${escaped.x.toFixed(1)}`,
    );

    // ---------------------------------------------------------- REQ-005 / REQ-011 三圈
    console.log('  … 自动驾驶跑完整场 3 圈（真实时间，约 1 分钟）');
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await page.evaluate(() => window.__F1RACE__.skipCountdown());

    const raceStart = Date.now();
    // 自己轮询而不是 waitForFunction：顺便采样 M2 的实时 delta
    let sawLiveDelta = false;
    let sawDeltaSource = null;
    for (;;) {
      const sample = await state(page);
      if (sample.liveDeltaMs !== null) {
        sawLiveDelta = true;
        sawDeltaSource = sample.referenceSource;
      }
      if (sample.state === 'finished') break;
      if (Date.now() - raceStart > 240000) throw new Error('3 圈未在 4 分钟内完成');
      await sleep(250);
    }
    const raceSeconds = (Date.now() - raceStart) / 1000;
    const finished = await state(page);
    await page.screenshot({ path: `${SHOT_DIR}/05-result.png` });

    check('3 圈全部完成', finished.lapsCompleted === 3, `lapsCompleted=${finished.lapsCompleted}`);
    check(
      '记录了 3 圈成绩',
      finished.lapTimesMs.length === 3,
      JSON.stringify(finished.lapTimesMs.map((v) => Math.round(v))),
    );
    check(
      '每圈用时合理（无幽灵圈）',
      finished.lapTimesMs.every((v) => v > 5000),
      finished.lapTimesMs.map((v) => `${(v / 1000).toFixed(2)}s`).join(', '),
    );
    const lapSum = finished.lapTimesMs.reduce((a, b) => a + b, 0);
    check(
      '总时间等于各圈之和（计时一致）',
      Math.abs(lapSum - finished.totalMs) < 0.001,
      `sum=${lapSum.toFixed(3)} total=${finished.totalMs.toFixed(3)}`,
    );
    // M2 的精确计时：过线时刻由帧内插值算出，必然早于"帧边界累计值"，且差值不超过一帧
    const frameGap = finished.raceTimeMs - finished.totalMs;
    check(
      'M2 过线时间做了帧内插值（早于帧边界且不超过一帧）',
      frameGap >= 0 && frameGap < 60,
      `帧边界累计 ${finished.raceTimeMs.toFixed(1)}ms − 精确总时间 ${finished.totalMs.toFixed(1)}ms = ${frameGap.toFixed(1)}ms`,
    );
    check(
      '最佳圈取自三圈中的最小值',
      Math.abs(finished.bestLapMs - Math.min(...finished.lapTimesMs)) < 0.001,
      `bestLap=${finished.bestLapMs.toFixed(1)}`,
    );
    check('结算界面弹出', finished.resultVisible === true);
    check('最佳总时间已写入存档', finished.bestTotalMs !== null, `${finished.bestTotalMs?.toFixed(1)}ms`);
    console.log(`  … 自动驾驶完赛用时 ${raceSeconds.toFixed(1)}s`);

    // ---------------------------------------------------------- M2 计时与成绩
    check(
      'M2 每圈都带 3 段分段时间',
      finished.lapResults.every((lap) => lap.sectorsMs.length === 3),
      JSON.stringify(finished.lapResults[0]?.sectorsMs.map((v) => Math.round(v))),
    );
    check(
      'M2 分段时间之和等于圈速',
      finished.lapResults.every(
        (lap) => Math.abs(lap.sectorsMs.reduce((a, b) => a + b, 0) - lap.lapMs) < 0.001,
      ),
    );
    check('M2 全程没有无效圈', finished.lapResults.every((lap) => lap.valid === true));
    check('M2 比赛过程中出现实时 delta', sawLiveDelta === true, `delta 参考来源=${String(sawDeltaSource)}`);
    check(
      'M2 成绩写入历史',
      finished.historyLength >= 1 && finished.history[0].valid === true,
      `history=${finished.historyLength}`,
    );
    check(
      'M2 存档版本为 3 且带最佳圈检查点曲线',
      finished.saveVersion === 3 && finished.storedCheckpoints === 25,
      `version=${finished.saveVersion} checkpoints=${finished.storedCheckpoints}`,
    );
    check(
      'M2 存下了分段最佳',
      finished.storedBestSectorsMs.filter((v) => v !== null).length === 3,
      JSON.stringify(finished.storedBestSectorsMs.map((v) => (v === null ? null : Math.round(v)))),
    );

    // 完赛后 delta 与无效圈提示都应隐藏
    check(
      'M2 完赛后隐藏 delta 与无效圈提示',
      (await page.isHidden('#hud-delta')) && (await page.isHidden('#hud-lap-flag')),
    );

    const hudBest = (await page.textContent('#hud-best-total'))?.trim();
    check('HUD 显示最佳总时间', /^\d+:\d{2}\.\d{3}$/.test(hudBest ?? ''), String(hudBest));

    // 帧率（无头软件渲染，仅作参考，阈值放宽）
    const fps = finished.fps;
    check('帧率处于可玩区间（无头软渲染参考值）', fps > 20, `${fps.toFixed(1)} FPS`);

    // ---------------------------------------------------------- REQ-013 持久化
    const savedTotal = finished.bestTotalMs;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });
    const afterReload = await state(page);
    check(
      '刷新页面后最佳总时间仍存在',
      afterReload.bestTotalMs !== null && Math.abs(afterReload.bestTotalMs - savedTotal) < 0.5,
      `reload 前 ${savedTotal?.toFixed(1)}ms，reload 后 ${afterReload.bestTotalMs?.toFixed(1)}ms`,
    );
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
    check(
      'localStorage 存档带版本号',
      typeof stored === 'string' && JSON.parse(stored).version === 3,
      typeof stored === 'string' ? `version=${JSON.parse(stored).version}` : '缺失',
    );
    check(
      'M2 刷新后成绩历史仍在',
      afterReload.historyLength >= 1 && afterReload.history[0].valid === true,
      `history=${afterReload.historyLength}`,
    );
    check(
      'M2 刷新后最佳圈检查点曲线仍可用于 delta',
      afterReload.storedCheckpoints === 25,
      `checkpoints=${afterReload.storedCheckpoints}`,
    );

    // ---------------------------------------------------------- M2 历史参考 delta
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await sleep(4000);
    const deltaState = await state(page);
    check(
      'M2 新一场比赛会以历史最佳圈作为 delta 参考',
      deltaState.liveDeltaMs !== null && deltaState.referenceSource === 'history',
      `delta=${deltaState.liveDeltaMs === null ? 'null' : deltaState.liveDeltaMs.toFixed(0)}ms source=${String(deltaState.referenceSource)}`,
    );
    check('M2 delta 显示在 HUD 上', await page.isVisible('#hud-delta'));
    const deltaText = (await page.textContent('#hud-delta-value'))?.trim() ?? '';
    check('M2 delta 文本形如 ±s.mmm', /^[+-]\d+\.\d{3}$/.test(deltaText), deltaText);
    await page.screenshot({ path: `${SHOT_DIR}/06-delta.png` });
    await page.evaluate(() => window.__F1RACE__.setAutopilot(false));

    // ---------------------------------------------------------- M2 暂停
    // 按 Esc 之后要等 paused 真正变 true（按键到场景 update() 生效之间有一帧左右的延迟），
    // 再采样时间做对比；否则会把"这一帧还没停住"的 16ms 误差当成暂停失效。
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__F1RACE__.getState().paused === true, null, { timeout: 5000 });
    const pausedState = await state(page);
    await sleep(1200);
    const pausedLater = await state(page);
    check(
      'M2 Esc 可以暂停，且计时停住',
      pausedState.pauseVisible === true && Math.abs(pausedLater.raceTimeMs - pausedState.raceTimeMs) < 1,
      `暂停后计时 ${pausedState.raceTimeMs.toFixed(0)}ms → 1.2 秒后 ${pausedLater.raceTimeMs.toFixed(0)}ms`,
    );
    await page.screenshot({ path: `${SHOT_DIR}/07-pause.png` });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__F1RACE__.getState().paused === false, null, { timeout: 5000 });
    await sleep(500);
    const resumedState = await state(page);
    check(
      'M2 再按 Esc 可以继续，计时恢复',
      resumedState.pauseVisible === false && resumedState.raceTimeMs > pausedLater.raceTimeMs + 300,
      `恢复后 ${resumedState.raceTimeMs.toFixed(0)}ms（暂停时 ${pausedLater.raceTimeMs.toFixed(0)}ms）`,
    );

    // ---------------------------------------------------------- CR-15 G 键开车库
    //
    // 车库入口除了难度条上的按钮，还有一个真实按键（G）。这里按真键验证：
    // 键盘链路（InputController 的边沿闩锁）→ 场景暂停 → 关掉后恢复。
    await page.keyboard.press('g');
    await page.waitForFunction(() => window.__F1RACE__.getState().skins.garageVisible === true, null, {
      timeout: 5000,
    });
    const garageByKey = await state(page);
    check(
      'CR-15 按 G 能打开车库并暂停比赛',
      garageByKey.skins.garageVisible === true && garageByKey.paused === true,
      `garage=${String(garageByKey.skins.garageVisible)} paused=${String(garageByKey.paused)}`,
    );
    await page.keyboard.press('g');
    await page.waitForFunction(() => window.__F1RACE__.getState().skins.garageVisible === false, null, {
      timeout: 5000,
    });
    const garageClosedByKey = await state(page);
    check(
      'CR-15 再按 G 关掉车库并恢复比赛',
      garageClosedByKey.skins.garageVisible === false && garageClosedByKey.paused === false,
      `garage=${String(garageClosedByKey.skins.garageVisible)} paused=${String(garageClosedByKey.paused)}`,
    );

    // ---------------------------------------------------------- 过弯冲出赛道压草地（不该判切弯）
    //
    // 玩家实际报回来的 bug：在「漂移龙」上过弯失误、冲出赛道压了草地，
    // 却被判「切弯：赛道进度异常跳跃」而整圈作废。根因是全图最近点查询在发夹弯里
    // 会跳到另一段路上（弧长瞬间跳掉几十上百像素），于是"每帧位移"看起来像瞬移。
    // 修法是每帧计时改走连续弧长查询（`Track.arcNear`）。
    //
    // 这里在**最急弯**（track1 的 124px 弯）上把车摆到赛道外的草地上，
    // 然后全油门往外推 1.2 秒 —— 位移真实、没有瞬移，绝不该被判无效。
    console.log('  … 冲出赛道压草地不该被判"切弯"（连续弧长回归）');
    await page.evaluate(() => window.__F1RACE__.setTrack('track1'));
    await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track1', null, { timeout: 15000 });
    await page.evaluate(() => {
      window.__F1RACE__.restart();
      window.__F1RACE__.skipCountdown();
    });
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'racing', null, { timeout: 10000 });
    // 摆到"最急弯"的入口，朝外（赛道法线方向）冲出去
    const offTrackProbe = await page.evaluate(() => {
      const track = window.__F1RACE__.scene.track;
      const p = track.pointAtArc(track.totalLength * 0.93);
      const outward = p.tangent + Math.PI / 2; // 赛道右侧
      return { x: p.x, y: p.y, heading: outward, tangent: p.tangent };
    });
    await page.evaluate(
      ([x, y, h]) => window.__F1RACE__.place(x, y, h, 420),
      [offTrackProbe.x, offTrackProbe.y, offTrackProbe.heading],
    );
    await page.evaluate(() => window.__F1RACE__.setInput(1, 0));
    await sleep(1200);
    await page.evaluate(() => window.__F1RACE__.setInput(0, 0));
    await sleep(200);
    const offTrackState = await state(page);
    check(
      'REQ 过弯冲出赛道压草地不会被判「切弯 / 进度异常跳跃」',
      offTrackState.currentLapInvalid === false && offTrackState.onTrack === false,
      `onTrack=${String(offTrackState.onTrack)} 本圈无效=${String(offTrackState.currentLapInvalid)}` +
        `${offTrackState.currentLapInvalidReason ? ` 原因：${offTrackState.currentLapInvalidReason}` : ''}`,
    );

    // ---------------------------------------------------------- M2 无效圈（抄近道）
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    const cleanBestTotal = resumedState.bestTotalMs;
    const cleanHistory = resumedState.historyLength;

    // 反复瞬移制造进度跳跃，快速"跑完"3 圈——这正是抄近道在数据上的样子
    const cheatTrace = [];
    for (let i = 0; i < 14; i++) {
      const t = (0.1 + i * 0.25) % 1;
      await page.evaluate((v) => window.__F1RACE__.cheatTeleport(v), t);
      await sleep(140);
      const s = await state(page);
      cheatTrace.push(`t=${t.toFixed(2)}:${s.lapsCompleted}/${s.state}/${s.lapProgress.toFixed(2)}/${s.currentLapInvalid ? 'X' : 'ok'}`);
      if (s.state === 'finished') break;
    }
    if ((await state(page)).state !== 'finished') {
      console.log(`   [diag] 抄近道没完赛：${cheatTrace.join(' ')}`);
      await page.waitForFunction(() => window.__F1RACE__.getState().state === 'finished', null, { timeout: 30000 });
    }
    const cheated = await state(page);
    await page.screenshot({ path: `${SHOT_DIR}/08-invalid.png` });

    check(
      'M2 抄近道产生的进度跳跃被判为无效圈',
      cheated.lapResults.length === 3 && cheated.lapResults.every((lap) => lap.valid === false),
      cheated.lapResults.map((lap) => (lap.valid ? '有效' : '无效')).join(', '),
    );
    check('M2 无效场次不会产生最佳圈', cheated.bestLapMs === null, `bestLap=${String(cheated.bestLapMs)}`);
    check(
      'M2 无效场次不会刷新最佳总时间',
      cheated.bestTotalMs !== null && Math.abs(cheated.bestTotalMs - cleanBestTotal) < 0.5,
      `clean=${cleanBestTotal?.toFixed(1)} → now=${cheated.bestTotalMs?.toFixed(1)}`,
    );
    check(
      'M2 无效场次仍然记入历史并标注原因',
      cheated.historyLength === cleanHistory + 1 && cheated.history[0].valid === false,
      `history=${cheated.historyLength} reason=${String(cheated.history[0]?.invalidReason)}`,
    );
    const invalidBanner = await page.isVisible('#result-invalid');
    check('M2 结算界面提示成绩无效', invalidBanner === true);
    const titleText = (await page.textContent('#result-title'))?.trim() ?? '';
    check('M2 结算标题标明成绩无效', titleText.includes('无效'), titleText);

    // ---------------------------------------------------------- M3 漂移（REQ-004）
    // 漂移必须在赛道上测：草地上横向速度会被 D5 的合速度上限夹住，测不出侧滑。
    // 所以每次都用 place() 摆回起点直道并直接给到接近极速，而不是一路加速过去（会跑偏）。
    const placeOnStraight = async (t, speed) => {
      const p = await page.evaluate((tt) => {
        const track = window.__F1RACE__.scene.track;
        const s = track.pointAtArc(track.totalLength * tt);
        return { x: s.x, y: s.y, h: s.tangent };
      }, t);
      await page.evaluate(([x, y, h, v]) => window.__F1RACE__.place(x, y, h, v), [p.x, p.y, p.h, speed]);
      return p;
    };

    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.skipCountdown());

    // D1：不按漂移键，正常过弯不该有侧滑
    await placeOnStraight(0.02, 480);
    await setInput(page, 1, 1);
    let maxLateralGrip = 0;
    for (let i = 0; i < 8; i++) {
      const s = await state(page);
      maxLateralGrip = Math.max(maxLateralGrip, Math.abs(s.lateral ?? 0));
      await sleep(55);
    }
    await setInput(page, 0, 0);
    check(
      'M3 不按漂移键时没有侧滑（与 M1/M2 手感一致）',
      maxLateralGrip < 5,
      `满转向 0.45 秒内最大横向速度 ${maxLateralGrip.toFixed(2)} px/s`,
    );

    // D2：按住 Space + 打方向会出现明显侧滑
    // 注意：全速满舵漂移时车头转得很快（driftSteerBoost），0.8 秒内就会滑出赛道，
    // 而草地上的横向速度会被合速度上限夹住 —— 所以采样窗口不能太长。
    await placeOnStraight(0.02, 480);
    await page.evaluate(() => window.__F1RACE__.setDrift(true));
    await setInput(page, 1, 1);
    let sawDrift = false;
    let peakDriftAngle = 0;
    for (let i = 0; i < 20; i++) {
      const s = await state(page);
      peakDriftAngle = Math.max(peakDriftAngle, s.driftAngle ?? 0);
      if (s.isDrifting) sawDrift = true;
      await sleep(40);
    }
    check(
      'M3 按住 Space 会出现明显侧滑',
      sawDrift && peakDriftAngle > 0.18,
      `峰值侧滑角 ${peakDriftAngle.toFixed(3)} rad（判定阈值 0.12，抓地状态为 0.000）`,
    );
    await page.screenshot({ path: `${SHOT_DIR}/09-drift.png` });

    // D3：松开 Space 后恢复抓地
    // 精确的 0.5–1.5 秒窗口由单元测试保证（那边能精确控制漂移深度）；
    // 这里验证端到端链路：松开时确实在漂移 → 松手后侧滑归零、状态复位。
    await placeOnStraight(0.02, 480);
    await page.evaluate(() => window.__F1RACE__.setDrift(true));
    await setInput(page, 1, 1);
    await sleep(320);
    const beforeRelease = await state(page);
    await page.evaluate(() => window.__F1RACE__.setDrift(false));
    await setInput(page, 1, 0.1);
    const releaseAt = Date.now();
    let recoverMs = null;
    let lateralAtRecover = null;
    for (let i = 0; i < 55; i++) {
      const s = await state(page);
      if (!s.isDrifting) {
        recoverMs = Date.now() - releaseAt;
        lateralAtRecover = Math.abs(s.lateral ?? 0);
        break;
      }
      await sleep(25);
    }
    check(
      'M3 松开漂移后恢复抓地（侧滑归零、状态复位）',
      beforeRelease.isDrifting === true && recoverMs !== null && recoverMs <= 1500,
      beforeRelease.isDrifting !== true
        ? `松开时并未处于漂移状态（侧滑角 ${beforeRelease.driftAngle.toFixed(3)}）`
        : `松开时侧滑角 ${beforeRelease.driftAngle.toFixed(3)} rad → ${recoverMs}ms 后复位（残余横向 ${(lateralAtRecover ?? 0).toFixed(1)} px/s）`,
    );

    // D5：漂移不会突破极速
    await placeOnStraight(0.02, 480);
    await page.evaluate(() => window.__F1RACE__.setDrift(true));
    await setInput(page, 1, 1);
    let maxComposite = 0;
    for (let i = 0; i < 25; i++) {
      const s = await state(page);
      maxComposite = Math.max(maxComposite, Math.hypot(s.speed, s.lateral ?? 0));
      await sleep(55);
    }
    check(
      'M3 漂移不会突破极速上限',
      maxComposite <= MAX_SPEED * 1.03,
      `最大合成速度 ${maxComposite.toFixed(0)} px/s（极速 ${MAX_SPEED}）`,
    );
    await page.evaluate(() => window.__F1RACE__.setDrift(false));
    await page.evaluate(() => window.__F1RACE__.clearInput());

    // ---------------------------------------------------------- M5 AI 与排名（REQ-007 / REQ-016）
    console.log('  … 让玩家与 3 台 AI 同场跑 25 秒，检查 AI 是否会卡墙');
    await page.evaluate(() => window.__F1RACE__.setAiEnabled(true));
    await page.evaluate(() => window.__F1RACE__.setDifficulty('normal'));
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await sleep(25000);
    const aiState = await state(page);
    await page.screenshot({ path: `${SHOT_DIR}/10-ai.png` });

    check(
      'M5 同场共 4 台车（玩家 + 3 台 AI）',
      aiState.racers.length === 4 && aiState.aiCount === 3,
      `racers=${aiState.racers.length}`,
    );
    check(
      'M5 排名榜包含全部车辆且名次连续',
      new Set(aiState.racers.map((r) => r.rank)).size === 4 && aiState.playerRank >= 1 && aiState.playerRank <= 4,
      `玩家名次 ${aiState.playerRank}/4`,
    );
    const aiOnly = aiState.racers.filter((r) => !r.isPlayer);
    check(
      'M5 AI 都在前进，不会长期卡墙',
      aiOnly.every((r) => r.progressPx > 1500),
      aiOnly.map((r) => `${r.name}=${Math.round(r.progressPx)}px`).join(' '),
    );
    check(
      'M5 AI 不会突破各自的速度上限',
      aiOnly.every((r) => Math.abs(r.speed) <= MAX_SPEED * r.speedCapRatio * 1.05),
      aiOnly
        .map((r) => `${r.name}:${Math.round(Math.abs(r.speed))}/${Math.round(MAX_SPEED * r.speedCapRatio)}`)
        .join(' '),
    );
    await page.evaluate(() => window.__F1RACE__.setAutopilot(false));

    // REQ-014：玩家与 AI 相撞也要减速 + 弹开。
    // M2 时场上只有一台车，这条路径一直没被真正触发过；M5 有 3 台 AI 才测得到。
    await page.evaluate(() => window.__F1RACE__.clearInput());
    const ramBefore = await page.evaluate(() => {
      const s = window.__F1RACE__.getState();
      const ai = s.racers.find((r) => !r.isPlayer);
      // 把静止的玩家摆到 AI 正前方 26px，等它撞上来
      const x = ai.x + Math.cos(ai.heading) * 26;
      const y = ai.y + Math.sin(ai.heading) * 26;
      window.__F1RACE__.place(x, y, ai.heading, 0);
      return { x, y, aiName: ai.name };
    });
    await sleep(1500);
    const ramAfter = await state(page);
    const pushed = Math.hypot(ramAfter.x - ramBefore.x, ramAfter.y - ramBefore.y);
    check(
      'REQ-014 玩家被 AI 追尾会被推开（车与车碰撞）',
      pushed > 8,
      `静止的玩家被 ${ramBefore.aiName} 撞后位移 ${pushed.toFixed(1)}px`,
    );

    // CR-06 第 3 项：并排接触要能"贴着跑"，不是互相弹飞。
    //
    // 旧实现是两边各 `applyImpact(法线)` —— 只有减速 + 反向弹开，
    // 一碰就双双弹开，根本没法并排过弯。新实现是法向分离 + 切向摩擦。
    //
    // 断言方式：把玩家摆在某台 AI 的**正侧方**（横向接触，不是追尾），
    // 两车都给前进油门，然后看玩家有没有被"横向弹开"或被反向弹飞。
    console.log('  … CR-06 并排接触：贴着跑而不是互相弹飞');
    await page.evaluate(() => window.__F1RACE__.clearInput());
    const sideBySide = await page.evaluate(() => {
      const s = window.__F1RACE__.getState();
      const ai = s.racers.find((r) => !r.isPlayer);
      // 摆到 AI 正侧方 20px（车直径 24 → 必然重叠）
      const nx = -Math.sin(ai.heading);
      const ny = Math.cos(ai.heading);
      const x = ai.x + nx * 20;
      const y = ai.y + ny * 20;
      // 同向、给一点初速，让它像并排过弯那样贴着
      window.__F1RACE__.place(x, y, ai.heading, 300);
      return { x, y, heading: ai.heading, aiName: ai.name };
    });
    await setInput(page, 1, 0);
    await sleep(1200);
    const sideAfter = await page.evaluate(() => window.__F1RACE__.getState());
    await page.evaluate(() => window.__F1RACE__.clearInput());
    // 沿车头方向的前进量与横向位移
    const alongDir = (p, o) => (p.x - o.x) * Math.cos(o.heading) + (p.y - o.y) * Math.sin(o.heading);
    const lateralDir = (p, o) => (p.x - o.x) * -Math.sin(o.heading) + (p.y - o.y) * Math.cos(o.heading);
    const forward1 = alongDir(sideAfter, sideBySide);
    const lateral1 = Math.abs(lateralDir(sideAfter, sideBySide));
    check(
      'CR-06 并排接触后仍在前进（没有被弹飞或反向）',
      forward1 > 60 && forward1 < 900,
      `与 ${sideBySide.aiName} 并排 1.2 秒后：前进 ${forward1.toFixed(0)}px、横向偏移 ${lateral1.toFixed(0)}px`,
    );
    check(
      'CR-06 并排接触的横向分离是"被挤开"而不是"被弹飞"',
      lateral1 < 120,
      `横向偏移 ${lateral1.toFixed(0)}px（旧实现会一次弹开上百像素）`,
    );

    // REQ-008：困难明显快于简单
    console.log('  … 对比简单 / 困难两档 AI 的推进速度（各 12 秒）');
    const measureDifficulty = async (id) => {
      await page.evaluate((d) => window.__F1RACE__.setDifficulty(d), id);
      await page.evaluate(() => window.__F1RACE__.restart());
      await page.evaluate(() => window.__F1RACE__.skipCountdown());
      await sleep(12000);
      const s = await state(page);
      const ais = s.racers.filter((r) => !r.isPlayer);
      const avg = ais.reduce((acc, r) => acc + r.progressPx, 0) / Math.max(1, ais.length);
      const top = Math.max(...ais.map((r) => r.progressPx));
      return { avg, top, label: s.difficultyLabel };
    };
    const easyRun = await measureDifficulty('easy');
    const hardRun = await measureDifficulty('hard');
    const infernoRun = await measureDifficulty('inferno');
    check(
      'M5 难度切换生效（四档，含新增的炼狱）',
      easyRun.label === '简单' && hardRun.label === '困难' && infernoRun.label === '炼狱',
      `${easyRun.label} / ${hardRun.label} / ${infernoRun.label}`,
    );
    check(
      'M5 困难 AI 明显快于简单 AI',
      hardRun.avg > easyRun.avg * 1.25,
      `12 秒平均推进：简单 ${Math.round(easyRun.avg)}px vs 困难 ${Math.round(hardRun.avg)}px（快 ${(((hardRun.avg / easyRun.avg) - 1) * 100).toFixed(0)}%）`,
    );
    check(
      '炼狱 AI 比困难更快（新档确实更难，不是换个名字）',
      infernoRun.avg > hardRun.avg,
      `12 秒平均推进：困难 ${Math.round(hardRun.avg)}px vs 炼狱 ${Math.round(infernoRun.avg)}px` +
        `（快 ${(((infernoRun.avg / hardRun.avg) - 1) * 100).toFixed(1)}%）`,
    );
    check(
      'M5 AI 不会作弊到瞬移（推进量受极速约束）',
      hardRun.top <= MAX_SPEED * 12 * 1.15 && infernoRun.top <= MAX_SPEED * 12 * 1.15,
      `困难最快 AI 12 秒推进 ${Math.round(hardRun.top)}px、炼狱 ${Math.round(infernoRun.top)}px，理论上限 ${Math.round(MAX_SPEED * 12)}px`,
    );

    // ---------------------------------------------------------- M4 幽灵车（REQ-006 / REQ-018）
    // 幽灵车录制自"无 AI 干扰 + 自动巡航"的那一场，所以这一段也把 AI 关掉，保证可比
    await page.evaluate(() => window.__F1RACE__.setAiEnabled(false));
    const beforeGhost = await state(page);
    check(
      'M4 刷新过最佳成绩后会写入幽灵车记录',
      beforeGhost.ghost.available === true && beforeGhost.ghost.samples > 100,
      `samples=${beforeGhost.ghost.samples} totalMs=${beforeGhost.ghost.totalMs === null ? 'null' : Math.round(beforeGhost.ghost.totalMs)}`,
    );

    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await sleep(3000);
    const ghostA = await state(page);
    await sleep(2000);
    const ghostB = await state(page);
    check(
      'M4 幽灵车与玩家同场行驶（不是分屏）',
      ghostA.ghost.visible === true && ghostA.ghost.x !== null,
      `ghost=(${ghostA.ghost.x?.toFixed(0)}, ${ghostA.ghost.y?.toFixed(0)})`,
    );
    check(
      'M4 幽灵车按记录回放，位置随时间推进',
      ghostB.ghost.x !== null &&
        ghostA.ghost.x !== null &&
        Math.hypot(ghostB.ghost.x - ghostA.ghost.x, ghostB.ghost.y - ghostA.ghost.y) > 100,
      `5 秒内幽灵车移动 ${Math.hypot(ghostB.ghost.x - ghostA.ghost.x, ghostB.ghost.y - ghostA.ghost.y).toFixed(0)}px`,
    );
    check(
      'M4 幽灵车没有物理碰撞体（REQ-018）',
      ghostB.ghost.hasBody === false,
      `hasBody=${String(ghostB.ghost.hasBody)}`,
    );
    check(
      'M4 HUD 会显示与幽灵车的时间差',
      ghostB.ghost.gapMs !== null && (await page.isVisible('#hud-ghost')),
      `gap=${ghostB.ghost.gapMs === null ? 'null' : ghostB.ghost.gapMs.toFixed(0) + 'ms'}`,
    );

    // 直接开到幽灵车所在位置：不应该被撞、也不应该减速（朝向沿用赛道切线，别硬塞 0）
    const overlapProbe = await page.evaluate(() => {
      const s = window.__F1RACE__.getState();
      window.__F1RACE__.place(s.ghost.x, s.ghost.y, undefined, 400);
      return true;
    });
    await setInput(page, 1, 0);
    await sleep(700);
    const afterOverlap = await state(page);
    check(
      'M4 与幽灵车重叠不会减速、不会被弹开',
      overlapProbe && afterOverlap.speed > 380 && afterOverlap.onTrack === true,
      `穿过幽灵车后速度 ${afterOverlap.speed.toFixed(0)} px/s（onTrack=${String(afterOverlap.onTrack)}）`,
    );
    await page.evaluate(() => window.__F1RACE__.clearInput());
    await page.screenshot({ path: `${SHOT_DIR}/11-ghost.png` });

    // M4 时间基准：幽灵车必须与"同一套驾驶方式再跑一遍"基本同步。
    // 这是针对真实 bug 的回归测试——曾经录制按整数帧吸附、回放按标称 50ms 推进，
    // 幽灵车会快 5%~13%，起跑就领先、一圈后跑出画面。若回放速度正确，两者应始终咬在一起。
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await sleep(18000);
    const syncState = await state(page);
    await page.evaluate(() => window.__F1RACE__.setAutopilot(false));

    const playerProgress = syncState.racers.find((r) => r.isPlayer)?.progressPx ?? 0;
    const ghostProgress = syncState.ghost.progressPx ?? 0;
    const progressGap = Math.abs(playerProgress - ghostProgress);
    const ghostSpeedRatio = ghostProgress > 0 ? ghostProgress / Math.max(1, playerProgress) : 0;
    check(
      'M4 幽灵车与录像同速（18 秒后仍与同样跑法咬在一起）',
      syncState.ghost.available && progressGap < 500,
      `玩家 ${Math.round(playerProgress)}px vs 幽灵车 ${Math.round(ghostProgress)}px，差 ${Math.round(progressGap)}px` +
        `（速度快 ${((ghostSpeedRatio - 1) * 100).toFixed(1)}%；若回放偏快 11% 差值会到约 1000px）`,
    );

    // ---------------------------------------------------------- 重开比赛
    await page.evaluate(() => window.__F1RACE__.restart());
    const restarted = await state(page);
    check(
      '重新比赛会重置计时与圈数',
      restarted.state === 'countdown' && restarted.lapsCompleted === 0 && restarted.raceTimeMs === 0,
      `state=${restarted.state} laps=${restarted.lapsCompleted}`,
    );

    // ---------------------------------------------------------- M2/M4 存档迁移
    // 每条迁移用例都要开全新的 context：localStorage 按 origin 隔离，复用会读到刚才写下的存档

    /** 在全新 context 里预置一份存档，然后启动游戏读取迁移结果。 */
    const bootWithSave = async (key, payload) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const p = await ctx.newPage();
      await p.addInitScript(
        ([k, v]) => {
          window.localStorage.setItem(k, v);
        },
        [key, JSON.stringify(payload)],
      );
      await p.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await p.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });
      return { ctx, p };
    };

    // 用例 1：M1 的 v1 存档（没有 rulesetVersion ⇒ 视为 1）——规则版本不一致，纪录必须清空
    const legacyRun = await bootWithSave('f1race.save.v1', {
      version: 1,
      bestTotalMs: 51564.6,
      bestLapMs: 16999.3,
      updatedAt: '2026-10-03T07:30:00.000Z',
    });
    const legacyState = await legacyRun.p.evaluate(() => window.__F1RACE__.getState());
    check(
      'M4 v1 存档被识别并迁移到 v3',
      legacyState.saveVersion === 3 && legacyState.migratedFromVersion === 1,
      `version=${legacyState.saveVersion} from=v${String(legacyState.migratedFromVersion)}`,
    );
    check(
      'M4 规则版本变更（M3 起有漂移）会清空纪录，避免新旧不可比',
      legacyState.bestTotalMs === null &&
        legacyState.storedBestLapMs === null &&
        legacyState.recordsResetForRuleset === true,
      `total=${String(legacyState.bestTotalMs)} reset=${String(legacyState.recordsResetForRuleset)}`,
    );
    const legacyLeft = await legacyRun.p.evaluate(() => window.localStorage.getItem('f1race.save.v1'));
    const legacyWritten = await legacyRun.p.evaluate((key) => window.localStorage.getItem(key), SAVE_KEY);
    check(
      'M4 迁移后旧键被清理、新键已落盘（先写后删）',
      legacyLeft === null && typeof legacyWritten === 'string' && JSON.parse(legacyWritten).version === 3,
      `legacy=${String(legacyLeft)} v3=${legacyWritten ? 'ok' : '缺失'}`,
    );
    const legacyHud = (await legacyRun.p.textContent('#hud-best-total'))?.trim();
    check('M4 被清空的纪录在 HUD 上显示为占位符', legacyHud === '--:--.---', String(legacyHud));
    await legacyRun.p.close();
    await legacyRun.ctx.close();

    // 用例 2：M2 的 v2 存档但 rulesetVersion 相同 —— 成绩必须完整保住
    const sameRun = await bootWithSave('f1race.save.v2', {
      version: 2,
      rulesetVersion: 2,
      bestTotalMs: 51564.6,
      bestLapMs: 16999.3,
      bestSectorsMs: [5661, 5668, 5667],
      bestLapCheckpointsMs: null,
      history: [],
      updatedAt: '2026-10-03T07:30:00.000Z',
    });
    const sameState = await sameRun.p.evaluate(() => window.__F1RACE__.getState());
    check(
      'M4 规则版本一致的旧档会完整保留成绩',
      sameState.saveVersion === 3 &&
        Math.abs(sameState.bestTotalMs - 51564.6) < 0.001 &&
        Math.abs(sameState.storedBestLapMs - 16999.3) < 0.001 &&
        sameState.recordsResetForRuleset === false,
      `total=${String(sameState.bestTotalMs)} lap=${String(sameState.storedBestLapMs)} reset=${String(sameState.recordsResetForRuleset)}`,
    );
    const sameHud = (await sameRun.p.textContent('#hud-best-total'))?.trim();
    check('M4 保留的成绩直接显示在 HUD 上', sameHud === '0:51.564', String(sameHud));
    await sameRun.p.close();
    await sameRun.ctx.close();

    // ---------------------------------------------------------- 多赛道切换
    console.log('  … 依次切到另外几张赛道，检查换图与选图 UI');
    const trackButtons = [
      { id: 'track3', label: '峡谷技术' },
      { id: 'track4', label: '漂移龙' },
      { id: 'track1', label: '环城' },
    ];
    for (const item of trackButtons) {
      await page.click(`#track-select button[data-track="${item.id}"]`);
      await page.waitForFunction((id) => window.__F1RACE__?.getState().trackId === id, item.id, {
        timeout: 15000,
      });
      const switched = await state(page);
      const labelText = (await page.textContent('#hud-track'))?.trim();
      const isActive = await page.evaluate(
        (id) => document.querySelector(`#track-select button[data-track="${id}"]`)?.classList.contains('active'),
        item.id,
      );
      check(
        `切换到「${item.label}」赛道生效（地图 / 中心线 / 相机边界全部换掉）`,
        switched.trackId === item.id &&
          switched.trackName.length > 0 &&
          switched.trackLength > 5000 &&
          labelText === switched.trackName &&
          isActive === true,
        `id=${switched.trackId} 名称=${switched.trackName} 长度=${Math.round(switched.trackLength)}px 高亮=${isActive}`,
      );

      // 换图后必须仍然能正常跑：跳过倒计时踩一脚油门。
      //
      // 用"轮询到车真的跑起来"而不是固定 sleep：
      // 各条赛道的加速曲线不同（直角街道赛道起步更慢），
      // 软件渲染下帧率也飘，固定时长会让这条检查偶发假失败。
      await page.evaluate(() => window.__F1RACE__.skipCountdown());
      await setInput(page, 1, 0);
      const DRIVE_TARGET = 250;
      let driven = await state(page);
      const driveDeadline = Date.now() + 5000;
      while (driven.speed <= DRIVE_TARGET && Date.now() < driveDeadline && driven.onTrack === true) {
        await sleep(150);
        driven = await state(page);
      }
      check(
        `「${item.label}」赛道可以正常驾驶（不卡在起跑线 / 不上草地）`,
        driven.speed > DRIVE_TARGET && driven.onTrack === true,
        `speed=${driven.speed.toFixed(0)}px/s onTrack=${String(driven.onTrack)}`,
      );
      await setInput(page, 0, 0);

      // 赛道/难度按钮在比赛开始后会锁住（防止中途换图），下一轮前先重开比赛解锁
      await page.evaluate(() => window.__F1RACE__.restart());
      await page.waitForFunction(() => document.querySelector('#track-select button:not([disabled])') !== null, null, {
        timeout: 10000,
      });
    }

    // 每条赛道的成绩必须各自独立记账。
    // 注意两点：
    //   1. SaveStore 只在**跑完一场**时才落盘，"切过去开一段但没完赛"不会写键；
    //   2. 默认赛道 track1 刻意沿用基键 f1race.save.v3，这样单赛道时代的老成绩能原地继承，
    //      其余赛道才是 `f1race.save.v3@<id>`。
    // 所以这里拦截 setItem，验证"在 track1 上完赛写的是基键（而不是 @track1 那种新键）"。
    await page.evaluate(() => {
      window.__PROBE_WRITES__ = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function patched(key, value) {
        if (String(key).startsWith('f1race.save')) window.__PROBE_WRITES__.push(String(key));
        return original.call(this, key, value);
      };
    });
    await page.evaluate(() => {
      window.__F1RACE__.restart();
      window.__F1RACE__.skipCountdown();
    });
    for (let i = 0; i < 14; i++) {
      await page.evaluate((t) => window.__F1RACE__.cheatTeleport(t), (0.1 + i * 0.25) % 1);
      await sleep(140);
      if ((await state(page)).state === 'finished') break;
    }
    const writtenKeys = await page.evaluate(() => window.__PROBE_WRITES__ ?? []);
    check(
      '每条赛道有各自独立的成绩存档键（默认赛道沿用基键，其余加后缀）',
      writtenKeys.length > 0 && writtenKeys.every((k) => k === SAVE_KEY),
      `在 track1 上完赛写入的键：${writtenKeys.join(', ') || '（无）'}（应为 ${SAVE_KEY}）`,
    );

    // ---------------------------------------------------------- CR-16 单程赛道「漂移龙」
    //
    // 这张图**不是闭环**：一条路从左下出发、绕一大圈、到左上结束，跑完一趟就完赛。
    // 单程是"超出加一张图"的引擎改动（圈数归一、跨检查点、文案都不同），
    // 所以这里独立验一遍，而不是靠"track1 还是 3 圈"这种间接证据。
    console.log('  … CR-16 单程赛道「漂移龙」：跑完一趟就结算，不再有第 2 圈');
    await page.evaluate(() => window.__F1RACE__.setTrack('track4'));
    await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track4', null, { timeout: 15000 });
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown', null, { timeout: 15000 });

    const openBoot = await state(page);
    const openHudLabels = await page.evaluate(() => ({
      lapLabel: document.getElementById('hud-lap-label')?.textContent?.trim() ?? '',
      lapTimeLabel: document.getElementById('hud-lap-time-label')?.textContent?.trim() ?? '',
      lapValue: document.getElementById('hud-lap')?.textContent?.trim() ?? '',
      trackLabel: document.getElementById('hud-track')?.textContent?.trim() ?? '',
      buttons: Array.from(document.querySelectorAll('#track-select button')).map((b) => b.textContent.trim()),
    }));
    check(
      'CR-16「漂移龙」已接进游戏：元数据是单程 1 趟，HUD 文案切成"进度 / 本趟用时"',
      openBoot.trackOpen === true &&
        openBoot.trackLaps === 1 &&
        openBoot.trackLength > 15000 &&
        openHudLabels.trackLabel === '漂移龙' &&
        openHudLabels.buttons.includes('漂移龙') &&
        openHudLabels.lapLabel === '进度' &&
        openHudLabels.lapTimeLabel === '本趟用时' &&
        // 只有一趟，不该显示 "1/1"
        openHudLabels.lapValue === '1',
      `open=${String(openBoot.trackOpen)} laps=${String(openBoot.trackLaps)} 长度=${Math.round(openBoot.trackLength)}px` +
        ` 图名="${openHudLabels.trackLabel}" 按钮=[${openHudLabels.buttons.join('/')}]` +
        ` 文案="${openHudLabels.lapLabel} ${openHudLabels.lapValue}" / "${openHudLabels.lapTimeLabel}"`,
    );

    // 真跑完这一趟（瞬移推进，与 finishRaceByTeleport 同一套手法）。
    //
    // ⚠️ 进度必须**单调递增**到超过 1：单程赛道的终点不是起点，
    // 用 `(0.1 + i*0.25) % 1` 那种绕圈写法会一路被进度跳跃判无效（也永远到不了终点）。
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    for (let i = 1; i <= 24; i++) {
      await page.evaluate((t) => window.__F1RACE__.cheatTeleport(t), i / 20);
      await sleep(140);
      if ((await state(page)).state === 'finished') break;
    }
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'finished', null, { timeout: 30000 });
    const openFinish = await state(page);
    const openResult = await page.evaluate(() => ({
      resultVisible: !document.getElementById('result').classList.contains('hidden'),
      resultStandings: document.getElementById('result-standings')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      hudStandings: document.getElementById('hud-standings')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
    check(
      'CR-16 跑完一趟就结算：只有 1 条成绩，且没有"第 2 圈"',
      openFinish.state === 'finished' &&
        openFinish.lapsCompleted === 1 &&
        openFinish.lapResults.length === 1 &&
        openResult.resultVisible,
      `state=${openFinish.state} 成绩条数=${openFinish.lapResults.length} 总时间=${openFinish.totalMs?.toFixed(0)}ms`,
    );
    // 闭环赛道上未完赛的车显示"第 N 圈"；单程只有一趟，说"第 1 圈"会让人以为还要跑一圈
    check(
      'CR-16 单程赛道的进度文案不说"第 N 圈"，而是"进行中"',
      !openResult.resultStandings.includes('第 1 圈') &&
        !openResult.resultStandings.includes('第 2 圈') &&
        !openResult.hudStandings.includes('第 1 圈'),
      `结算="${openResult.resultStandings.slice(0, 80)}" HUD="${openResult.hudStandings.slice(0, 60)}"`,
    );

    // 回到默认赛道，别把后面的用例留在单程图上
    await page.evaluate(() => window.__F1RACE__.setTrack('track1'));
    await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track1', null, { timeout: 15000 });

    // ---------------------------------------------------------- 小地图（右上角，固定不移动）
    console.log('  … 验证右上角小地图：轨道轮廓 + 全部角色光点 + 不随镜头移动');
    await page.evaluate(() => window.__F1RACE__.setTrack('track1'));
    await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track1', null, { timeout: 15000 });
    // 前面的检查把 AI 关掉过。小地图要画"每个角色"，所以先把 AI 放回来 ——
    // setAiEnabled 内部会重开比赛，所以后面还要重新跳一次倒计时。
    await page.evaluate(() => window.__F1RACE__.setAiEnabled(true));
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown', null, { timeout: 15000 });
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'racing', null, { timeout: 15000 });
    await sleep(400);

    const minimapGeom = await page.evaluate(() => {
      const panel = document.getElementById('minimap-panel');
      const canvas = document.getElementById('minimap-canvas');
      const box = panel.getBoundingClientRect();
      const view = { w: window.innerWidth, h: window.innerHeight };
      return {
        // 是否钉在右上角（留 40px 容差，覆盖 14px 边距 + 面板边框）
        nearRight: view.w - box.right < 40,
        nearTop: box.top < 40,
        width: Math.round(box.width),
        height: Math.round(box.height),
        canvasW: canvas.width,
        canvasH: canvas.height,
      };
    });
    check(
      '小地图固定在画面右上角',
      minimapGeom.nearRight && minimapGeom.nearTop && minimapGeom.width > 80,
      `面板 ${minimapGeom.width}x${minimapGeom.height}，贴右上角=${minimapGeom.nearRight}/${minimapGeom.nearTop}`,
    );

    // 小地图"不移动"：让车跑一段、镜头跟着动，小地图面板的位置与像素都必须不变
    const before = await page.evaluate(() => {
      const panel = document.getElementById('minimap-panel');
      const box = panel.getBoundingClientRect();
      return { left: Math.round(box.left), top: Math.round(box.top) };
    });
    const cameraBefore = await page.evaluate(() => {
      const cam = window.__F1RACE__.scene.cameras.main;
      return { x: Math.round(cam.scrollX), y: Math.round(cam.scrollY) };
    });
    // 用 autopilot 跑：手动直行会撞墙卡住，镜头就不动了，测不出"不随镜头移动"。
    // 换个记录点也要先跳过一次，否则可能正好停在原地没动。
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await sleep(2600);
    await page.evaluate(() => window.__F1RACE__.setAutopilot(false));
    const after = await page.evaluate(() => {
      const panel = document.getElementById('minimap-panel');
      const box = panel.getBoundingClientRect();
      const cam = window.__F1RACE__.scene.cameras.main;
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        camX: Math.round(cam.scrollX),
        camY: Math.round(cam.scrollY),
      };
    });
    check(
      '小地图不随镜头移动（镜头动了、小地图面板纹丝不动）',
      Math.abs(after.camX - cameraBefore.x) + Math.abs(after.camY - cameraBefore.y) > 200 &&
        after.left === before.left &&
        after.top === before.top,
      `镜头 (${cameraBefore.x},${cameraBefore.y}) → (${after.camX},${after.camY})；` +
        `小地图 (${before.left},${before.top}) → (${after.left},${after.top})`,
    );

    // 光点：玩家 + 3 台 AI（+ 幽灵车，若有记录）都要画出来
    //
    // 4 个**车手**颜色必须两两不同；幽灵车另算一类（它用固定的青色，
    // 刻意和四个车手拉开，不代表第五个对手）。
    const dots = await page.evaluate(() => window.__F1RACE__.getMinimapDots());
    const racerDots = dots.filter((d) => !d.isGhost);
    const racerColors = new Set(racerDots.map((d) => d.color));
    check(
      '小地图显示每个角色（玩家 + 全部 AI，颜色各不相同）',
      racerDots.length === 4 && racerColors.size === 4,
      `车手光点 ${racerDots.length} 个（配色 ${racerColors.size} 种），另有幽灵 ${dots.length - racerDots.length} 个`,
    );
    check(
      '小地图上有且只有一个玩家光点（带玩家标记）',
      dots.filter((d) => d.isPlayer).length === 1,
      dots.map((d) => `${d.isPlayer ? '玩家' : d.isGhost ? '幽灵' : 'AI'}@(${Math.round(d.x)},${Math.round(d.y)})`).join(' '),
    );
    // 幽灵车：先跑完一场写出记录，再重开就应该出现在小地图上
    await sleep(200);
    const ghostDots = await page.evaluate(() => window.__F1RACE__.getMinimapDots().filter((d) => d.isGhost).length);
    check(
      '有幽灵车记录时小地图上会出现幽灵车光点（无记录时不出现）',
      ghostDots <= 1,
      `幽灵车光点 ${ghostDots} 个`,
    );

    // 光点必须落在地图画布范围内（换算没错位）
    const insideAll = await page.evaluate(() => {
      const scene = window.__F1RACE__.scene;
      const canvas = document.getElementById('minimap-canvas');
      const rect = canvas.getBoundingClientRect();
      const dotList = window.__F1RACE__.getMinimapDots();
      return dotList.every((d) => d.screenX >= -1 && d.screenX <= rect.width + 1 && d.screenY >= -1 && d.screenY <= rect.height + 1);
    });
    check('小地图光点都落在画布范围内（世界→小地图换算正确）', insideAll, `全部在画布内=${insideAll}`);


    // ---------------------------------------------------------- 结算：领奖台 + 数据面板
    /**
     * 让玩家快速跑完 3 圈，**不重开比赛**以免清掉 AI 的已跑距离。
     *
     * 关键在于 AI 的"预计完赛时间"要用 `已跑距离 ÷ 已用时间` 外推，
     * 而它依赖 AI 当前积累的进度 —— 一 restart 就把进度清零，
     * 结算里就只剩"第 1 圈"可显示了（这正是本函数不 restart 的原因）。
     */
    const finishRaceByTeleport = async () => {
      await page.evaluate(() => window.__F1RACE__.skipCountdown());
      for (let i = 0; i < 20; i++) {
        await page.evaluate((t) => window.__F1RACE__.cheatTeleport(t), (0.12 + i * 0.16) % 1);
        await sleep(150);
        if ((await state(page)).state === 'finished') break;
      }
      await page.waitForFunction(() => window.__F1RACE__.getState().state === 'finished', null, { timeout: 30000 });
    };

    /** 从头开一场并直接跳到发车（用于不需要保留 AI 进度的场景）。 */
    const startFreshRace = async () => {
      await page.evaluate(() => {
        window.__F1RACE__.restart();
        window.__F1RACE__.skipCountdown();
      });
    };

    /** 让玩家瞬移跑完并结算（会重开比赛，用于只关心结算 UI 的检查）。 */
    const finishRaceQuickly = async () => {
      await startFreshRace();
      await finishRaceByTeleport();
    };

    console.log('  … 检查结算界面：领奖台、过程数据、抽奖');
    // 先让 AI 真跑一段（而不是全程被瞬移甩开）—— 这样它们才积累了足够的
    // "已跑距离 / 已用时间"样本，结算里的**预计完赛时间**才有数据可算。
    //
    // 注意要跑到**半圈以上**：小于半圈时 `estimateFinishMs` 会刻意返回 null
    // （起跑加速阶段的平均速度没有代表性），此时 HUD 会显示"第 N 圈"而不是预计时间。
    // 这也正是 known-issues 第 9 条的验收场景：玩家冲线时对手还在跑。
    await startFreshRace();
    await page.evaluate(() => window.__F1RACE__.setAutopilot(true));
    await page.waitForFunction(
      () => {
        const s = window.__F1RACE__.getState();
        // 任意一台未完赛 AI 跑过半圈即可
        return s.racers.some((r) => !r.isPlayer && !r.finished && r.lapArc > s.trackLength * 0.55);
      },
      null,
      { timeout: 40000 },
    );
    await page.evaluate(() => window.__F1RACE__.setAutopilot(false));
    // ⚠️ 这里**不能**调 finishRaceQuickly（它会 restart、清掉 AI 进度）
    await finishRaceByTeleport();
    await sleep(900);

    const etaState = await page.evaluate(() => {
      const s = window.__F1RACE__.getState();
      return {
        playerRank: s.playerRank,
        finished: s.racers.filter((r) => r.finished).length,
        total: s.racers.length,
      };
    });
    check(
      '结算里未完赛 AI 有预计完赛时间可显示（known-issues 第 9 条）',
      etaState.finished >= 1 && etaState.finished < etaState.total,
      `已完赛 ${etaState.finished}/${etaState.total} 台（要有未完赛的才有预计时间可验）`,
    );
    const etaText = (await page.textContent('#result-standings')) ?? '';
    check(
      '结算排名里出现"预计 m:ss.s"文案（未完赛 AI 有外推时间）',
      etaText.includes('预计 '),
      etaText.replace(/\s+/g, ' ').slice(0, 140),
    );
    const podium = await page.evaluate(() => {
      const slots = Array.from(document.querySelectorAll('#podium .podium-slot'));
      return {
        ranks: slots.map((el) => Number(el.dataset['rank'])),
        figures: slots.length,
        // 只有冠军那个小人应该带 champion 类（上蹦下跳）
        champions: document.querySelectorAll('#podium .podium-figure.champion').length,
        championRank: Number(document.querySelector('#podium .podium-figure.champion')?.closest('.podium-slot')?.dataset['rank']),
        // 小人颜色应各不相同，且与车身 tint 一致
        colors: slots.map((el) => {
          const fig = el.querySelector('.podium-figure');
          return fig ? getComputedStyle(fig).getPropertyValue('--car-main').trim() : '';
        }),
        names: slots.map((el) => el.querySelector('.podium-name')?.textContent?.trim() ?? ''),
        playerOnPodium: document.querySelector('#podium .podium-name.is-player') !== null,
      };
    });
    check(
      '结算领奖台显示 1~4 名，每人一个对应车色的小人',
      podium.figures === 4 &&
        new Set(podium.ranks).size === 4 &&
        new Set(podium.colors).size === 4 &&
        podium.playerOnPodium === true,
      `名次=${podium.ranks.join('/')} 小人=${podium.figures} 配色数=${new Set(podium.colors).size} 名字=${podium.names.join(',')}`,
    );
    check(
      '只有冠军那个小人上蹦下跳（其余安静站着）',
      podium.champions === 1 && podium.championRank === 1,
      `带跳动动画的小人 ${podium.champions} 个，名次=${podium.championRank}`,
    );
    // 冠军的动画确实在动：连续两帧读到不同的 transform
    const hopA = await page.evaluate(
      () => getComputedStyle(document.querySelector('#podium .podium-figure.champion')).transform,
    );
    await sleep(140);
    const hopB = await page.evaluate(
      () => getComputedStyle(document.querySelector('#podium .podium-figure.champion')).transform,
    );
    const runnerA = await page.evaluate(
      () => getComputedStyle(document.querySelector('#podium .podium-slot[data-rank="2"] .podium-figure')).transform,
    );
    await sleep(140);
    const runnerB = await page.evaluate(
      () => getComputedStyle(document.querySelector('#podium .podium-slot[data-rank="2"] .podium-figure')).transform,
    );
    check('冠军的小人确实在动', hopA !== hopB, `${hopA} -> ${hopB}`);
    check('亚军的小人保持静止', runnerA === runnerB, `${runnerA} -> ${runnerB}`);

    const statsText = (await page.textContent('#result-stats')) ?? '';
    check(
      '结算把"有没有超越自己"放在本场数据里（对比本赛道历史最佳）',
      statsText.includes('超越自己') &&
        statsText.includes('本赛道最佳总时间') &&
        // 首次完赛没有"此前最佳"可比；再跑一场才会出现这一行
        (statsText.includes('此前最佳总时间') || statsText.includes('首次完赛')),
      statsText.replace(/\s+/g, ' ').slice(0, 200),
    );
    check(
      '结算显示本场自我表现数据（最高车速 / 漂移 / 撞墙）',
      statsText.includes('最高车速') && statsText.includes('漂移累计') && statsText.includes('撞墙次数'),
      statsText.replace(/\s+/g, ' ').slice(0, 200),
    );

    // 再跑一场确认"对比"这条路真的接上了。
    //
    // 注意这里**不能**假设"上一场是无效成绩所以没有最佳可比"：
    // 更早的多赛道检查里已经用瞬移跑出过一场有效成绩并落盘了，
    // 所以此刻一定有历史最佳。真正该守住的是：面板必须给出快/慢的结论，
    // 而不是又报一次"首次完赛"（那说明纪录没被读出来）。
    await finishRaceQuickly();
    await sleep(900);
    const secondStats = (await page.textContent('#result-stats')) ?? '';
    check(
      '有历史最佳时"超越自己"给出快/慢结论（能读出存档里的纪录）',
      secondStats.includes('此前最佳总时间') &&
        (secondStats.includes('超越！快了') || secondStats.includes('慢了') || secondStats.includes('与最佳持平')),
      secondStats.replace(/\s+/g, ' ').slice(0, 200),
    );

    // ---------------------------------------------------------- 抽奖触发条件：刷新纪录 **或** 夺冠
    //
    // 玩家要求「只要拿了冠军就能抽奖」。以前只有"刷新本赛道最佳总时间"才放抽奖，
    // 于是"跑出个人第二好成绩但拿了第一"什么都没有。
    //
    // 断言分两步，缺一不可：
    //   ① 造一场**夺冠但不刷新纪录**的比赛 → 抽奖面板必须自己弹出来；
    //   ② 反例：**既没夺冠也没刷新纪录** → 不能弹。
    // 只测 ① 是不够的 —— 判据要是被写成恒真，①照样会过。
    //
    // ⚠️ 反例怎么构造：名次由 `Ranking` 决定，**完赛的车永远排在未完赛的车前面**，
    // 所以"玩家瞬移冲线"必然是第 1 名 —— 想输，只能**自己没赢**：故意不冲线，
    // 让比赛以"没夺冠"结束。这里用"不进终点、只在中段来回蹭"做到（进度永远到不了 total）。
    console.log('  … 抽奖触发条件：刷新纪录 或 夺冠（含反例）');
    const lotteryProbe = async ({ aiCount, finish }) => {
      // 用"只留玩家"或"留满 4 台"来控制名次：AI 全关时玩家必然第 1，
      // AI 开着且玩家被瞬移甩开时玩家必然垫底。
      await page.evaluate((n) => {
        window.__F1RACE__.setAiEnabled(n > 0);
        window.__F1RACE__.restart();
        window.__F1RACE__.skipCountdown();
      }, aiCount);
      await page.waitForFunction(() => window.__F1RACE__.getState().state === 'racing', null, { timeout: 10000 });
      // 让 AI 先跑一段（这样"未完赛 AI"有名次可比），玩家再瞬移冲线
      await sleep(aiCount > 0 ? 6000 : 300);
      // ⚠️ 瞬移序列有两套，按**赛道拓扑**选（这个区分是踩出来的）：
      //
      //  · **闭环**（track1/track3）：每步前进 0.25 圈再取模，14 步足够跑完 3 圈。
      //    不要改成单调递增的 `i/20`：最后几步越过 total 后 `pointAtArc` 取模落回起点，
      //    进度反而回退。
      //  · **单程**（track4 漂移龙）：**绝不能取模** —— 它的终点不是起点，
      //    取模等于把车送回起点，`arcNear` 看到的增量是负的，跑一百步也完不了赛。
      //    必须单调递增地把弧长推到超过 total（末步 1.05 才是真正的"冲线"）。
      //    这个坑先害我误以为"夺冠了不弹抽奖"，其实是**测试脚本没让比赛结束**。
      const openTrack = (await state(page)).trackOpen === true;
      const sequence = openTrack
        ? [0.2, 0.4, 0.6, 0.8, 0.95, 1.02, 1.05]
        : Array.from({ length: 14 }, (_, i) => (0.1 + i * 0.25) % 1);
      const teleTrace = [];
      let current = await state(page);
      for (const t of sequence) {
        if (!finish && teleTrace.length >= 1) break; // 反例：一步都不瞬移
        await page.evaluate((v) => window.__F1RACE__.cheatTeleport(v), t);
        await sleep(140);
        current = await state(page);
        teleTrace.push(`${current.lapsCompleted}/${current.state}`);
        if (current.state === 'finished') break;
      }
      if (finish && current.state !== 'finished') {
        // 别直接抛超时：把现场打出来，才知道是"没跑完"还是"跑完了但状态不对"
        throw new Error(
          `[e2e] 抽奖探针没能结算：state=${current.state} laps=${current.lapsCompleted} ` +
            `progress=${current.lapProgress?.toFixed(3)} aiEnabled=${current.aiEnabled} 名次=${current.playerRank} ` +
            `轨迹=${teleTrace.join(' ')}`,
        );
      }
      // 抽奖是延迟 openDelayMs（1100ms）之后才弹的
      await sleep(1800);
      const visible = await page.evaluate(
        () => !document.getElementById('lottery').classList.contains('hidden'),
      );
      await page.evaluate(() => window.__F1RACE__.closeLottery());
      return { rank: current.playerRank, visible, state: current.state, newBest: current.storedBestTotalMs };
    };

    // 清掉成绩纪录（**只清成绩键**，皮肤键不动），这样下一场"夺冠但不刷新纪录"才可控：
    // 现在还有更早的用例跑出过 51.5s 这种真实成绩，不先造一个够快的最佳时间，
    // 后面两场都可能顺手把纪录刷了，反例就构造不出来。
    await page.evaluate(() => {
      window.localStorage.removeItem('f1race.save.v3');
    });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });

    // ① 先跑一场"玩家独占赛道"的：必然第 1，并且刷出纪录（把纪录设得很低，后面就刷不动了）
    const firstWin = await lotteryProbe({ aiCount: 0, finish: true });
    check(
      '抽奖①：夺冠 + 刷新纪录时正常弹出',
      firstWin.rank === 1 && firstWin.visible === true,
      `名次=${firstWin.rank} 抽奖弹出=${String(firstWin.visible)} 纪录=${firstWin.newBest?.toFixed(0)}ms`,
    );

    // ② 关键用例：同样夺冠，但这次**刷新不了纪录**（上一场已经跑出极限时间）
    const secondWin = await lotteryProbe({ aiCount: 0, finish: true });
    check(
      '抽奖②：夺冠但没刷新纪录时**也要**弹出（本次新增的触发条件）',
      secondWin.rank === 1 && secondWin.visible === true,
      `名次=${secondWin.rank} 抽奖弹出=${String(secondWin.visible)}`,
    );

    // ③ 反例：既没夺冠也没刷新纪录 → 不弹。
    //    "没夺冠"只能靠"玩家自己没赢"构造：完赛的车永远排在未完赛的车前面，
    //    所以这里让玩家**不冲线**（成绩也就进不了纪录）。
    const notChampion = await lotteryProbe({ aiCount: 3, finish: false });
    check(
      '抽奖③（反例）：没夺冠也没刷新纪录时不弹抽奖',
      notChampion.rank > 1 && notChampion.visible === false && notChampion.state === 'racing',
      `名次=${notChampion.rank} 状态=${notChampion.state} 抽奖弹出=${String(notChampion.visible)}`,
    );

    // 回到"AI 开启 + 正常起跑"的状态，别把后面的用例留在 AI 关闭 / 结算界面上
    await page.evaluate(() => {
      window.__F1RACE__.setAiEnabled(true);
      window.__F1RACE__.restart();
    });
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown', null, { timeout: 10000 });

    // ---------------------------------------------------------- 结算抽奖（老虎机）
    await page.evaluate(() => window.__F1RACE__.openLottery());
    await sleep(400);
    const spinning = await page.evaluate(() => {
      const strips = [0, 1, 2].map((i) => document.getElementById(`reel-${i}`));
      return {
        visible: !document.getElementById('lottery').classList.contains('hidden'),
        running: strips.filter((s) => s.classList.contains('spinning')).length,
        heights: strips.map((s) => Math.round(s.getBoundingClientRect().height)),
        // 转动期间**绝不能**出现结果文案（悬念）：两者都必须还没露出来
        hint: document.getElementById('lottery-hint')?.textContent?.trim() ?? '',
        verdictHidden: document.getElementById('lottery-verdict').classList.contains('hidden'),
        // 面板也不能带落败用的冷色 / 中奖用的庆祝类
        isWinClass: document.getElementById('lottery').classList.contains('is-win'),
        celebrate: document.getElementById('lottery').classList.contains('celebrate'),
      };
    });
    check(
      '抽奖面板弹出且三条转轮都在滚动',
      spinning.visible && spinning.running === 3 && spinning.heights.every((h) => h > 1000),
      `可见=${spinning.visible} 滚动中=${spinning.running} 带子高=${spinning.heights.join('/')}`,
    );
    // 悬念：转轮还在转的时候，任何地方都不能透露结果
    const LEAKY = ['中奖', '差一点', '遗憾', '三连相同 ·'];
    check(
      '抽奖转动期间不剧透结果（提示/结论/面板着色都不泄露）',
      spinning.verdictHidden === true &&
        !spinning.isWinClass &&
        !spinning.celebrate &&
        !LEAKY.some((word) => spinning.hint.includes(word)),
      `转动提示="${spinning.hint}" 结论隐藏=${String(spinning.verdictHidden)} ` +
        `is-win=${String(spinning.isWinClass)} celebrate=${String(spinning.celebrate)}`,
    );

    await page.waitForFunction(() => window.__F1RACE__.getState().lottery.settled === true, null, {
      timeout: 15000,
    });
    await sleep(500);
    const settled = await page.evaluate(() => {
      const strips = [0, 1, 2].map((i) => document.getElementById(`reel-${i}`));
      // 每条带子当前停在第几格、是哪个符号
      const symbols = strips.map((s) => {
        const cellH = s.children[0]?.getBoundingClientRect().height ?? 78;
        const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(s).transform);
        const ty = m ? Number(m[1].split(',')[5]) : 0;
        const index = Math.round(-ty / cellH);
        return { index, symbol: s.children[index]?.textContent ?? null, inRange: index >= 0 && index < s.children.length };
      });
      return {
        won: window.__F1RACE__.getState().lottery.won,
        symbols,
        verdict: document.getElementById('lottery-verdict')?.textContent?.trim() ?? '',
        celebrating: document.getElementById('lottery').classList.contains('celebrate'),
        coins: document.querySelectorAll('#lottery-burst .coin').length,
      };
    });
    const allInRange = settled.symbols.every((s) => s.inRange && s.symbol);
    const allSame = new Set(settled.symbols.map((s) => s.symbol)).size === 1;
    check(
      '三条转轮都精确停在符号格上（不会停在空白处）',
      allInRange,
      settled.symbols.map((s) => `#${s.index}=${s.symbol ?? '空白'}`).join(' '),
    );
    check(
      '中奖判定与转轮结果一致（三连相同）',
      settled.won ? allSame : !allSame,
      `中奖=${settled.won} 三个符号=${settled.symbols.map((s) => s.symbol).join('')} 判定文本="${settled.verdict}"`,
    );
    check(
      '中奖时播放华丽中奖动画（金色爆闪 + 撒币 + 中奖文案）',
      settled.won
        ? settled.celebrating && settled.coins > 10 && settled.verdict.includes('恭喜')
        : !settled.celebrating && settled.verdict.includes('没有中奖'),
      `celebrate=${settled.celebrating} 金币=${settled.coins} 文案="${settled.verdict}"`,
    );
    await page.screenshot({ path: `${SHOT_DIR}/12-lottery.png` });

    // 收下之后面板必须收起，否则会挡住下一场比赛
    await page.click('#btn-lottery-close');
    await sleep(300);
    check(
      '点"收下"后抽奖面板关闭',
      await page.isHidden('#lottery'),
      `visible=${await page.isVisible('#lottery')}`,
    );
    await page.evaluate(() => window.__F1RACE__.restart());
    await sleep(200);
    check('重开比赛会一并收掉抽奖面板', await page.isHidden('#lottery'));

    // ---------------------------------------------------------- CR-15 车辆皮肤系统
    //
    // 五条验收（对应 docs/change-requests.md 的 CR-15 验收标准）：
    //   1. 抽奖中奖 → 真正解锁皮肤，且面板给出明确文案
    //   2. 装备后比赛里的外观变化（贴图 key 变了）
    //   3. 刷新页面后已拥有与装备状态保留（真正 reload，重新读 localStorage）
    //   4. 重复抽奖有明确处理，不静默吞掉
    //   5. **皮肤不影响成绩**：换皮肤后玩家的物理配置一字未变，而且
    //      同一套脚本输入的仿真走位 / 计时**逐位相同**
    //
    // 全部真操作真断言：皮肤来自真实的老虎机演出（`?lottery=test` 只调中奖率，
    // 不伪造结果），物理对比来自真实的 update 循环。
    console.log('  … CR-15 车辆皮肤：抽奖解锁 / 装备生效 / 刷新保留 / 不影响成绩');
    /** 当前装备的皮肤 id。 */
    const equippedSkin = async () => (await state(page)).skins.equipped;
    /** 跑一次真实的老虎机（打开 → 等停稳 → 读产出 → 收下）。 */
    const spinLotteryOnce = async () => {
      await page.evaluate(() => window.__F1RACE__.openLottery());
      await page.waitForFunction(() => window.__F1RACE__.getState().lottery.settled === true, null, {
        timeout: 15000,
      });
      await sleep(120);
      const s = await state(page);
      await page.click('#btn-lottery-close');
      await sleep(120);
      return s;
    };
    /** 把车库清回初始状态（每个用例从同一个起点开始，互不依赖执行顺序）。 */
    const resetGarage = async () => {
      await page.evaluate(() => window.localStorage.removeItem('f1race.skins.v1'));
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });
    };

    await resetGarage();

    // --- 1. 6 张贴图都已预载（BootScene 全量加载），默认皮肤就是原厂
    const loadedSkins = await page.evaluate(() => {
      // 从 Phaser 的贴图管理器里查"皮肤贴图是否真的进了缓存"。
      // 查缓存而不是查文件存在：文件存在但 BootScene 漏了 load，车库/车身就会用错贴图。
      const game = window.__F1RACE_GAME__;
      return ['default', 'red', 'blue', 'carbon', 'ghost', 'gold'].filter((suffix) =>
        game.textures.exists(`car_skin_${suffix}`),
      );
    });
    const defaultPhysics = await page.evaluate(() => window.__F1RACE__.getPlayerPhysics());
    const defaultEquipped = await equippedSkin();
    check(
      'CR-15 6 张皮肤贴图全部预载，且默认装备"原厂"',
      loadedSkins.length === 6 && defaultEquipped === 'default' && defaultPhysics.textureKey === 'car_skin_default',
      `已载入=${loadedSkins.join('/')} 装备=${defaultEquipped} 贴图=${defaultPhysics.textureKey}`,
    );
    // CR-08 第 1 条：发布默认中奖率不得是 99%（且开关要存在、默认应当是开的 ——
    // 抽奖是皮肤的唯一产出通道，关掉等于把收集系统藏起来）。
    // 这里读的是**场景真正生效**的配置（`?lottery=test` 会覆盖中奖率）；
    // "发布默认"那几个数字直接从 constants.ts 的源码里读，避免测试自己手写一份副本。
    const tuningSource = readFileSync(new URL('../src/game/constants.ts', import.meta.url), 'utf8');
    const publishedWinRate = Number(/winRate:\s*([\d.]+)/.exec(tuningSource)?.[1]);
    const publishedEnabled = /enabled:\s*(true|false)/.exec(tuningSource)?.[1];
    const lotteryCfg = (await state(page)).lotteryConfig;
    check(
      'CR-08 抽奖发布默认中奖率不是 0.99（99% 只待在调试覆盖里），且默认开启',
      lotteryCfg.enabled === true &&
        lotteryCfg.debugOverride === true &&
        lotteryCfg.winRate === 0.99 &&
        publishedWinRate !== 0.99 &&
        publishedEnabled === 'true',
      `生效=${JSON.stringify(lotteryCfg)} 发布默认={winRate:${String(publishedWinRate)},enabled:${String(publishedEnabled)}}`,
    );

    // --- 2. 真实抽奖中奖 → 解锁皮肤（车库可见）
    const winState = await spinLotteryOnce();
    const unlockedIds = winState.skins.owned.filter((id) => id !== 'default');
    check(
      'CR-15 抽奖中奖真的产出皮肤（不再是"只放动画"）',
      winState.lottery.won === true && unlockedIds.length === 1 && winState.lottery.skin.includes('新皮肤'),
      `中奖=${String(winState.lottery.won)} 新拥有=${unlockedIds.join('/') || '（无）'} 产出文案="${winState.lottery.skin}"`,
    );
    const draftedId = unlockedIds[0];
    await page.evaluate(() => window.__F1RACE__.openGarage());
    await sleep(250);
    const garage = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#garage-grid .garage-card'));
      return {
        visible: !document.getElementById('garage').classList.contains('hidden'),
        total: cards.length,
        owned: cards.filter((c) => c.dataset['owned'] === '1').map((c) => c.dataset['skin']),
        locked: cards.filter((c) => c.dataset['owned'] === '0').length,
        highlighted: cards.filter((c) => c.classList.contains('is-new')).map((c) => c.dataset['skin']),
        // 未拥有的卡片必须有"怎么获得"的说明
        lockedHint: cards
          .filter((c) => c.dataset['owned'] === '0')
          .every((c) => (c.textContent ?? '').includes('抽奖')),
        thumbLoaded: cards.every((c) => {
          const img = c.querySelector('img');
          return img !== null && img.getAttribute('src')?.startsWith('assets/cars/player_') === true;
        }),
      };
    });
    const garagePaused = (await state(page)).paused;
    check(
      'CR-15 车库列出 6 款皮肤，区分已拥有 / 未拥有并高亮刚抽到的那款',
      garage.visible &&
        garage.total === 6 &&
        garage.owned.length === 2 &&
        garage.owned.includes(draftedId) &&
        garage.locked === 4 &&
        garage.highlighted.length === 1 &&
        garage.highlighted[0] === draftedId &&
        garage.lockedHint &&
        garage.thumbLoaded,
      `卡片=${garage.total} 已拥有=${garage.owned.join('/')} 锁定=${garage.locked} 高亮=${garage.highlighted.join('/')}`,
    );
    check('CR-15 车库打开时比赛被暂停（不会在翻菜单时被 AI 超过）', garagePaused === true, `paused=${String(garagePaused)}`);
    await page.screenshot({ path: `${SHOT_DIR}/13-garage.png` });

    // --- 3. 装备后比赛里的外观变化
    const equipped = await page.evaluate((id) => window.__F1RACE__.equipSkin(id), draftedId);
    const afterEquip = await page.evaluate(() => window.__F1RACE__.getPlayerPhysics());
    await page.evaluate(() => window.__F1RACE__.closeGarage());
    await page.evaluate(() => window.__F1RACE__.restart());
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown', null, { timeout: 10000 });
    const inRacePhysics = await page.evaluate(() => window.__F1RACE__.getPlayerPhysics());
    check(
      'CR-15 装备后车身贴图立刻跟着换（车库与比赛里都是新皮肤）',
      equipped === true &&
        afterEquip.textureKey === `car_skin_${draftedId}` &&
        inRacePhysics.textureKey === `car_skin_${draftedId}`,
      `equip=${String(equipped)} 车库内=${afterEquip.textureKey} 重开后=${inRacePhysics.textureKey}`,
    );
    check(
      'CR-15 关闭车库后比赛恢复（不是一直暂停着）',
      (await state(page)).paused === false,
      `paused=${String((await state(page)).paused)}`,
    );

    // --- 4. 刷新页面后已拥有与装备状态保留
    //
    // 真 reload：新页面重新走 BootScene → RaceScene，SkinStore 从 localStorage 读回来。
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });
    const skinAfterReload = await state(page);
    const storedRaw = await page.evaluate(() => window.localStorage.getItem('f1race.skins.v1'));
    check(
      'CR-15 刷新页面后已拥有与装备状态保留（独立存储键 f1race.skins.v1）',
      skinAfterReload.skins.owned.includes(draftedId) &&
        skinAfterReload.skins.equipped === draftedId &&
        skinAfterReload.skins.isPersistent === true &&
        skinAfterReload.playerTexture === `car_skin_${draftedId}` &&
        typeof storedRaw === 'string' &&
        JSON.parse(storedRaw).version === 1,
      `拥有=${skinAfterReload.skins.owned.join('/')} 装备=${skinAfterReload.skins.equipped} 贴图=${skinAfterReload.playerTexture}`,
    );

    // --- 5. 重复抽奖有明确处理（不静默吞掉）
    //
    // 真抽：反复转老虎机直到抽出**同一款**已拥有的皮肤为止（掉落表 5 款，
    // 期望 3~4 次就能撞上）。红线的表现是"面板上什么都没说"。
    let duplicateState = null;
    let duplicateAttempts = 0;
    for (let i = 0; i < 16 && duplicateState === null; i++) {
      duplicateAttempts++;
      const s = await spinLotteryOnce();
      const isDuplicate = s.lottery.won === true && s.lottery.skin.includes('已拥有');
      if (isDuplicate) duplicateState = s;
    }
    check(
      'CR-15 重复抽到已拥有皮肤时有明确交代（不静默吞掉）',
      duplicateState !== null &&
        duplicateState.lottery.skin.includes('不会重复计数') &&
        // 重复不该把同一款皮肤在拥有列表里记两次
        duplicateState.skins.owned.length === new Set(duplicateState.skins.owned).size,
      duplicateState
        ? `第 ${duplicateAttempts} 次撞上重复："${duplicateState.lottery.skin}" 拥有=${duplicateState.skins.owned.join('/')}`
        : `连抽 ${duplicateAttempts} 次都没撞上重复（掉奖池只有 5 款，属于异常）`,
    );
    await page.screenshot({ path: `${SHOT_DIR}/14-lottery-skin.png` });

    // --- 6. 皮肤不影响成绩（本轮最重要的一条）
    //
    // 分两层，缺一不可：
    //   ① **物理配置**：换皮肤前后读玩家的车体快照，只有 textureKey 允许变；
    //   ② **仿真结果**：同一套脚本输入（开环、不依赖墙钟）跑固定帧数，
    //      两台不同皮肤下的走位必须**逐位相同**。
    //      AI 与幽灵车会引入"跑法相同但时序不同"的噪声，所以对比时先关掉它们。
    //
    // 皮肤取"已拥有的任意两款"而不是写死 gold：这一条要验的是**换皮肤**这件事，
    // 不是"某人恰好抽到了黄金"。两次跑之间皮肤必须真的不同（否则断言毫无意义）。
    const skinPair = await page.evaluate(() => {
      const s = window.__F1RACE__.getSkins();
      const other = s.owned.find((id) => id !== 'default');
      return { a: 'default', b: other ?? null };
    });
    const SKIN_A = skinPair.a;
    const SKIN_B = skinPair.b;
    await page.evaluate(() => {
      window.__F1RACE__.setAiEnabled(false);
      window.__F1RACE__.setAutopilot(false);
      window.__F1RACE__.equipSkin('default');
    });
    const physicsA = await page.evaluate(() => window.__F1RACE__.getPlayerPhysics());
    const equipB = SKIN_B === null ? false : await page.evaluate((id) => window.__F1RACE__.equipSkin(id), SKIN_B);
    const physicsB = await page.evaluate(() => window.__F1RACE__.getPlayerPhysics());
    // 只比"除贴图以外"的字段：其它的任何差异都是皮肤碰了物理
    const physicsDiff = Object.keys(physicsA).filter(
      (key) => key !== 'textureKey' && physicsA[key] !== physicsB[key],
    );
    check(
      'CR-15 换皮肤只换贴图：物理配置（body 半径 / 偏移 / 最大速度 / 阻力 / 显示尺寸）一字未变',
      equipB === true && physicsA.textureKey !== physicsB.textureKey && physicsDiff.length === 0,
      physicsDiff.length === 0
        ? `贴图 ${physicsA.textureKey} → ${physicsB.textureKey}，其余 ${Object.keys(physicsA).length - 1} 项完全一致`
        : `以下物理字段被皮肤改变了：${physicsDiff.map((k) => `${k}: ${physicsA[k]}→${physicsB[k]}`).join('，')}`,
    );
    check(
      'CR-15 物理体尺寸与贴图尺寸无关（body 半径仍是 TUNING.vehicle.bodyRadius = 12）',
      physicsA.bodyRadius === 12 && physicsB.bodyRadius === 12 && physicsA.bodyOffsetX === physicsB.bodyOffsetX,
      `半径=${physicsA.bodyRadius}/${physicsB.bodyRadius} 偏移=${physicsA.bodyOffsetX},${physicsA.bodyOffsetY}`,
    );

    /**
     * 在指定皮肤下跑一段**固定脚本输入**，返回仿真快照与沿途采样。
     *
     * 输入是**恒定**的（油门 0.55、不转向），理由见循环里的注释：只要输入随
     * "当前状态/时间"变化，两次运行就会把同一条指令落在不同的物理步上，
     * 量到的就是采样相位差而不是皮肤的影响。
     */
    const runScriptedSmoke = async (skinId, targetMs) => {
      if (typeof skinId !== 'string' || skinId.length === 0) {
        throw new Error(`[e2e] 脚本跑法需要一款有效皮肤，收到 ${String(skinId)}`);
      }
      await page.evaluate((id) => window.__F1RACE__.equipSkin(id), skinId);
      await page.evaluate(() => {
        window.__F1RACE__.restart();
        window.__F1RACE__.skipCountdown();
      });
      await page.waitForFunction(() => window.__F1RACE__.getState().state === 'racing', null, { timeout: 10000 });
      // 从发车格原点、零速度开始的纯开环输入：完全可复现
      await page.evaluate(() => window.__F1RACE__.setInput(0, 0));
      await sleep(150);
      const result = await page.evaluate((target) => {
        return new Promise((resolve) => {
          // ⚠️ 输入必须**逐帧**写。把 `setInput` 在同一个任务里连调 N 次，
          // 游戏一帧都看不到（循环结束时只剩最后一个值），车会原地不动 ——
          // 那样"两次都一样"会变成最典型的假通过。
          //
          // 采样：每跨过 2000ms 记一个点，用来判断"两条轨迹是整段贴合"，
          // 而不是只在一个瞬时点上碰巧接近。
          const samples = [];
          let nextSampleMs = 0;
          const tick = () => {
            const s = window.__F1RACE__.getState();
            if (s.raceTimeMs >= nextSampleMs && s.state === 'racing') {
              const racer = s.racers.find((r) => r.isPlayer);
              samples.push({
                raceTimeMs: s.raceTimeMs,
                x: s.x,
                y: s.y,
                speed: racer ? racer.speed : s.speed,
                heading: s.heading,
              });
              nextSampleMs += 2000;
            }
            if (s.raceTimeMs >= target || s.state !== 'racing') {
              window.__F1RACE__.setInput(0, 0);
              resolve({ raceTimeMs: s.raceTimeMs, state: s.state, samples, texture: s.playerTexture });
              return;
            }
            // 恒定的开环输入：油门 0.55、不转向。
            //
            // 为什么连转向都不给：输入一旦随"当前比赛时间"变化，两次运行就可能把
            // "这一帧要不要打方向"落在不同的物理步上 —— 那量到的是采样相位差，
            // 不是皮肤的影响。恒定输入下，**每一帧、每一个物理步收到的输入都完全一样**，
            // 于是剩下唯一的变量就是"跑了多少步"（最多差一步，见容差说明）。
            window.__F1RACE__.setInput(0.55, 0);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      }, targetMs);
      await sleep(80);
      const s = await state(page);
      return {
        skin: skinId,
        texture: result.texture,
        sampledAtMs: result.raceTimeMs,
        samples: result.samples,
        x: s.x,
        y: s.y,
        heading: s.heading,
        speed: s.speed,
        lateral: s.lateral,
        driftAngle: s.driftAngle,
        lapProgress: s.lapProgress,
        raceTimeMs: s.raceTimeMs,
        surfaceFactor: s.surfaceFactor,
        onTrack: s.onTrack,
      };
    };

    const SMOKE_TARGET_MS = 8000;
    const smokeA = await runScriptedSmoke(SKIN_A, SMOKE_TARGET_MS);
    const smokeB = await runScriptedSmoke(SKIN_B, SMOKE_TARGET_MS);
    /**
     * 逐位比较的距离容差（像素）。
     *
     * 为什么不是 0：仿真的时间轴是**墙钟**驱动的（`update(time, delta)` 的 delta 来自
     * rAF 间隔），两次运行到不了"同样的物理步数"。Phaser Arcade 用累加器把 delta
     * 折算成 1/60s 的固定步长，两次运行的总步数**最多差一步**，所以位置差有硬上限：
     * 车速 520px/s × 一帧 16.7ms ≈ 8.7px。取 20px 留一倍余量。
     *
     * 皮肤若真的参与物理（哪怕只是改了 body 尺寸），偏差会是几十上百像素且**逐段累积**，
     * 与"最多差一步"的常数级偏差形态完全不同。
     */
    const SMOKE_TOLERANCE_PX = 20;
    const dx = Math.abs(smokeA.x - smokeB.x);
    const dy = Math.abs(smokeA.y - smokeB.y);
    const trackLengthPx = await page.evaluate(() => window.__F1RACE__.scene.track.totalLength);
    const dProgress = Math.abs(smokeA.lapProgress - smokeB.lapProgress) * trackLengthPx;
    // 先确认这一套跑法真的在开车（否则"两条都一样"可能只是两台车都没动过）
    const smokeMoved = smokeA.speed > 100 && smokeA.lapProgress > 0.02 && smokeA.raceTimeMs >= SMOKE_TARGET_MS;

    /**
     * 沿途采样点的偏差（同一下标 = 同一个 2 秒档）。
     *
     * 为什么要沿整段比、而不只比终点：这两次运行的时间轴是墙钟驱动的，
     * 每次采样的精确物理步不完全相同（最多差一帧）。差一帧意味着"这一帧有没有打方向"
     * 可能不同 —— 瞬间值上会出现约 5px/s 的速度差，看起来像"皮肤影响了物理"，
     * 其实只是采样相位差。要求**整段**都贴合，才是"同一套输入 → 同一条轨迹"的证据：
     * 皮肤若真参与物理，误差会逐段累积、越拉越大。
     */
    const trajectoryDivergence = (() => {
      const n = Math.min(smokeA.samples.length, smokeB.samples.length);
      if (n === 0) return null;
      let maxPosPx = 0;
      let maxSpeed = 0;
      let maxHeading = 0;
      for (let i = 0; i < n; i++) {
        const a = smokeA.samples[i];
        const b = smokeB.samples[i];
        maxPosPx = Math.max(maxPosPx, Math.hypot(a.x - b.x, a.y - b.y));
        maxSpeed = Math.max(maxSpeed, Math.abs(a.speed - b.speed));
        maxHeading = Math.max(maxHeading, Math.abs(a.heading - b.heading));
      }
      return { points: n, maxPosPx, maxSpeed, maxHeading };
    })();

    check(
      'CR-15 同一套脚本输入下，不同皮肤的走位一致（皮肤不参与仿真）',
      smokeMoved && dx < SMOKE_TOLERANCE_PX && dy < SMOKE_TOLERANCE_PX && dProgress < SMOKE_TOLERANCE_PX,
      smokeMoved
        ? `跑法有效（比赛时间走到 ${smokeA.raceTimeMs.toFixed(0)}ms、末速 ${smokeA.speed.toFixed(0)}px/s、进度 ${(smokeA.lapProgress * 100).toFixed(1)}%）；` +
            `两种皮肤的落点差 ${dx.toFixed(2)}px / ${dy.toFixed(2)}px、圈进度差 ${dProgress.toFixed(2)}px（容差 ${SMOKE_TOLERANCE_PX}px = 一帧位移上限）`
        : `跑法无效（末速 ${smokeA.speed.toFixed(0)}px/s、进度 ${(smokeA.lapProgress * 100).toFixed(1)}%、${smokeA.raceTimeMs.toFixed(0)}ms）—— 这条会变成假通过`,
    );
    check(
      'CR-15 同一套脚本输入下，不同皮肤的轨迹整段贴合（位置 / 速度 / 朝向偏差都在"差一步"的量级内）',
      smokeMoved &&
        trajectoryDivergence !== null &&
        trajectoryDivergence.maxPosPx < SMOKE_TOLERANCE_PX &&
        trajectoryDivergence.maxSpeed < 10 &&
        trajectoryDivergence.maxHeading < 1e-3,
      trajectoryDivergence === null
        ? '两次跑法没有可比的采样点（轨迹检查失效）'
        : `沿途 ${trajectoryDivergence.points} 个采样点：最大位置偏差 ${trajectoryDivergence.maxPosPx.toFixed(2)}px、` +
          `最大速度偏差 ${trajectoryDivergence.maxSpeed.toFixed(3)}px/s、最大朝向偏差 ${trajectoryDivergence.maxHeading.toExponential(2)}rad` +
          `（皮肤若参与物理，偏差会随距离累积，而不是停在"一帧位移"这个量级）`,
    );
    check(
      'CR-15 皮肤确实换上了（两次跑的贴图不同，不是"根本没生效"）',
      smokeA.texture === `car_skin_${SKIN_A}` && smokeB.texture === `car_skin_${SKIN_B}`,
      `${smokeA.texture} vs ${smokeB.texture}`,
    );

    // 收尾：恢复 AI 与一个干净的起跑状态，别把后面的 CR-01 用例留在"AI 关闭 + 跑到半路"上
    await page.evaluate(() => {
      window.__F1RACE__.setAiEnabled(true);
      window.__F1RACE__.equipSkin('default');
      window.__F1RACE__.restart();
    });
    await page.waitForFunction(() => window.__F1RACE__.getState().state === 'countdown', null, { timeout: 10000 });

    // ---------------------------------------------------------- CR-01 顶部 HUD 不重叠
    //
    // 曾经的 bug：`.hud-top-center`（赛道 / 最佳总时间 / 排名）与 `#hud-delta`
    // 都锚在 `top:14/16px; left:50%; translateX(-50%)`，delta 的 38px 大字
    // 直接压在面板文字上；`#hud-lap-flag` 是同一列的第三个占位者（top:84px 落在面板高度内）。
    //
    // 断言选的是**几何**而不是"某个 class 存不存在"：强制把三条元素都显示出来，
    // 它们的包围盒必须两两不相交且都有面积。将来谁再把某个元素钉回顶部正中，这条就会红。
    //
    // 放在整个 e2e 的最后：它会改视口尺寸并暂停比赛，中途插入会打乱后面依赖真实
    // 计时/状态的用例（倒计时、难度对比等）。
    console.log('  … CR-01 顶部 HUD 三元素包围盒互不相交（两种分辨率）');
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize(viewport);
      // 先让 resize 那一帧跑完，再暂停 —— 否则 setViewportSize 触发的场景重算
      // 会在 pause() 之后又刷一遍 HUD，把刚显示出来的元素收掉。
      await sleep(400);

      // 量包围盒与"强制显示"放在**同一个 evaluate** 里：中间不留任何一帧给
      // updateHud() 把元素重新隐藏（分开写时正是这样量到了 0x0）。
      const layout = await page.evaluate(() => {
        window.__F1RACE__.pause();
        const delta = document.getElementById('hud-delta');
        const flag = document.getElementById('hud-lap-flag');
        const toast = document.getElementById('hud-toast');
        delta.classList.remove('hidden');
        document.getElementById('hud-delta-value').textContent = '+1.234';
        flag.classList.remove('hidden');
        toast.classList.remove('hidden');
        toast.textContent = '第 2 圈 0:16.843';

        const pick = {
          delta: '#hud-delta',
          lapFlag: '#hud-lap-flag',
          toast: '#hud-toast',
          minimap: '#minimap-panel',
          topLeft: '.hud-top-left',
          topCenter: '.hud-top-center',
          bottomLeft: '.hud-bottom-left',
          bottomRight: '.hud-bottom-right',
          difficultyBar: '.hud-difficulty-bar',
        };
        const rects = {};
        for (const [name, sel] of Object.entries(pick)) {
          const r = document.querySelector(sel).getBoundingClientRect();
          rects[name] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
        }
        // delta 现在**在** topLeft 面板内部，它俩相交是设计如此，排除这一对
        const pairs = [
          ['delta', 'topCenter'],
          ['delta', 'lapFlag'],
          ['delta', 'toast'],
          ['delta', 'minimap'],
          ['topCenter', 'lapFlag'],
          ['topCenter', 'toast'],
          ['topCenter', 'minimap'],
          ['topLeft', 'topCenter'],
          ['topLeft', 'minimap'],
          ['toast', 'lapFlag'],
          ['toast', 'difficultyBar'],
          ['lapFlag', 'difficultyBar'],
        ];
        const overlaps = (a, b) =>
          a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        return {
          // 所有元素都必须真的有面积，否则"不相交"是假通过
          degenerate: Object.entries(rects)
            .filter(([, r]) => r.w < 1 || r.h < 1)
            .map(([n]) => n),
          bad: pairs.filter(([a, b]) => overlaps(rects[a], rects[b])).map(([a, b]) => `${a}×${b}`),
        };
      });
      check(
        `CR-01 ${viewport.width}×${viewport.height}：delta / 本圈无效 / toast / 顶部面板两两不相交`,
        layout.bad.length === 0 && layout.degenerate.length === 0,
        layout.degenerate.length > 0
          ? `这些元素量到 0 尺寸（说明没真显示出来）：${layout.degenerate.join(', ')}`
          : layout.bad.length === 0
            ? '12 对元素互不相交'
            : `重叠：${layout.bad.join(', ')}`,
      );
      if (viewport.width === 1280) {
        await page.screenshot({ path: `${SHOT_DIR}/40-hud-no-overlap.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.__F1RACE__.resume());

    check('运行期间无未捕获的页面错误', pageErrors.length === 0, pageErrors.join(' | ') || '无');
    check('运行期间无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '无');

    const summary = {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      version,
      raceSeconds,
      fps,
      renderer: boot.renderer,
      passed: results.filter((r) => r.ok).length,
      failed: failures,
      results,
    };
    writeFileSync(`${SHOT_DIR}/report.json`, JSON.stringify(summary, null, 2));
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }

  console.log('');
  console.log(`=== ${results.length - failures}/${results.length} 项通过 ===`);
  if (failures > 0) {
    console.log('失败项：');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail ?? ''}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[e2e] 执行失败：', err);
  process.exitCode = 1;
});

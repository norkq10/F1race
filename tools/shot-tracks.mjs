/**
 * tools/shot-tracks.mjs
 * 为三条赛道各截一张图（含 HUD 选图栏），用来肉眼确认地图形状与选图 UI。
 *
 * 运行：node tools/shot-tracks.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 5184;
const SHOT_DIR = 'tools/screenshots';

const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
  { stdio: 'ignore', windowsHide: true },
);

async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* 等 */
    }
    await sleep(400);
  }
  return false;
}

let browser;
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  const base = `http://127.0.0.1:${PORT}/?track=track1&debug=0`;
  if (!(await waitForServer(base))) throw new Error('preview 未就绪');

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });

  const shots = [
    ['track1', '轨-环城赛道'],
    ['track3', '轨-峡谷技术环'],
    ['track4', '轨-漂移龙'],
  ];

  for (const [id, label] of shots) {
    await page.evaluate((trackId) => window.__F1RACE__.setTrack(trackId), id);
    await page.waitForFunction((trackId) => window.__F1RACE__?.getState().trackId === trackId, id, {
      timeout: 15000,
    });
    await page.evaluate(() => window.__F1RACE__.skipCountdown());
    // 开一段，让车离开起跑线、镜头稳定
    await page.evaluate(() => window.__F1RACE__.setInput(1, 0));
    await sleep(2500);
    await page.evaluate(() => window.__F1RACE__.setInput(0, 0));
    await sleep(400);
    const file = `${SHOT_DIR}/track-${id}.png`;
    await page.screenshot({ path: file });
    const info = await page.evaluate(() => window.__F1RACE__.getState());
    console.log(
      `[shot] ${label} -> ${file}  长度=${Math.round(info.trackLength)}px 位置=(${info.x.toFixed(0)}, ${info.y.toFixed(0)}) onTrack=${info.onTrack}`,
    );
  }

  // 起跑线并排的照片（统一发车线）
  await page.evaluate(() => {
    window.__F1RACE__.setTrack('track1');
  });
  await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track1', null, { timeout: 15000 });
  await page.evaluate(() => window.__F1RACE__.restart());
  await sleep(600);
  await page.screenshot({ path: `${SHOT_DIR}/start-line.png` });
  console.log(`[shot] 统一发车线 -> ${SHOT_DIR}/start-line.png`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

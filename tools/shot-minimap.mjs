/**
 * tools/shot-minimap.mjs
 * 小地图验收截图：右上角小地图 + 全部角色光点，以及"镜头移动后小地图不动"的对照。
 *
 * 运行：node tools/shot-minimap.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 5191;
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
      if ((await fetch(url)).ok) return true;
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
  const base = `http://127.0.0.1:${PORT}/?track=track1`;
  if (!(await waitForServer(base))) throw new Error('preview 未就绪');

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text());
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__F1RACE__?.ready === true, null, { timeout: 30000 });

  // 开 autopilot 跑一段，让所有车散开，小地图上光点分布才看得出来
  await page.evaluate(() => {
    window.__F1RACE__.restart();
    window.__F1RACE__.skipCountdown();
    window.__F1RACE__.setAutopilot(true);
  });
  await sleep(9000);
  await page.evaluate(() => window.__F1RACE__.setAutopilot(false));

  const info = await page.evaluate(() => {
    const panel = document.getElementById('minimap-panel');
    const box = panel.getBoundingClientRect();
    const cam = window.__F1RACE__.scene.cameras.main;
    const dots = window.__F1RACE__.getMinimapDots();
    return {
      panel: { left: Math.round(box.left), top: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      camera: { x: Math.round(cam.scrollX), y: Math.round(cam.scrollY) },
      dots: dots.map((d) => ({
        who: d.isPlayer ? '玩家' : d.isGhost ? '幽灵' : 'AI',
        color: '#' + (d.color & 0xffffff).toString(16).padStart(6, '0'),
        screen: [Math.round(d.screenX), Math.round(d.screenY)],
      })),
    };
  });
  console.log('[shot] 小地图面板', JSON.stringify(info.panel), '镜头', JSON.stringify(info.camera));
  console.log('[shot] 光点:');
  for (const d of info.dots) console.log(`   ${d.who.padEnd(4)} ${d.color} 画布内 (${d.screen[0]}, ${d.screen[1]})`);

  await page.screenshot({ path: `${SHOT_DIR}/30-minimap.png` });
  console.log(`[shot] -> ${SHOT_DIR}/30-minimap.png`);

  // 换一张赛道（形状完全不同）：小地图必须跟着换，仍然钉在右上角
  await page.evaluate(() => window.__F1RACE__.setTrack('track3'));
  await page.waitForFunction(() => window.__F1RACE__?.getState().trackId === 'track3', null, { timeout: 15000 });
  await page.evaluate(() => {
    window.__F1RACE__.skipCountdown();
    window.__F1RACE__.setAutopilot(true);
  });
  await sleep(6000);
  await page.evaluate(() => window.__F1RACE__.setAutopilot(false));
  const t3 = await page.evaluate(() => {
    const box = document.getElementById('minimap-panel').getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top) };
  });
  console.log('[shot] 换到峡谷技术环后小地图位置', JSON.stringify(t3));
  await page.screenshot({ path: `${SHOT_DIR}/31-minimap-track3.png` });
  console.log(`[shot] -> ${SHOT_DIR}/31-minimap-track3.png`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

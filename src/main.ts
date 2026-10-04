import Phaser from 'phaser';
import './style.css';
import { BootScene } from './game/scenes/BootScene';
import { RaceScene } from './game/scenes/RaceScene';

/** 在页面上显示致命错误，避免黑屏无提示。 */
function showFatal(message: string): void {
  const panel = document.getElementById('fatal');
  const text = document.getElementById('fatal-message');
  const boot = document.getElementById('boot');
  if (text) text.textContent = message;
  panel?.classList.remove('hidden');
  boot?.classList.add('hidden');
}

window.addEventListener('f1race-fatal', (event) => {
  showFatal(String((event as CustomEvent).detail ?? '未知资源错误'));
});

window.addEventListener('error', (event) => {
  console.error('[F1race] runtime error', event.error ?? event.message);
});

window.addEventListener('f1race-ready', () => {
  document.getElementById('boot')?.classList.add('hidden');
});

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-root',
  backgroundColor: '#11131a',
  // 像素渲染：关闭平滑、坐标取整，保证像素不模糊（REQ-009 的技术前提）
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  physics: {
    default: 'arcade',
    arcade: {
      gravity: { x: 0, y: 0 },
      debug: false,
      fps: 60,
    },
  },
  scene: [BootScene, RaceScene],
};

try {
  const game = new Phaser.Game(config);
  (window as unknown as Record<string, unknown>)['__F1RACE_GAME__'] = game;
} catch (error) {
  console.error('[F1race] 启动失败', error);
  showFatal(`引擎启动失败：${error instanceof Error ? error.message : String(error)}`);
}

import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * 版本号单一来源。
 *
 * 这里读 `package.json` 的 `version`，通过 `define` 注入成编译期常量
 * `__APP_VERSION__`（见 `src/game/constants.ts` 的 `GAME_VERSION`）。
 * **全仓库只有这一处定义版本号** —— 曾经 `constants.ts` 写 0.1.0、
 * `package.json` 写 0.2.0、README 写 M5、known-issues 写 0.3.0，
 * 四个地方四个说法，没人能判断手上的 dist 是哪个版本。
 *
 * 守卫测试 `tests/version.test.ts` 会在版本漂移时报错。
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// F1race - 独立网站静态构建，全部资源走相对路径，便于任意子目录部署。
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets-build',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2500,
  },
});

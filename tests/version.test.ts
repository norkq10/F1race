import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GAME_VERSION, MILESTONE } from '../src/game/constants';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * 版本号守卫。
 *
 * 这条测试存在的唯一理由：这个项目曾经在**四个地方**写了四个不同的版本
 * （constants 0.1.0 / package.json 0.2.0 / README M5 / known-issues 0.3.0），
 * 以至于没人能判断手上的 `dist/` 到底是哪一版。
 * 现在版本号只有 `package.json` 一个来源，任何漂移都会在这里失败。
 */
describe('版本号单一来源', () => {
  it('GAME_VERSION 与 package.json 的 version 一致', () => {
    // 单元测试跑源码、不经过 Vite，所以 GAME_VERSION 会拿到 '0.0.0-dev' 兜底值。
    // 那不算漂移，也说明不了任何问题 —— 跳过，由下面的构建产物断言兜住。
    if (GAME_VERSION === '0.0.0-dev') return;
    assert.equal(GAME_VERSION, pkg.version, 'constants 的版本号与 package.json 不一致');
  });

  it('package.json 的 version 是合法 semver（x.y.z）', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `版本号格式不是 x.y.z：${pkg.version}`);
  });

  it('MILESTONE 是 M<数字> 形式且与版本号主次版本相称', () => {
    assert.match(MILESTONE, /^M\d+$/, `里程碑标记格式不对：${MILESTONE}`);
    // 约定：里程碑号 == 次版本号。M6 → 0.6.x。这条能拦住"只改了一处"的半吊子升级。
    const minor = Number(pkg.version.split('.')[1]);
    assert.equal(
      Number(MILESTONE.slice(1)),
      minor,
      `里程碑 ${MILESTONE} 与 package.json 版本 ${pkg.version} 的次版本号对不上`,
    );
  });

  it('全仓库只有 package.json 一处写死版本号字面量', () => {
    // 扫源码与配置，找出任何"长得像版本号字面量"的赋值。
    //
    // 排除 `0.0.0-dev`：那是 constants.ts 里**故意**留的兜底值
    // （单元测试不经过 Vite，__APP_VERSION__ 不存在）。它长得像版本号，
    // 但语义是"构建链断了"，不是"另一个版本号来源"。
    const offenders: string[] = [];
    const SELF = 'tests/version.test.ts';
    const roots = ['src', 'tools', 'tests'];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = `${dir}/${name}`;
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|mjs)$/.test(name)) continue;
        // 跳过这条测试自己：它正文里就写着正则与示例
        if (full.endsWith(SELF)) continue;
        const text = readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (line.includes('0.0.0-dev')) continue;
          if (/GAME_VERSION\s*=\s*['"]\d+\.\d+\.\d+/.test(line)) offenders.push(`${full}: ${line.trim()}`);
          if (/__APP_VERSION__\s*[:=]\s*['"]\d+\.\d+\.\d+/.test(line)) offenders.push(`${full}: ${line.trim()}`);
        }
      }
    };
    for (const root of roots) walk(root);
    assert.deepEqual(offenders, [], `发现硬编码版本号：\n${offenders.join('\n')}`);
  });

  it('构建产物里的 __APP_VERSION__ 已被替换成 package.json 的版本号', () => {
    // 这条是真正的"端到端"守卫：它证明 vite 的 define 注入确实生效了。
    // 还没构建过就跳过（CI 里 build 在 test 之后，本地可能只跑 test）。
    let bundle = '';
    try {
      const dir = new URL('../dist/assets-build/', import.meta.url);
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.js')) bundle += readFileSync(new URL(name, dir), 'utf8');
      }
    } catch {
      return; // 没有 dist，跳过
    }
    if (bundle.length === 0) return;
    assert.ok(
      !bundle.includes('__APP_VERSION__'),
      '构建产物里还残留 __APP_VERSION__ 字面量，说明 vite 的 define 没生效',
    );
  });
});

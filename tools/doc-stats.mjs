/**
 * tools/doc-stats.mjs
 * 统计测试用例数，输出一段可直接粘进 README / known-issues 的 Markdown。
 *
 * 为什么要有这个脚本：文档里的测试数字曾经同时存在 **155 / 163 / 178 / 187**
 * 四个说法（README 写 155、known-issues 分项相加是 178、静态计数是 163），
 * 而且 `minimap.test.ts` / `track-save.test.ts` 根本没进分项表。
 * 人手维护的数字一定会腐烂，所以改成生成物。
 *
 * 做法：**真正执行一次单元测试**，解析 TAP 输出里的 `# pass N`，
 * 而不是静态数 `it(` —— 后者会漏掉循环里批量生成的用例
 * （`timer.test.ts` 用 15 个 `it(` 生成 39 个用例，静态计数必然偏小）。
 *
 * 运行：node tools/doc-stats.mjs [--write]
 *   --write  直接把生成结果写进 README.md / docs/known-issues.md 的标记区
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const REGEN_START = '<!-- doc-stats:start -->';
const REGEN_END = '<!-- doc-stats:end -->';

/**
 * 跑一次单元测试并解析 TAP 汇总。
 *
 * 用 TAP 解析而不是看退出码：我们需要的是**用例数**。
 */
function runUnitTests() {
  const result = spawnSync(
    process.execPath,
    ['--import', './tools/ts-register.mjs', '--test', 'tests/**/*.test.ts'],
    { encoding: 'utf8', shell: false },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const grab = (key) => {
    const m = new RegExp(`^# ${key} (\\d+)$`, 'm').exec(output);
    return m ? Number(m[1]) : null;
  };
  return {
    tests: grab('tests'),
    suites: grab('suites'),
    pass: grab('pass'),
    fail: grab('fail'),
    ok: result.status === 0,
    output,
  };
}

/** 跑一次 e2e 并解析 `=== N/M 项通过 ===`。 */
function runE2E() {
  const result = spawnSync(process.execPath, ['tools/e2e-check.mjs'], { encoding: 'utf8', shell: false });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const m = /===\s*(\d+)\/(\d+)\s*项通过\s*===/.exec(output);
  return {
    passed: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    ok: result.status === 0,
    output,
  };
}

/** 按测试文件统计 it( 个数，用于分项表。 */
function perFileCounts() {
  const out = {};
  const dir = new URL('../tests/', import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.ts')) continue;
    const text = readFileSync(new URL(name, dir), 'utf8');
    out[name] = (text.match(/\bit\(/g) ?? []).length;
  }
  return out;
}

// ---------------------------------------------------------------- main

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

console.log('[doc-stats] 正在跑单元测试…');
const unit = runUnitTests();
if (unit.tests === null) {
  console.error('[doc-stats] 无法从 TAP 输出解析用例数，原始输出尾部：');
  console.error(unit.output.split('\n').slice(-20).join('\n'));
  process.exit(1);
}

console.log('[doc-stats] 正在跑 e2e…');
const e2e = runE2E();

const counts = perFileCounts();
const breakdown = Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .map(([name, n]) => `${name.replace('.test.ts', '')} ${n}`)
  .join(' / ');

const stamp = new Date().toISOString().slice(0, 10);
const block = [
  REGEN_START,
  `<!-- 这一段由 \`npm run doc:stats\` 生成，请勿手改。生成时间 ${stamp}。 -->`,
  '',
  `| 项目 | 数值 |`,
  `| --- | --- |`,
  `| 版本 | \`${pkg.version}\` |`,
  `| 单元测试 | **${unit.pass}/${unit.tests} 通过**（${unit.suites} 个 suite） |`,
  `| 单元测试分项 | ${breakdown} |`,
  `<!-- 分项是"每个文件写了几个 \`it(\`"，所以和总数**不等**：` +
    `timer.test.ts 用 15 个 \`it(\` 循环生成 39 个用例，静态计数必然偏小。` +
    `总数以 TAP 的 \`# tests\` 为准，分项只用来看"哪个模块测得多"。 -->`,
  e2e.total === null
    ? `| 浏览器 e2e | 未运行 |`
    : `| 浏览器 e2e | **${e2e.passed}/${e2e.total} 通过** |`,
  '',
  REGEN_END,
].join('\n');

if (process.argv.includes('--write')) {
  for (const file of ['README.md', 'docs/known-issues.md']) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const start = text.indexOf(REGEN_START);
    const end = text.indexOf(REGEN_END);
    if (start === -1 || end === -1) {
      console.log(`[doc-stats] ${file} 里没有 ${REGEN_START} / ${REGEN_END} 标记，跳过`);
      continue;
    }
    const next = text.slice(0, start) + block + text.slice(end + REGEN_END.length);
    writeFileSync(file, next, 'utf8');
    console.log(`[doc-stats] 已更新 ${file}`);
  }
} else {
  console.log(block);
  console.log('\n（加 --write 可直接写进 README.md / docs/known-issues.md 的标记区）');
}

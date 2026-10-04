/**
 * tools/check-tracks.mjs
 * 体检所有已定义的赛道（控制点来自 tools/gen-track.mjs）：长度、最急弯半径、走廊最小间距、是否顶到边界。
 *
 * 生成前的快速反馈：改完 gen-track.mjs 的控制点先跑这个，不用整图生成。
 *
 * 运行：node tools/check-tracks.mjs [赛道id ...]
 */

import { TRACKS } from './gen-track.mjs';
import { report } from './check-layout.mjs';

const wanted = process.argv.slice(2);
const targets = wanted.length > 0 ? TRACKS.filter((t) => wanted.includes(t.id)) : TRACKS;

let failed = 0;
for (const track of targets) {
  const result = report(track, track.grid);
  if (!result.ok) failed += 1;
  console.log('');
}

console.log(failed === 0 ? '[check-tracks] 全部通过' : `[check-tracks] ${failed} 条未通过`);
process.exit(failed === 0 ? 0 : 1);

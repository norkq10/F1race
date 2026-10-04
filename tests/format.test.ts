import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDelta, formatStamp, formatTime, isFaster } from '../src/game/format';

describe('formatTime', () => {
  it('按 m:ss.mmm 输出并补零', () => {
    assert.equal(formatTime(0), '0:00.000');
    assert.equal(formatTime(1), '0:00.001');
    assert.equal(formatTime(16999.3), '0:16.999');
    assert.equal(formatTime(51564.6), '0:51.564');
    assert.equal(formatTime(60000), '1:00.000');
    assert.equal(formatTime(125678), '2:05.678');
  });

  it('非法输入给出占位符而不是 NaN', () => {
    assert.equal(formatTime(null), '--:--.---');
    assert.equal(formatTime(undefined), '--:--.---');
    assert.equal(formatTime(Number.NaN), '--:--.---');
    assert.equal(formatTime(Number.POSITIVE_INFINITY), '--:--.---');
  });

  it('负数被夹到 0', () => {
    assert.equal(formatTime(-5), '0:00.000');
  });
});

describe('formatDelta', () => {
  it('正数带 +，负数带 -', () => {
    assert.equal(formatDelta(342), '+0.342');
    assert.equal(formatDelta(-128), '-0.128');
    assert.equal(formatDelta(0), '+0.000');
    assert.equal(formatDelta(-1234), '-1.234');
  });

  it('超过一分钟时复用 formatTime', () => {
    assert.equal(formatDelta(65200), '+1:05.200');
    assert.equal(formatDelta(-65200), '-1:05.200');
  });

  it('非法输入给出占位符', () => {
    assert.equal(formatDelta(null), '--.---');
    assert.equal(formatDelta(Number.NaN), '--.---');
  });
});

describe('isFaster', () => {
  it('没有参考时任何成绩都算更快', () => {
    assert.equal(isFaster(100, null), true);
    assert.equal(isFaster(100, undefined), true);
  });

  it('必须严格更小', () => {
    assert.equal(isFaster(99, 100), true);
    assert.equal(isFaster(100, 100), false);
    assert.equal(isFaster(101, 100), false);
  });
});

describe('formatStamp', () => {
  it('输出 MM-DD HH:mm', () => {
    const text = formatStamp('2026-10-03T12:34:00.000Z');
    assert.match(text, /^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法输入给出占位符', () => {
    assert.equal(formatStamp(null), '--');
    assert.equal(formatStamp('not-a-date'), '--');
  });
});

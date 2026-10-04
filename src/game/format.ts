/**
 * 与显示相关的纯函数（无 DOM、无 Phaser 依赖，可直接单元测试）。
 */

/** 把毫秒格式化为 m:ss.mmm。 */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--.---';
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = Math.floor(clamped % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * 时间差显示，例如 `+0.342` / `-1:02.500`。
 * 传入 null 时返回占位符。
 */
export function formatDelta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--.---';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  if (abs < 60000) {
    const seconds = Math.floor(abs / 1000);
    const millis = Math.floor(abs % 1000);
    return `${sign}${seconds}.${String(millis).padStart(3, '0')}`;
  }
  return sign + formatTime(abs);
}

/** 成绩是否算"更快"（越小越好）。 */
export function isFaster(candidate: number, reference: number | null | undefined): boolean {
  return reference === null || reference === undefined || candidate < reference;
}

/** 把 ISO 时间戳格式化为 `MM-DD HH:mm`，用于成绩历史列表。 */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 预计完赛时间的显示，例如 `预计 1:04.2`。
 *
 * 与 `formatTime` 的区别：这是**外推的估计值**，刻意只保留 0.1 秒精度 ——
 * 精确到毫秒会让读者以为它是实测成绩（known-issues 第 9 条）。
 * 前缀"预计"也承担同样的责任：明确标注这是估的。
 */
export function formatEstimate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '预计 --:--';
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `预计 ${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

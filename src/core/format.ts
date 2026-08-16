import type { SourceStatus } from "./status.ts";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDateTime(at: Date | undefined): string {
  if (!at) return "从未成功";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}`;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

/** 超期文案。这是「以为在备份其实早就挂了」的唯一预警，措辞要直白。 */
export function describeStale(status: SourceStatus): string {
  if (status.neverSucceeded) return "⚠ 从未成功备份过";
  if (status.stale) return `⚠ 已 ${status.daysSinceSuccess} 天没有成功备份`;
  return "正常";
}

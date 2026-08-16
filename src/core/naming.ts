import type { BackupFormat } from "./types.ts";

export const EXTENSION: Record<BackupFormat, string> = {
  sql: "sql",
  custom: "dump",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时间的 YYYYMMDD-HHmmss。精确到秒，所以同一天多次备份不会相互覆盖。 */
export function formatStamp(at: Date): string {
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${date}-${time}`;
}

export function backupFileName(
  source: string,
  at: Date,
  format: BackupFormat
): string {
  return `${source}-${formatStamp(at)}.${EXTENSION[format]}`;
}

import type { BackupFormat } from "./types.ts";

export const EXTENSION: Record<BackupFormat, string> = {
  sql: "sql",
  dump: "dump",
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

const FORMAT_BY_EXTENSION: Record<string, BackupFormat> = {
  sql: "sql",
  dump: "dump",
};

const BACKUP_FILE = /^(.+)-(\d{8}-\d{6})\.(sql|dump)$/;
const LATEST_LINK = /^(.+)-latest\.(?:sql|dump)$/;

export interface ParsedBackupName {
  source: string;
  stamp: string;
  format: BackupFormat;
}

/**
 * 只认本工具自己生成的文件名。清理逻辑靠它划定「碰得到什么」的边界，
 * 所以宁可漏认，也不能错认——备份目录很可能混着别的东西。
 */
export function parseBackupFileName(
  name: string
): ParsedBackupName | undefined {
  const match = BACKUP_FILE.exec(name);
  if (!match) return undefined;
  const [, source, stamp, extension] = match;
  if (!source || !stamp || !extension) return undefined;
  const format = FORMAT_BY_EXTENSION[extension];
  if (!format) return undefined;
  return { source, stamp, format };
}

export function latestLinkName(source: string, format: BackupFormat): string {
  return `${source}-latest.${EXTENSION[format]}`;
}

export function parseLatestLinkName(name: string): string | undefined {
  return LATEST_LINK.exec(name)?.[1];
}

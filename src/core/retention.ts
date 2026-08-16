import { lstatSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  latestLinkName,
  parseBackupFileName,
  parseLatestLinkName,
} from "./naming.ts";
import type { BackupFormat } from "./types.ts";

export interface BackupEntry {
  name: string;
  stamp: string;
}

/**
 * 纯函数：给定候选条目与保留份数，算出该删哪些。
 *
 * 整个工具里唯一会销毁数据的判断都在这里，所以它不碰文件系统——
 * 输入是一个列表，输出是一个列表，边界情况可以穷举。
 */
export function planRetention(
  entries: BackupEntry[],
  keep: number
): BackupEntry[] {
  if (keep <= 0) return [];
  const newestFirst = [...entries].sort(
    (a, b) => b.stamp.localeCompare(a.stamp) || b.name.localeCompare(a.name)
  );
  return newestFirst.slice(keep);
}

/**
 * 扫目录收集候选。两道过滤：文件名必须符合本工具的命名规则，且属于该数据源。
 * 符号链接（latest 指针）与目录都不算数据，直接排除。
 */
export function collectBackups(dir: string, source: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: BackupEntry[] = [];
  for (const name of names) {
    const parsed = parseBackupFileName(name);
    if (!parsed || parsed.source !== source) continue;
    try {
      if (!lstatSync(path.join(dir, name)).isFile()) continue;
    } catch {
      continue;
    }
    entries.push({ name, stamp: parsed.stamp });
  }
  return entries;
}

export interface PruneOutcome {
  deleted: string[];
  warnings: string[];
}

export function pruneBackups(
  dir: string,
  source: string,
  keep: number
): PruneOutcome {
  const doomed = planRetention(collectBackups(dir, source), keep);
  const deleted: string[] = [];
  const warnings: string[] = [];

  for (const entry of doomed) {
    try {
      unlinkSync(path.join(dir, entry.name));
      deleted.push(entry.name);
    } catch (cause) {
      warnings.push(
        `旧备份删除失败：${entry.name}（${(cause as Error).message}）`
      );
    }
  }

  return { deleted, warnings };
}

/**
 * 让 <数据源>-latest.<扩展名> 指向最新产物。
 *
 * 会先清掉该数据源其他格式的旧链接：切换格式后如果留着旧的 latest.sql，
 * 「最新那份」就会指向一份实际更旧的备份，比没有指针更危险。
 */
export function repointLatest(
  dir: string,
  source: string,
  format: BackupFormat,
  targetFileName: string
): string[] {
  const warnings: string[] = [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (cause) {
    return [`读不到备份目录，未更新 latest 指针：${(cause as Error).message}`];
  }

  for (const name of names) {
    if (parseLatestLinkName(name) !== source) continue;
    try {
      unlinkSync(path.join(dir, name));
    } catch (cause) {
      warnings.push(
        `旧的 latest 指针删除失败：${name}（${(cause as Error).message}）`
      );
    }
  }

  try {
    // 相对目标：整个备份目录搬走后链接依然有效
    symlinkSync(targetFileName, path.join(dir, latestLinkName(source, format)));
  } catch (cause) {
    // latest 只是便利设施（有些文件系统不支持符号链接）。建不起来要说出来，
    // 但不该把一次已经成功落盘的备份判成失败。
    warnings.push(`latest 指针创建失败：${(cause as Error).message}`);
  }

  return warnings;
}

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
 * 纯函数：保留最新的 keepNewest 份，其余全部返回。
 *
 * 整个工具里唯一会销毁数据的判断都在这里，所以它不碰文件系统——
 * 输入是一个列表，输出是一个列表，边界情况可以穷举。
 *
 * 这里**不含**「0 表示永不清理」那条策略，那是 pruneBackups 的事。
 * 两者混在一起时，keep=1 且要保护刚产出的那份，算出来的预算是 0，
 * 会被误当成「永不清理」，结果该删的旧备份一个没删。
 */
export function planRetention(
  entries: BackupEntry[],
  keepNewest: number
): BackupEntry[] {
  if (keepNewest < 0) return [];
  const newestFirst = [...entries].sort(
    (a, b) => b.stamp.localeCompare(a.stamp) || b.name.localeCompare(a.name)
  );
  return newestFirst.slice(keepNewest);
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

/**
 * @param justCreated 本次刚落盘的产物文件名。它**永远不进候选集**。
 *
 * 没有这层保护时：只要目录里存在一份时间戳比现在更晚的备份（时钟回拨、
 * 从别处拷回旧目录、手工改名都会造成），排序后它排在最前，keep 较小时
 * 刚生成的这份就会被判为「最旧」而删掉——工具打印「备份完成」、退出码 0，
 * 却在同一次运行里销毁了自己的产物。
 */
export function pruneBackups(
  dir: string,
  source: string,
  keep: number,
  justCreated?: string
): PruneOutcome {
  if (keep <= 0) return { deleted: [], warnings: [] }; // 0 = 永不清理

  const all = collectBackups(dir, source);
  const protectedPresent =
    justCreated !== undefined &&
    all.some((entry) => entry.name === justCreated);
  const candidates = protectedPresent
    ? all.filter((entry) => entry.name !== justCreated)
    : all;
  // 被保护的那份自己占掉一个名额
  const doomed = planRetention(candidates, protectedPresent ? keep - 1 : keep);

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
    const stale = path.join(dir, name);
    try {
      // 只清理符号链接。同名的普通文件可能是使用者自己放的真数据，
      // 为了挪个指针把它删掉是不可接受的。
      if (!lstatSync(stale).isSymbolicLink()) {
        warnings.push(`${name} 是普通文件而不是 latest 指针，未动它`);
        continue;
      }
      unlinkSync(stale);
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

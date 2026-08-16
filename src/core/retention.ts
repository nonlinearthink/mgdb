import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseBackupFileName } from "./naming.ts";

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

import { statSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./config.ts";
import { collectBackups } from "./retention.ts";
import type { State } from "./state.ts";
import type { Config } from "./types.ts";

export interface SourceStatus {
  name: string;
  outDir?: string;
  /** 该数据源现有的备份份数（不含 latest 指针） */
  count: number;
  bytes: number;
  lastRunAt?: Date;
  lastSuccessAt?: Date;
  lastOk?: boolean;
  lastError?: string;
  daysSinceSuccess?: number;
  neverSucceeded: boolean;
  /** 超期未成功备份。这是「以为在备份其实早就挂了」的唯一预警。 */
  stale: boolean;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function measure(
  dir: string,
  source: string
): { count: number; bytes: number } {
  const entries = collectBackups(dir, source);
  let bytes = 0;
  for (const entry of entries) {
    try {
      bytes += statSync(path.join(dir, entry.name)).size;
    } catch {
      // 刚被别的进程删掉之类，不影响计数以外的事
    }
  }
  return { count: entries.length, bytes };
}

export function collectStatus(
  config: Config,
  state: State,
  now: Date
): SourceStatus[] {
  return config.sources.map((source) => {
    const configuredOutDir = source.outDir ?? config.defaults.outDir;
    const outDir = configuredOutDir ? expandHome(configuredOutDir) : undefined;
    const { count, bytes } = outDir
      ? measure(outDir, source.name)
      : { count: 0, bytes: 0 };

    const record = state.sources[source.name];
    const lastSuccessAt = parseDate(record?.lastSuccessAt);
    const daysSinceSuccess = lastSuccessAt
      ? Math.floor((now.getTime() - lastSuccessAt.getTime()) / MS_PER_DAY)
      : undefined;
    const neverSucceeded = !lastSuccessAt;

    return {
      name: source.name,
      ...(outDir ? { outDir } : {}),
      count,
      bytes,
      ...(parseDate(record?.lastRunAt)
        ? { lastRunAt: parseDate(record?.lastRunAt) }
        : {}),
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(record ? { lastOk: record.ok } : {}),
      ...(record?.error ? { lastError: record.error } : {}),
      ...(daysSinceSuccess === undefined ? {} : { daysSinceSuccess }),
      neverSucceeded,
      stale:
        neverSucceeded ||
        (daysSinceSuccess ?? 0) >= config.defaults.staleAfterDays,
    };
  });
}

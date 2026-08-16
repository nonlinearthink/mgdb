import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config.ts";

export interface SourceState {
  /** ISO 时间串。用字符串而不是 Date，因为它要原样进 JSON。 */
  lastRunAt: string;
  lastSuccessAt?: string;
  ok: boolean;
  /** 失败时的「环节 + 原因」，成功时不写 */
  error?: string;
  file?: string;
  bytes?: number;
}

export interface State {
  sources: Record<string, SourceState>;
}

export const EMPTY_STATE: State = { sources: {} };

export function defaultStatePath(): string {
  return process.env.MGDB_STATE ?? path.join(configDir(), "state.json");
}

/**
 * 读状态。缺失或损坏一律当成「没有历史记录」——状态文件是派生数据，
 * 不该因为它坏了就让备份和 status 都跑不起来。
 */
export function loadState(file: string): State {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { sources: {} };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { sources: {} };
    const sources = (parsed as { sources?: unknown }).sources;
    if (typeof sources !== "object" || sources === null) return { sources: {} };
    return { sources: sources as Record<string, SourceState> };
  } catch {
    return { sources: {} };
  }
}

/** 写状态。失败返回一条警告而不是抛错：状态没记上不该让已落盘的备份判负。 */
export function saveState(file: string, state: State): string | undefined {
  try {
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    return undefined;
  } catch (cause) {
    return `状态未能写入 ${file}：${(cause as Error).message}`;
  }
}

export interface RunRecord {
  at: Date;
  ok: boolean;
  error?: string;
  file?: string;
  bytes?: number;
}

/** 记一次运行。失败时保留此前的 lastSuccessAt——那正是「已经多久没成功」的依据。 */
export function recordRun(
  file: string,
  source: string,
  record: RunRecord
): string | undefined {
  const state = loadState(file);
  const previous = state.sources[source];
  const at = record.at.toISOString();

  state.sources[source] = {
    lastRunAt: at,
    ...(record.ok
      ? { lastSuccessAt: at }
      : previous?.lastSuccessAt
        ? { lastSuccessAt: previous.lastSuccessAt }
        : {}),
    ok: record.ok,
    ...(record.error ? { error: record.error } : {}),
    ...(record.file ? { file: record.file } : {}),
    ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
  };

  return saveState(file, state);
}

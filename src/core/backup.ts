import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { expandHome, findSource, loadConfig } from "./config.ts";
import type { PgConnection } from "./datasource.ts";
import { parsePgUrl } from "./datasource.ts";
import { backupFileName } from "./naming.ts";
import { locatePgTool } from "./pg-tools.ts";
import { pruneBackups } from "./retention.ts";
import { recordRun } from "./state.ts";
import type {
  BackupFormat,
  Notify,
  PgToolInvocation,
  PgToolOutcome,
  RunPgTool,
} from "./types.ts";
import { verifyDump } from "./verify.ts";

export type { PgToolInvocation, PgToolOutcome, RunPgTool } from "./types.ts";

export interface BackupRequest {
  sourceName: string;
  /** 以下三项都是单次覆盖，不写回配置 */
  outDir?: string;
  format?: BackupFormat;
  keep?: number;
}

export interface BackupDeps {
  configPath: string;
  statePath: string;
  runPgTool: RunPgTool;
  notify: Notify;
  now: () => Date;
  /**
   * 临时文件路径一确定就回调。界面靠它显示「产物已经长到多大」——
   * pg_dump 不吐进度，文件大小是唯一真实可观测的进展。
   */
  onTempFile?: (tempFile: string) => void;
}

export type BackupStep =
  | "config"
  | "source"
  | "connection"
  | "output-dir"
  | "pg-tool"
  | "dump"
  | "verify";

export interface BackupFailure {
  step: BackupStep;
  message: string;
}

export type BackupResult =
  | {
      ok: true;
      source: string;
      format: BackupFormat;
      file: string;
      bytes: number;
      /** 本次清理掉的旧备份文件名，删除动作必须可见 */
      pruned: string[];
      /** 不足以让备份判负、但使用者应当知道的问题 */
      warnings: string[];
    }
  | {
      ok: false;
      source: string;
      failure: BackupFailure;
      /** 失败之外还发生的、使用者应当知道的事（比如这次失败本身没能被记进状态文件） */
      warnings: string[];
    };

const TERMINATION_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type TerminationSignal = (typeof TERMINATION_SIGNALS)[number];

/**
 * 在 dump 期间接管中断信号，先清掉临时文件再让进程按默认方式退出。
 * 没有这一层，Ctrl-C 会在备份目录里留下一个半截产物。
 */
function installInterruptCleanup(cleanup: () => void): () => void {
  const onSignal = (signal: TerminationSignal) => {
    cleanup();
    for (const each of TERMINATION_SIGNALS)
      process.removeListener(each, onSignal);
    process.kill(process.pid, signal);
  };
  for (const each of TERMINATION_SIGNALS) process.on(each, onSignal);
  return () => {
    for (const each of TERMINATION_SIGNALS)
      process.removeListener(each, onSignal);
  };
}

function buildInvocation(
  bin: string,
  connection: PgConnection,
  format: BackupFormat,
  target: string
): PgToolInvocation {
  const args = [
    "--host",
    connection.host,
    "--port",
    String(connection.port),
    "--username",
    connection.user,
    "--dbname",
    connection.database,
    "--no-owner",
    "--no-privileges",
  ];
  // "custom" 是 pg_dump 自己的参数取值，不能跟着我们对外的命名改
  if (format === "dump") args.push("--format", "custom");
  args.push("--file", target);

  return {
    bin,
    args,
    // 密码走环境变量：命令行参数在 ps 里对同机其他用户可见
    env: connection.password ? { PGPASSWORD: connection.password } : {},
  };
}

/** 取首行：通知面板放不下多行，完整原因留在状态文件和终端里 */
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function withWarning(result: BackupResult, warning?: string): BackupResult {
  if (!warning) return result;
  return { ...result, warnings: [...result.warnings, warning] };
}

/**
 * 备份的唯一入口。命令行与界面共用它，所以两条路径的行为不可能分叉。
 *
 * 无论成败都会记状态；失败还会主动发通知——「备份失败了但我不知道」
 * 是备份系统最经典的死法，不能只靠使用者主动来看。
 */
export async function runBackup(
  request: BackupRequest,
  deps: BackupDeps
): Promise<BackupResult> {
  const at = deps.now();
  const result = await attemptBackup(request, deps, at);

  const stateWarning = recordRun(deps.statePath, request.sourceName, {
    at,
    ok: result.ok,
    ...(result.ok
      ? { file: result.file, bytes: result.bytes }
      : { error: `[${result.failure.step}] ${result.failure.message}` }),
  });

  if (!result.ok) {
    try {
      await deps.notify({
        title: `mgdb 备份失败：${result.source}`,
        body: `环节 ${result.failure.step}：${firstLine(result.failure.message)}`,
      });
    } catch {
      // 通知发不出去不改变备份本身的结论
    }
    // 失败也要把「这次失败没能被记下来」说出去：状态没记上，status 面板
    // 会继续显示上一次成功、状态正常，直到超期天数到了才标红
    return withWarning(result, stateWarning);
  }

  return withWarning(result, stateWarning);
}

async function attemptBackup(
  request: BackupRequest,
  deps: BackupDeps,
  at: Date
): Promise<BackupResult> {
  const source = request.sourceName;
  const fail = (step: BackupStep, message: string): BackupResult => ({
    ok: false,
    source,
    failure: { step, message },
    warnings: [],
  });

  const config = loadConfig(deps.configPath);
  if (!config.ok) return fail("config", config.error);

  const dataSource = findSource(config.value, source);
  if (!dataSource.ok) return fail("source", dataSource.error);

  const connection = parsePgUrl(dataSource.value.url);
  if (!connection.ok) return fail("connection", connection.error);

  const configuredOutDir =
    request.outDir ?? dataSource.value.outDir ?? config.value.defaults.outDir;
  if (!configuredOutDir) {
    return fail(
      "output-dir",
      `没有指定备份目录。用 --out 指定一次，或在配置里给数据源 ${source} 或 defaults 设置 outDir。`
    );
  }
  const outDir = expandHome(configuredOutDir);

  const format =
    request.format ?? dataSource.value.format ?? config.value.defaults.format;

  const dumpBin = locatePgTool("pg_dump", config.value.defaults.pgBinDir);
  if (!dumpBin.ok) return fail("pg-tool", dumpBin.error);

  // dump 格式要靠 pg_restore 校验。先确认它在，别等跑完几十分钟才发现没法校验。
  let restoreBin: string | undefined;
  if (format === "dump") {
    const located = locatePgTool("pg_restore", config.value.defaults.pgBinDir);
    if (!located.ok) return fail("pg-tool", located.error);
    restoreBin = located.value;
  }

  try {
    mkdirSync(outDir, { recursive: true });
  } catch (cause) {
    return fail(
      "output-dir",
      `创建备份目录失败：${outDir}\n${(cause as Error).message}`
    );
  }

  // 前缀用数据库名而不是数据源名：数据源名是可以随时改的标签，
  // 拿它当前缀意味着改一次名字，此前所有备份就从计数和清理里消失了
  const fileName = backupFileName(connection.value.database, at, format);
  const target = path.join(outDir, fileName);
  // 点号开头 + .tmp 结尾：不符合本工具的产物命名规则，不会被保留清理碰到
  const temp = path.join(outDir, `.${fileName}.tmp`);

  const removeTemp = () => {
    try {
      unlinkSync(temp);
    } catch {
      // 本来就不存在，不是问题
    }
  };

  deps.onTempFile?.(temp);

  const releaseInterrupt = installInterruptCleanup(removeTemp);
  let renamed = false;

  try {
    let outcome: PgToolOutcome;
    try {
      outcome = await deps.runPgTool(
        buildInvocation(dumpBin.value, connection.value, format, temp)
      );
    } catch (cause) {
      return fail("dump", `pg_dump 执行被打断：${(cause as Error).message}`);
    }

    if (outcome.spawnError) {
      return fail("dump", `启动 pg_dump 失败：${outcome.spawnError}`);
    }
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim();
      return fail(
        "dump",
        `pg_dump 退出码 ${outcome.code}${detail ? `\n${detail}` : ""}`
      );
    }
    if (!existsSync(temp)) {
      return fail("dump", `pg_dump 报告成功，但产物不存在：${temp}`);
    }

    const verified = await verifyDump(temp, format, deps.runPgTool, restoreBin);
    if (!verified.ok) return fail("verify", verified.error);

    const bytes = statSync(temp).size;
    // 同目录内的 rename 是原子的：要么正式产物完整出现，要么它压根没出现
    renameSync(temp, target);
    renamed = true;

    // 清理只在成功之后跑：失败还顺手删旧备份，会同时失去新旧两份
    const keep =
      request.keep ?? dataSource.value.keep ?? config.value.defaults.keep;
    const pruned = pruneBackups(
      outDir,
      connection.value.database,
      keep,
      fileName
    );

    return {
      ok: true,
      source,
      format,
      file: target,
      bytes,
      pruned: pruned.deleted,
      warnings: pruned.warnings,
    };
  } finally {
    releaseInterrupt();
    if (!renamed) removeTemp();
  }
}

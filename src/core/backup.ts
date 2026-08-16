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
import type {
  BackupFormat,
  PgToolInvocation,
  PgToolOutcome,
  RunPgTool,
} from "./types.ts";
import { verifyDump } from "./verify.ts";

export type { PgToolInvocation, PgToolOutcome, RunPgTool } from "./types.ts";

export interface BackupRequest {
  sourceName: string;
  /** 单次覆盖，不写回配置 */
  outDir?: string;
  format?: BackupFormat;
}

export interface BackupDeps {
  configPath: string;
  runPgTool: RunPgTool;
  now: () => Date;
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
    }
  | { ok: false; source: string; failure: BackupFailure };

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
  if (format === "custom") args.push("--format", "custom");
  args.push("--file", target);

  return {
    bin,
    args,
    // 密码走环境变量：命令行参数在 ps 里对同机其他用户可见
    env: connection.password ? { PGPASSWORD: connection.password } : {},
  };
}

export async function runBackup(
  request: BackupRequest,
  deps: BackupDeps
): Promise<BackupResult> {
  const source = request.sourceName;
  const fail = (step: BackupStep, message: string): BackupResult => ({
    ok: false,
    source,
    failure: { step, message },
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

  // custom 格式要靠 pg_restore 校验。先确认它在，别等跑完几十分钟的 dump 才发现没法校验。
  let restoreBin: string | undefined;
  if (format === "custom") {
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

  const fileName = backupFileName(source, deps.now(), format);
  const target = path.join(outDir, fileName);
  // 点号开头 + .tmp 结尾：既不会被保留清理当成正式产物，也不会被 latest 指针选中
  const temp = path.join(outDir, `.${fileName}.tmp`);

  const removeTemp = () => {
    try {
      unlinkSync(temp);
    } catch {
      // 本来就不存在，不是问题
    }
  };

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

    return { ok: true, source, format, file: target, bytes };
  } finally {
    releaseInterrupt();
    if (!renamed) removeTemp();
  }
}

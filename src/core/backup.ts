import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome, findSource, loadConfig } from "./config.ts";
import type { PgConnection } from "./datasource.ts";
import { parsePgUrl } from "./datasource.ts";
import { backupFileName } from "./naming.ts";
import { locatePgTool } from "./pg-tools.ts";
import type { BackupFormat } from "./types.ts";

export interface BackupRequest {
  sourceName: string;
  /** 单次覆盖，不写回配置 */
  outDir?: string;
  format?: BackupFormat;
}

export interface PgDumpInvocation {
  bin: string;
  args: string[];
  /** 只放需要额外注入的变量（如 PGPASSWORD），由适配层并进 process.env */
  env: Record<string, string>;
}

export interface PgDumpOutcome {
  code: number | null;
  stderr: string;
  /** 可执行文件根本没起来时填这里，code 为 null */
  spawnError?: string;
}

export type RunPgDump = (
  invocation: PgDumpInvocation
) => Promise<PgDumpOutcome>;

export interface BackupDeps {
  configPath: string;
  runPgDump: RunPgDump;
  now: () => Date;
}

export type BackupStep =
  | "config"
  | "source"
  | "connection"
  | "output-dir"
  | "pg-tool"
  | "dump";

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

function buildInvocation(
  bin: string,
  connection: PgConnection,
  format: BackupFormat,
  target: string
): PgDumpInvocation {
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

  const bin = locatePgTool("pg_dump", config.value.defaults.pgBinDir);
  if (!bin.ok) return fail("pg-tool", bin.error);

  try {
    mkdirSync(outDir, { recursive: true });
  } catch (cause) {
    return fail(
      "output-dir",
      `创建备份目录失败：${outDir}\n${(cause as Error).message}`
    );
  }

  const target = path.join(outDir, backupFileName(source, deps.now(), format));
  const outcome = await deps.runPgDump(
    buildInvocation(bin.value, connection.value, format, target)
  );

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

  let bytes: number;
  try {
    bytes = statSync(target).size;
  } catch {
    return fail("dump", `pg_dump 报告成功，但产物不存在：${target}`);
  }

  return { ok: true, source, format, file: target, bytes };
}

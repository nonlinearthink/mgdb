import { parseArgs } from "node:util";
import { notifyMacOS } from "../adapters/notify.ts";
import { spawnPgTool } from "../adapters/pg-tool.ts";
import { runBackup } from "../core/backup.ts";
import { defaultConfigPath, loadConfig } from "../core/config.ts";
import { describeStale, formatBytes, formatDateTime } from "../core/format.ts";
import { defaultStatePath, loadState } from "../core/state.ts";
import { collectStatus } from "../core/status.ts";
import type { BackupFormat } from "../core/types.ts";
import { sourceCommand } from "./source-command.ts";

const USAGE = `mgdb — PostgreSQL 备份工具

用法：
  mgdb                                    进入交互界面（主屏为状态面板）
  mgdb backup --source <数据源名> [--out <目录>] [--format sql|dump] [--keep <份数>]
  mgdb status [--json]
  mgdb source list|add|edit|remove
  mgdb help

选项：
  -s, --source   要备份的数据源名（必填）
  -o, --out      本次的输出目录，覆盖配置，不写回
  -f, --format   本次的产物格式，覆盖配置，不写回
                 sql  — 纯文本，可读可 grep，用 psql 灌回
                 dump — pgsql 自定义压缩格式，体积小，将来可选表还原
      --keep     本次保留的备份份数，0 表示不清理，覆盖配置，不写回

环境变量：
  MGDB_CONFIG    配置文件位置，默认 ~/.config/mgdb/config.json
  MGDB_STATE     状态文件位置，默认 ~/.config/mgdb/state.json
`;

function parseFormat(
  value: string | undefined
): BackupFormat | undefined | null {
  if (value === undefined) return undefined;
  if (value === "sql" || value === "dump") return value;
  return null;
}

async function backupCommand(argv: string[]): Promise<number> {
  let source: string | undefined;
  let out: string | undefined;
  let rawFormat: string | undefined;
  let rawKeep: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        source: { type: "string", short: "s" },
        out: { type: "string", short: "o" },
        format: { type: "string", short: "f" },
        keep: { type: "string" },
      },
      strict: true,
    });
    source = values.source;
    out = values.out;
    rawFormat = values.format;
    rawKeep = values.keep;
  } catch (cause) {
    console.error(`${(cause as Error).message}\n\n${USAGE}`);
    return 2;
  }

  if (!source) {
    console.error(`backup 需要 --source 指定数据源。\n\n${USAGE}`);
    return 2;
  }

  const format = parseFormat(rawFormat);
  if (format === null) {
    console.error(`--format 只能是 sql 或 dump，收到的是 ${rawFormat}`);
    return 2;
  }

  let keep: number | undefined;
  if (rawKeep !== undefined) {
    keep = Number(rawKeep);
    if (!Number.isInteger(keep) || keep < 0) {
      console.error(`--keep 只能是不小于 0 的整数，收到的是 ${rawKeep}`);
      return 2;
    }
  }

  const result = await runBackup(
    {
      sourceName: source,
      ...(out ? { outDir: out } : {}),
      ...(format ? { format } : {}),
      ...(keep === undefined ? {} : { keep }),
    },
    {
      configPath: defaultConfigPath(),
      statePath: defaultStatePath(),
      runPgTool: spawnPgTool,
      notify: notifyMacOS,
      now: () => new Date(),
    }
  );

  if (!result.ok) {
    console.error(
      `备份失败（数据源 ${result.source}，环节 ${result.failure.step}）`
    );
    console.error(result.failure.message);
    return 1;
  }

  console.log(`备份完成：${result.file}（${formatBytes(result.bytes)}）`);
  if (result.pruned.length > 0) {
    // 删除动作必须可见，不能静默发生
    console.log(`已清理 ${result.pruned.length} 份旧备份：`);
    for (const name of result.pruned) console.log(`  - ${name}`);
  }
  for (const warning of result.warnings) console.warn(`注意：${warning}`);
  return 0;
}

function statusCommand(argv: string[]): number {
  let asJson = false;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { json: { type: "boolean" } },
      strict: true,
    });
    asJson = values.json ?? false;
  } catch (cause) {
    console.error(`${(cause as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const config = loadConfig(defaultConfigPath());
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }

  const statuses = collectStatus(
    config.value,
    loadState(defaultStatePath()),
    new Date()
  );

  if (asJson) {
    console.log(JSON.stringify(statuses, null, 2));
    return 0;
  }

  if (statuses.length === 0) {
    console.log("配置里还没有任何数据源。先运行 mgdb source add 添加一个。");
    return 0;
  }

  const width = Math.max(...statuses.map((status) => status.name.length));
  for (const status of statuses) {
    console.log(
      [
        status.name.padEnd(width),
        formatDateTime(status.lastSuccessAt).padEnd(16),
        `${String(status.count).padStart(3)} 份`,
        formatBytes(status.bytes).padStart(9),
        describeStale(status),
      ].join("  ")
    );
    if (status.lastOk === false && status.lastError) {
      console.log(
        `${" ".repeat(width)}  上次失败：${status.lastError.split("\n")[0]}`
      );
    }
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "backup":
      return backupCommand(rest);
    case "status":
      return statusCommand(rest);
    case "source":
      return sourceCommand(rest);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case undefined: {
      // 动态引入：带参数的命令行路径不加载 Ink 与 React 运行时
      const { startTui } = await import("../tui/start.tsx");
      return startTui();
    }
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

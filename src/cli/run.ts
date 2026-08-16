import { parseArgs } from "node:util";
import { spawnPgTool } from "../adapters/pg-tool.ts";
import { runBackup } from "../core/backup.ts";
import { defaultConfigPath } from "../core/config.ts";
import type { BackupFormat } from "../core/types.ts";

const USAGE = `mgdb — PostgreSQL 备份工具

用法：
  mgdb backup --source <数据源名> [--out <目录>] [--format sql|custom] [--keep <份数>]
  mgdb help

选项：
  -s, --source   要备份的数据源名（必填）
  -o, --out      本次的输出目录，覆盖配置，不写回
  -f, --format   本次的产物格式，sql 或 custom，覆盖配置，不写回
      --keep     本次保留的备份份数，0 表示不清理，覆盖配置，不写回

环境变量：
  MGDB_CONFIG    配置文件位置，默认 ~/.config/mgdb/config.json
`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function parseFormat(
  value: string | undefined
): BackupFormat | undefined | null {
  if (value === undefined) return undefined;
  if (value === "sql" || value === "custom") return value;
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
    console.error(`--format 只能是 sql 或 custom，收到的是 ${rawFormat}`);
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
      runPgTool: spawnPgTool,
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

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "backup":
      return backupCommand(rest);
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case undefined:
      // 交互界面在后续 ticket 引入，届时这里改为动态引入 Ink
      console.log(USAGE);
      return 0;
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

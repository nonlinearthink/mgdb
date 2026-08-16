import { parseArgs } from "node:util";
import {
  addSource,
  defaultConfigPath,
  loadConfig,
  loadConfigOrEmpty,
  removeSource,
  saveConfig,
  updateSource,
} from "../core/config.ts";
import { describeConnection, parsePgUrl } from "../core/datasource.ts";
import { type DataSource, normalizeBackupFormat } from "../core/types.ts";

export const SOURCE_USAGE = `mgdb source — 数据源管理

用法：
  mgdb source list
  mgdb source add --name <名字> --url <连接串> [--out <目录>] [--format sql|dump] [--keep <份数>]
  mgdb source edit --name <名字> [--url <连接串>] [--out <目录>] [--format sql|dump] [--keep <份数>]
  mgdb source remove --name <名字>
`;

interface SourceOptions {
  name?: string;
  url?: string;
  out?: string;
  format?: string;
  keep?: string;
}

function parse(argv: string[]): SourceOptions | undefined {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        name: { type: "string", short: "n" },
        url: { type: "string", short: "u" },
        out: { type: "string", short: "o" },
        format: { type: "string", short: "f" },
        keep: { type: "string" },
      },
      strict: true,
    });
    return values;
  } catch (cause) {
    console.error(`${(cause as Error).message}\n\n${SOURCE_USAGE}`);
    return undefined;
  }
}

type Overrides = Partial<Pick<DataSource, "outDir" | "format" | "keep">>;

function collectOverrides(options: SourceOptions): Overrides | string {
  const overrides: Overrides = {};
  if (options.out !== undefined) overrides.outDir = options.out;
  if (options.format !== undefined) {
    const normalized = normalizeBackupFormat(options.format);
    if (!normalized) {
      return `--format 只能是 sql 或 dump，收到的是 ${options.format}`;
    }
    overrides.format = normalized;
  }
  if (options.keep !== undefined) {
    const keep = Number(options.keep);
    if (!Number.isInteger(keep) || keep < 0) {
      return `--keep 只能是不小于 0 的整数，收到的是 ${options.keep}`;
    }
    overrides.keep = keep;
  }
  return overrides;
}

/** 回显解析结果供确认。密码永远不出现在这里。 */
function echoConnection(name: string, url: string): void {
  const connection = parsePgUrl(url);
  if (connection.ok) {
    console.log(`数据源 ${name} → ${describeConnection(connection.value)}`);
  }
}

function listCommand(): number {
  const config = loadConfig(defaultConfigPath());
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }
  if (config.value.sources.length === 0) {
    console.log("配置里还没有任何数据源。用 mgdb source add 添加一个。");
    return 0;
  }

  const width = Math.max(...config.value.sources.map((s) => s.name.length));
  for (const source of config.value.sources) {
    const connection = parsePgUrl(source.url);
    const target = connection.ok
      ? describeConnection(connection.value)
      : `连接串有问题：${connection.error.split("\n")[0]}`;
    const extras = [
      source.outDir ? `目录=${source.outDir}` : undefined,
      source.format ? `格式=${source.format}` : undefined,
      source.keep === undefined ? undefined : `保留=${source.keep}`,
    ].filter(Boolean);
    console.log(
      `${source.name.padEnd(width)}  ${target}${extras.length ? `  [${extras.join(" ")}]` : ""}`
    );
  }
  return 0;
}

function addCommand(options: SourceOptions): number {
  if (!options.name || !options.url) {
    console.error(`add 需要 --name 和 --url。\n\n${SOURCE_USAGE}`);
    return 2;
  }

  // 先验连接串再落盘：不让一个跑不通的数据源进配置
  const connection = parsePgUrl(options.url);
  if (!connection.ok) {
    console.error(connection.error);
    return 1;
  }

  const overrides = collectOverrides(options);
  if (typeof overrides === "string") {
    console.error(overrides);
    return 2;
  }

  const file = defaultConfigPath();
  const config = loadConfigOrEmpty(file);
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }

  const added = addSource(config.value, {
    name: options.name,
    url: options.url,
    ...overrides,
  });
  if (!added.ok) {
    console.error(added.error);
    return 1;
  }

  const saved = saveConfig(file, added.value);
  if (!saved.ok) {
    console.error(saved.error);
    return 1;
  }

  echoConnection(options.name, options.url);
  console.log(`已添加。现在可以运行：mgdb backup --source ${options.name}`);
  return 0;
}

function editCommand(options: SourceOptions): number {
  if (!options.name) {
    console.error(`edit 需要 --name 指定要修改的数据源。\n\n${SOURCE_USAGE}`);
    return 2;
  }

  if (options.url !== undefined) {
    const connection = parsePgUrl(options.url);
    if (!connection.ok) {
      console.error(connection.error);
      return 1;
    }
  }

  const overrides = collectOverrides(options);
  if (typeof overrides === "string") {
    console.error(overrides);
    return 2;
  }
  if (options.url === undefined && Object.keys(overrides).length === 0) {
    console.error(`edit 至少要改一项。\n\n${SOURCE_USAGE}`);
    return 2;
  }

  const file = defaultConfigPath();
  const config = loadConfig(file);
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }

  const updated = updateSource(config.value, options.name, {
    ...(options.url === undefined ? {} : { url: options.url }),
    ...overrides,
  });
  if (!updated.ok) {
    console.error(updated.error);
    return 1;
  }

  const saved = saveConfig(file, updated.value);
  if (!saved.ok) {
    console.error(saved.error);
    return 1;
  }

  const current = updated.value.sources.find((s) => s.name === options.name);
  if (current) echoConnection(current.name, current.url);
  console.log("已更新。");
  return 0;
}

function removeCommand(options: SourceOptions): number {
  if (!options.name) {
    console.error(`remove 需要 --name 指定要删除的数据源。\n\n${SOURCE_USAGE}`);
    return 2;
  }

  const file = defaultConfigPath();
  const config = loadConfig(file);
  if (!config.ok) {
    console.error(config.error);
    return 1;
  }

  const removed = removeSource(config.value, options.name);
  if (!removed.ok) {
    console.error(removed.error);
    return 1;
  }

  const saved = saveConfig(file, removed.value);
  if (!saved.ok) {
    console.error(saved.error);
    return 1;
  }

  console.log(`已从配置中移除 ${options.name}。已有的备份文件一个都没动。`);
  return 0;
}

export function sourceCommand(argv: string[]): number {
  const [action, ...rest] = argv;
  if (action === "list") return listCommand();

  if (action !== "add" && action !== "edit" && action !== "remove") {
    console.error(
      `未知的 source 子命令：${action ?? "(空)"}\n\n${SOURCE_USAGE}`
    );
    return 2;
  }

  const options = parse(rest);
  if (!options) return 2;

  if (action === "add") return addCommand(options);
  if (action === "edit") return editCommand(options);
  return removeCommand(options);
}

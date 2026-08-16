import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type Config,
  type DataSource,
  type Defaults,
  err,
  ok,
  parseBackupFormat,
  type Result,
} from "./types.ts";

export function expandHome(target: string): string {
  if (target === "~") return os.homedir();
  if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
  return target;
}

export function configDir(): string {
  return path.join(os.homedir(), ".config", "mgdb");
}

export function defaultConfigPath(): string {
  return process.env.MGDB_CONFIG ?? path.join(configDir(), "config.json");
}

/**
 * outDir 故意没有默认值：spec 明确不替使用者挑备份目录。
 * 未配置且未传 --out 时，备份会在 output-dir 步骤明确报错。
 */
export const BUILTIN_DEFAULTS: Defaults = {
  format: "sql",
  keep: 14,
  staleAfterDays: 3,
};

function isFormat(value: unknown): boolean {
  return parseBackupFormat(value) !== undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDefaults(raw: unknown, file: string): Result<Defaults> {
  if (raw === undefined) return ok({ ...BUILTIN_DEFAULTS });
  if (!isPlainObject(raw))
    return err(`配置的 defaults 应当是一个对象：${file}`);

  for (const key of ["outDir", "pgBinDir"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") {
      return err(`defaults.${key} 应当是字符串：${file}`);
    }
  }
  if (raw.format !== undefined && !isFormat(raw.format)) {
    return err(`defaults.format 只能是 "sql" 或 "dump"：${file}`);
  }
  if (
    raw.keep !== undefined &&
    (typeof raw.keep !== "number" ||
      !Number.isInteger(raw.keep) ||
      raw.keep < 0)
  ) {
    return err(`defaults.keep 应当是不小于 0 的整数：${file}`);
  }
  if (
    raw.staleAfterDays !== undefined &&
    (typeof raw.staleAfterDays !== "number" || raw.staleAfterDays <= 0)
  ) {
    return err(`defaults.staleAfterDays 应当是正数：${file}`);
  }

  return ok({
    ...BUILTIN_DEFAULTS,
    ...(typeof raw.outDir === "string" ? { outDir: raw.outDir } : {}),
    ...(typeof raw.pgBinDir === "string" ? { pgBinDir: raw.pgBinDir } : {}),
    ...(parseBackupFormat(raw.format)
      ? { format: parseBackupFormat(raw.format) }
      : {}),
    ...(typeof raw.keep === "number" ? { keep: raw.keep } : {}),
    ...(typeof raw.staleAfterDays === "number"
      ? { staleAfterDays: raw.staleAfterDays }
      : {}),
  });
}

function validateSource(
  raw: unknown,
  index: number,
  file: string
): Result<DataSource> {
  if (!isPlainObject(raw))
    return err(`sources[${index}] 应当是一个对象：${file}`);
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    return err(`sources[${index}] 缺少 name：${file}`);
  }
  if (typeof raw.url !== "string" || !raw.url.trim()) {
    return err(`数据源 ${raw.name} 缺少 url：${file}`);
  }
  if (raw.outDir !== undefined && typeof raw.outDir !== "string") {
    return err(`数据源 ${raw.name} 的 outDir 应当是字符串：${file}`);
  }
  if (raw.format !== undefined && !isFormat(raw.format)) {
    return err(`数据源 ${raw.name} 的 format 只能是 "sql" 或 "dump"：${file}`);
  }
  if (
    raw.keep !== undefined &&
    (typeof raw.keep !== "number" ||
      !Number.isInteger(raw.keep) ||
      raw.keep < 0)
  ) {
    return err(`数据源 ${raw.name} 的 keep 应当是不小于 0 的整数：${file}`);
  }

  return ok({
    name: raw.name.trim(),
    url: raw.url.trim(),
    ...(typeof raw.outDir === "string" ? { outDir: raw.outDir } : {}),
    ...(parseBackupFormat(raw.format)
      ? { format: parseBackupFormat(raw.format) }
      : {}),
    ...(typeof raw.keep === "number" ? { keep: raw.keep } : {}),
  });
}

export function parseConfig(raw: unknown, file: string): Result<Config> {
  if (!isPlainObject(raw)) return err(`配置文件顶层应当是一个对象：${file}`);

  const defaults = validateDefaults(raw.defaults, file);
  if (!defaults.ok) return defaults;

  const rawSources = raw.sources ?? [];
  if (!Array.isArray(rawSources))
    return err(`配置的 sources 应当是一个数组：${file}`);

  const sources: DataSource[] = [];
  const seen = new Set<string>();
  for (const [index, item] of rawSources.entries()) {
    const source = validateSource(item, index, file);
    if (!source.ok) return source;
    if (seen.has(source.value.name)) {
      return err(`配置中存在重名数据源 ${source.value.name}：${file}`);
    }
    seen.add(source.value.name);
    sources.push(source.value);
  }

  return ok({ defaults: defaults.value, sources });
}

export function loadConfig(file: string): Result<Config> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return err(
      `读不到配置文件：${file}\n先用 mgdb source add 添加一个数据源，或用 MGDB_CONFIG 指定配置文件位置。`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return err(`配置文件不是合法的 JSON：${file}\n${(cause as Error).message}`);
  }

  return parseConfig(parsed, file);
}

/**
 * 写配置。权限收紧到仅本人可读写——这个文件里装着数据库密码，
 * 同机的其他账户不该读得到。writeFileSync 的 mode 只在创建时生效，
 * 所以对已存在的文件还要显式 chmod 一次。
 */
export function saveConfig(file: string, config: Config): Result<void> {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(file, 0o600);
    return ok(undefined);
  } catch (cause) {
    return err(`配置写入失败：${file}\n${(cause as Error).message}`);
  }
}

/** 配置文件还不存在时的起点。不预设 outDir，首次使用时由使用者给。 */
export function emptyConfig(): Config {
  return { defaults: { ...BUILTIN_DEFAULTS }, sources: [] };
}

export function loadConfigOrEmpty(file: string): Result<Config> {
  if (!existsSync(file)) return ok(emptyConfig());
  return loadConfig(file);
}

export function addSource(config: Config, source: DataSource): Result<Config> {
  if (config.sources.some((each) => each.name === source.name)) {
    return err(`已经存在同名数据源 ${source.name}，要改用 mgdb source edit。`);
  }
  return ok({ ...config, sources: [...config.sources, source] });
}

export function updateSource(
  config: Config,
  name: string,
  patch: Partial<Omit<DataSource, "name">>
): Result<Config> {
  if (!config.sources.some((each) => each.name === name)) {
    return err(`找不到数据源 ${name}。`);
  }
  return ok({
    ...config,
    sources: config.sources.map((each) =>
      each.name === name ? { ...each, ...patch } : each
    ),
  });
}

/** 只从配置里摘掉，绝不碰该数据源已经产出的备份文件 */
export function removeSource(config: Config, name: string): Result<Config> {
  if (!config.sources.some((each) => each.name === name)) {
    return err(`找不到数据源 ${name}。`);
  }
  return ok({
    ...config,
    sources: config.sources.filter((each) => each.name !== name),
  });
}

export function findSource(config: Config, name: string): Result<DataSource> {
  const found = config.sources.find((source) => source.name === name);
  if (found) return ok(found);
  if (config.sources.length === 0) {
    return err(`配置里还没有任何数据源。先运行 mgdb source add 添加一个。`);
  }
  return err(
    `找不到数据源 ${name}。当前可用的数据源：${config.sources.map((s) => s.name).join("、")}`
  );
}

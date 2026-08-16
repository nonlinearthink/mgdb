/**
 * 备份产物格式。`sql` 是纯文本，`dump` 是 pgsql 的自定义压缩格式。
 *
 * pg_dump 自己管后者叫 "custom"，但那个词脱离上下文毫无意义，
 * 对外一律用 dump——和产物扩展名也对得上。
 */
export const BACKUP_FORMATS = ["sql", "dump"] as const;
export type BackupFormat = (typeof BACKUP_FORMATS)[number];

/** 兼容早期配置里写的 "custom"，读得进来，写出去一律是 dump */
export function normalizeBackupFormat(
  value: unknown
): BackupFormat | undefined {
  if (value === "sql") return "sql";
  if (value === "dump" || value === "custom") return "dump";
  return undefined;
}

export interface DataSource {
  name: string;
  url: string;
  /** 以下三项不填则继承 defaults */
  outDir?: string;
  format?: BackupFormat;
  keep?: number;
}

export interface Defaults {
  /** 不给默认值：spec 明确不替使用者选备份目录，未配置且未传 --out 时报错 */
  outDir?: string;
  format: BackupFormat;
  keep: number;
  /** 指定后即为权威路径，不再回退 PATH；留空才走 PATH 与常见安装位置 */
  pgBinDir?: string;
  /** 超过多少天没有成功备份即视为超期 */
  staleAfterDays: number;
}

export interface Config {
  defaults: Defaults;
  sources: DataSource[];
}

/**
 * 一次 postgres 命令行工具的调用。pg_dump 与 pg_restore 共用这一个 port，
 * 所以整个工具只有一个子进程接缝。
 */
export interface PgToolInvocation {
  bin: string;
  args: string[];
  /** 只放需要额外注入的变量（如 PGPASSWORD），由适配层并进 process.env */
  env: Record<string, string>;
}

export interface PgToolOutcome {
  code: number | null;
  stderr: string;
  /** 可执行文件根本没起来时填这里，code 为 null */
  spawnError?: string;
}

export type RunPgTool = (
  invocation: PgToolInvocation
) => Promise<PgToolOutcome>;

export interface Notification {
  title: string;
  body: string;
}

/** 主动把失败推给使用者的通道。失败可见性靠它，不靠使用者主动来看。 */
export type Notify = (notification: Notification) => Promise<void>;

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

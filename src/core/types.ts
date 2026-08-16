/** 备份产物格式。`sql` 为纯文本，`custom` 为 pg_dump 自定义压缩格式。 */
export type BackupFormat = "sql" | "custom";

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

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

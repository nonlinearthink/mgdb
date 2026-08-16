import { err, ok, type Result } from "./types.ts";

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  /** 连接串里没带密码时为 undefined，此时不设置 PGPASSWORD */
  password?: string;
  database: string;
}

const ALLOWED_PROTOCOLS = new Set(["postgresql:", "postgres:"]);

/** 任何要回显或写进错误信息的连接串都必须先过这里，避免密码泄漏到终端和日志 */
export function maskUrl(raw: string): string {
  return raw.replace(/(:\/\/[^:@/]*):[^@]*@/, "$1:***@");
}

function decodeComponent(value: string, label: string): Result<string> {
  try {
    return ok(decodeURIComponent(value));
  } catch {
    return err(`连接串的${label}里存在非法的 URL 编码`);
  }
}

export function parsePgUrl(raw: string): Result<PgConnection> {
  const trimmed = raw.trim();
  if (!trimmed) return err("连接串为空");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return err(`不是合法的连接串：${maskUrl(trimmed)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return err(
      `只支持 postgresql:// 或 postgres:// 开头的连接串，收到的是 ${url.protocol}//`
    );
  }
  if (!url.hostname) return err("连接串缺少主机名");

  const database = decodeComponent(url.pathname.replace(/^\//, ""), "数据库名");
  if (!database.ok) return database;
  if (!database.value) return err("连接串缺少数据库名");

  const user = decodeComponent(url.username, "用户名");
  if (!user.ok) return user;
  if (!user.value) return err("连接串缺少用户名");

  const password = decodeComponent(url.password, "密码");
  if (!password.ok) return password;

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return err(`连接串里的端口非法：${url.port}`);
  }

  return ok({
    host: url.hostname,
    port,
    user: user.value,
    ...(password.value ? { password: password.value } : {}),
    database: database.value,
  });
}

/** 给人看的连接描述，永远不含密码 */
export function describeConnection(connection: PgConnection): string {
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`;
}

/** 逐字段编辑之后重新拼回连接串。各段都要编码，否则密码里的 @ 会把连接串拆坏。 */
export function buildPgUrl(connection: PgConnection): string {
  const auth = connection.password
    ? `${encodeURIComponent(connection.user)}:${encodeURIComponent(connection.password)}`
    : encodeURIComponent(connection.user);
  return `postgresql://${auth}@${connection.host}:${connection.port}/${encodeURIComponent(
    connection.database
  )}`;
}

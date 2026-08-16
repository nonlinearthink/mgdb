import { accessSync, constants } from "node:fs";
import path from "node:path";
import { expandHome } from "./config.ts";
import { err, ok, type Result } from "./types.ts";

export type PgTool = "pg_dump" | "pg_restore";

/** macOS 上 libpq / Postgres.app 的常见落点。PATH 里找不到时按顺序探测。 */
const COMMON_PG_BIN_DIRS = [
  "/opt/homebrew/opt/libpq/bin",
  "/usr/local/opt/libpq/bin",
  "/Applications/Postgres.app/Contents/Versions/latest/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

const INSTALL_HINT =
  "macOS 上可用 brew install libpq 安装，装好后通常在 /opt/homebrew/opt/libpq/bin。";

function executableAt(dir: string, tool: PgTool): string | undefined {
  const candidate = path.join(dir, tool);
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * 定位备份/还原工具。
 *
 * 配置了 pgBinDir 就以它为准，找不到即报错、**不回退 PATH** —— 显式配置不应该被
 * 环境里碰巧存在的另一个版本悄悄顶替，那种「跑的不是我配的那个」最难排查。
 */
export function locatePgTool(tool: PgTool, pgBinDir?: string): Result<string> {
  if (pgBinDir) {
    const dir = expandHome(pgBinDir);
    const found = executableAt(dir, tool);
    if (found) return ok(found);
    return err(
      `在配置的 pgBinDir 下找不到可执行的 ${tool}：${dir}\n` +
        `配置了 pgBinDir 就以它为准，不会回退 PATH。请确认路径无误，或删掉该配置改为自动探测。\n` +
        INSTALL_HINT
    );
  }

  const onPath = Bun.which(tool);
  if (onPath) return ok(onPath);

  for (const dir of COMMON_PG_BIN_DIRS) {
    const found = executableAt(dir, tool);
    if (found) return ok(found);
  }

  return err(
    `找不到 ${tool}：PATH 和常见安装位置里都没有。\n` +
      `${INSTALL_HINT}\n` +
      `也可以把所在目录配到 defaults.pgBinDir。`
  );
}

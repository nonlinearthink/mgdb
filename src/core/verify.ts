import {
  type BackupFormat,
  err,
  ok,
  type Result,
  type RunPgTool,
} from "./types.ts";

/** pg_dump 写在纯 SQL 产物最末尾的收尾标记，写完整了才有 */
const SQL_COMPLETION_MARKER = "-- PostgreSQL database dump complete";
/** custom 格式产物的文件头魔数 */
const CUSTOM_MAGIC = "PGDMP";
const TAIL_BYTES = 8192;

/**
 * 校验产物的完整性。这是「文件大小非 0」之外的第二道闸，用来挡住结构不完整的产物。
 *
 * 需要说明边界：主要的失败信号仍然是 pg_dump 的退出码——网断、盘满都会让它非零退出。
 * 这里挡的是「退出码 0 但产物不对劲」的情况：纯 SQL 缺收尾标记是可靠的截断判据；
 * custom 格式则先看魔数、再让 pg_restore 读一遍目录，能挡住格式不对和文件头损坏，
 * 但读目录只碰 TOC，挡不住数据段中途被截断——那种情况靠退出码。
 */
export async function verifyDump(
  file: string,
  format: BackupFormat,
  runPgTool: RunPgTool,
  pgRestoreBin?: string
): Promise<Result<void>> {
  const handle = Bun.file(file);
  const size = handle.size;
  if (size === 0) {
    return err(`产物是空文件：${file}`);
  }

  if (format === "sql") {
    const tail = await handle.slice(Math.max(0, size - TAIL_BYTES)).text();
    if (!tail.includes(SQL_COMPLETION_MARKER)) {
      return err(
        `产物末尾没有 pg_dump 的收尾标记（${SQL_COMPLETION_MARKER}），这份 dump 没有正常写完。\n` +
          `已丢弃该产物，任何已有备份都未被触碰。`
      );
    }
    return ok(undefined);
  }

  const head = await handle.slice(0, CUSTOM_MAGIC.length).text();
  if (head !== CUSTOM_MAGIC) {
    return err(
      `产物开头不是 custom 格式的 ${CUSTOM_MAGIC} 魔数（实际是 ${JSON.stringify(head)}）。\n` +
        `已丢弃该产物，任何已有备份都未被触碰。`
    );
  }

  if (!pgRestoreBin) {
    return err("缺少 pg_restore，无法校验 custom 格式产物");
  }

  const outcome = await runPgTool({
    bin: pgRestoreBin,
    args: ["--list", file],
    env: {},
  });

  if (outcome.spawnError) {
    return err(`启动 pg_restore 校验产物失败：${outcome.spawnError}`);
  }
  if (outcome.code !== 0) {
    const detail = outcome.stderr.trim();
    return err(
      `pg_restore --list 读不出产物目录（退出码 ${outcome.code}）${detail ? `\n${detail}` : ""}\n` +
        `已丢弃该产物，任何已有备份都未被触碰。`
    );
  }

  return ok(undefined);
}

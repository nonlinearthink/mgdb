import type { RunPgDump } from "../core/backup.ts";

/** 真实的备份子进程。测试里被换成假实现，所以这里不含任何业务判断。 */
export const spawnPgDump: RunPgDump = async (invocation) => {
  try {
    const proc = Bun.spawn([invocation.bin, ...invocation.args], {
      env: { ...process.env, ...invocation.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, stderr };
  } catch (cause) {
    return { code: null, stderr: "", spawnError: (cause as Error).message };
  }
};

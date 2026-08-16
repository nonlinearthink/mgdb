/**
 * 与 backup.test.ts 同一个接缝（runBackup），这里专注原子写入、格式感知校验与格式选择。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { runBackup } from "./backup.ts";
import {
  BOGUS_CUSTOM,
  defaultSource,
  FIXED_STAMP,
  fakePgTools,
  fixedClock,
  makeConfig,
  makeFakePgBinDir,
  makeRoot,
  noopNotify,
  outputPathOf,
  TRUNCATED_SQL,
  VALID_CUSTOM,
  writeConfigFile,
} from "./test-harness.ts";

let root: string;
let outDir: string;

beforeEach(() => {
  root = makeRoot();
  outDir = path.join(root, "backups");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 只算真正的备份产物，latest 指针不是一份备份 */
function backupsIn(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => !name.includes("-latest."))
        .sort()
    : [];
}

describe("原子写入", () => {
  test("过程中写临时文件，成功后才出现正式产物", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    let midFlight: string[] = [];
    const pg = fakePgTools({
      onDump: () => {
        midFlight = backupsIn(outDir);
      },
    });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    // 执行中：目录里只有临时文件，没有任何看起来像正式备份的东西
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0]!.startsWith(".")).toBe(true);
    expect(midFlight[0]!.endsWith(".tmp")).toBe(true);

    // 执行后：只剩正式产物，临时文件已消失
    expect(result.ok).toBe(true);
    expect(backupsIn(outDir)).toEqual([`manygames-local-${FIXED_STAMP}.sql`]);
  });

  test("pg_dump 被告知写向临时文件而不是正式产物", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    const target = outputPathOf(pg.dumpCalls[0]!.args)!;
    expect(path.basename(target).startsWith(".")).toBe(true);
    expect(target).not.toBe(
      path.join(outDir, `manygames-local-${FIXED_STAMP}.sql`)
    );
  });

  test("产物内容原封不动地搬到正式文件名下", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({
      contents: "-- x\n-- PostgreSQL database dump complete\n",
    });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(result.file, "utf8")).toBe(
      "-- x\n-- PostgreSQL database dump complete\n"
    );
  });
});

describe("失败时不留残留、不动已有备份", () => {
  test("pg_dump 已写出半截内容后失败，临时文件被清理", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ code: 1, contents: TRUNCATED_SQL });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    expect(backupsIn(outDir)).toEqual([]);
  });

  test("port 抛异常（进程被打断）时临时文件被清理", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ throwOnDump: new Error("interrupted") });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("dump");
    expect(backupsIn(outDir)).toEqual([]);
  });

  test("本次失败不影响之前已经备好的产物", async () => {
    mkdirSync(outDir, { recursive: true });
    const existing = path.join(outDir, "manygames-local-20260815-020000.sql");
    writeFileSync(existing, "上一份完好的备份");

    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ code: 1, contents: TRUNCATED_SQL });

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(readFileSync(existing, "utf8")).toBe("上一份完好的备份");
    expect(backupsIn(outDir)).toEqual(["manygames-local-20260815-020000.sql"]);
  });
});

describe("格式感知校验", () => {
  test("截断的 SQL 产物被拒，失败在 verify 步骤", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ contents: TRUNCATED_SQL });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("verify");
    expect(backupsIn(outDir)).toEqual([]);
  });

  test("空产物被拒，失败在 verify 步骤", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ contents: "" });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("verify");
  });

  test("custom 产物经 pg_restore --list 校验", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, format: "custom" } })
    );
    const pg = fakePgTools({ contents: VALID_CUSTOM });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(true);
    expect(pg.restoreCalls).toHaveLength(1);
    expect(pg.restoreCalls[0]!.args).toContain("--list");
    expect(backupsIn(outDir)).toEqual([`manygames-local-${FIXED_STAMP}.dump`]);
  });

  test("custom 产物列不出目录时被拒", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, format: "custom" } })
    );
    const pg = fakePgTools({ contents: VALID_CUSTOM, restoreListCode: 1 });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("verify");
    expect(backupsIn(outDir)).toEqual([]);
  });

  test("custom 产物缺 PGDMP 魔数时被拒，且不必再跑 pg_restore", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, format: "custom" } })
    );
    const pg = fakePgTools({ contents: BOGUS_CUSTOM });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("verify");
    expect(pg.restoreCalls).toHaveLength(0);
  });

  test("纯 SQL 格式不会去调 pg_restore", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(pg.restoreCalls).toHaveLength(0);
  });
});

describe("格式选择", () => {
  test("custom 格式产物扩展名为 dump 且带上 --format custom", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ contents: VALID_CUSTOM });

    const result = await runBackup(
      { sourceName: "manygames-local", format: "custom" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok && path.basename(result.file)).toBe(
      `manygames-local-${FIXED_STAMP}.dump`
    );
    const { args } = pg.dumpCalls[0]!;
    expect(args[args.indexOf("--format") + 1]).toBe("custom");
  });

  test("单次指定的格式覆盖数据源配置，数据源配置覆盖全局默认值", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, {
        defaults: { outDir, format: "sql" },
        sources: [defaultSource({ format: "custom" })],
      })
    );

    const inherited = fakePgTools({ contents: VALID_CUSTOM });
    const fromSource = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: inherited.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );
    expect(fromSource.ok && path.extname(fromSource.file)).toBe(".dump");

    const overridden = fakePgTools();
    const fromCli = await runBackup(
      { sourceName: "manygames-local", format: "sql" },
      {
        configPath,
        runPgTool: overridden.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );
    expect(fromCli.ok && path.extname(fromCli.file)).toBe(".sql");
  });

  test("custom 格式下找不到 pg_restore 时在开跑前就失败", async () => {
    const configPath = writeConfigFile(
      root,
      makeConfig(root, {
        defaults: {
          outDir,
          format: "custom",
          pgBinDir: makeFakePgBinDir(root, ["pg_dump"]),
        },
      })
    );
    const pg = fakePgTools({ contents: VALID_CUSTOM });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("pg-tool");
    expect(result.failure.message).toContain("pg_restore");
    // 校验工具不到位就别浪费一次可能几十分钟的 dump
    expect(pg.dumpCalls).toHaveLength(0);
  });
});

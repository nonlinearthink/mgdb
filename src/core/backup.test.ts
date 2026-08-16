import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBackup } from "./backup.ts";
import {
  defaultSource,
  FIXED_STAMP,
  fakePgTools,
  fixedClock,
  makeConfig,
  makeEmptyPgBinDir,
  makeRoot,
  noopNotify,
  outputPathOf,
  VALID_SQL,
  writeConfigFile,
} from "./test-harness.ts";

let root: string;

beforeEach(() => {
  root = makeRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("runBackup — 成功路径", () => {
  test("产出以数据源名和秒级时间戳命名的文件", async () => {
    const config = makeConfig(root);
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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
    expect(path.basename(result.file)).toBe(
      `manygames-local-${FIXED_STAMP}.sql`
    );
    expect(existsSync(result.file)).toBe(true);
    expect(result.bytes).toBe(VALID_SQL.length);
  });

  test("输出目录不存在时自动创建", async () => {
    const outDir = path.join(root, "deep", "nested", "backups");
    const config = makeConfig(root, { defaults: { outDir } });
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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
    expect(existsSync(outDir)).toBe(true);
  });

  test("连接串被拆成 pg_dump 的各个参数", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
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

    expect(pg.calls).toHaveLength(1);
    const { args } = pg.calls[0]!;
    expect(args).toContain("--host");
    expect(args[args.indexOf("--host") + 1]).toBe("localhost");
    expect(args[args.indexOf("--port") + 1]).toBe("5490");
    expect(args[args.indexOf("--username") + 1]).toBe("manydreamstech");
    expect(args[args.indexOf("--dbname") + 1]).toBe("manygames");
  });

  test("端口缺省时按 5432 处理", async () => {
    const config = makeConfig(root, {
      sources: [
        defaultSource({ url: "postgresql://u:p@db.example.com/manygames" }),
      ],
    });
    const configPath = writeConfigFile(root, config);
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

    const { args } = pg.calls[0]!;
    expect(args[args.indexOf("--port") + 1]).toBe("5432");
  });

  test("产物不携带源库的属主与权限信息", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
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

    expect(pg.calls[0]!.args).toContain("--no-owner");
    expect(pg.calls[0]!.args).toContain("--no-privileges");
  });
});

describe("runBackup — 密码处理", () => {
  test("密码经环境变量传入，不出现在命令行参数中", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
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

    const call = pg.calls[0]!;
    expect(call.env.PGPASSWORD).toBe("s3cret");
    expect(call.args.join(" ")).not.toContain("s3cret");
  });

  test("URL 编码的密码被还原成原文", async () => {
    const config = makeConfig(root, {
      sources: [
        defaultSource({
          url: "postgresql://u%40admin:p%40ss%2Fw%3Ard@localhost:5490/manygames",
        }),
      ],
    });
    const configPath = writeConfigFile(root, config);
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

    const call = pg.calls[0]!;
    expect(call.env.PGPASSWORD).toBe("p@ss/w:rd");
    expect(call.args[call.args.indexOf("--username") + 1]).toBe("u@admin");
  });

  test("无密码的连接串不设置 PGPASSWORD", async () => {
    const config = makeConfig(root, {
      sources: [
        defaultSource({ url: "postgresql://u@localhost:5490/manygames" }),
      ],
    });
    const configPath = writeConfigFile(root, config);
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

    expect(pg.calls[0]!.env.PGPASSWORD).toBeUndefined();
  });
});

describe("runBackup — 参数优先级", () => {
  test("命令行覆盖数据源配置，数据源配置覆盖全局默认值", async () => {
    const cliDir = path.join(root, "from-cli");
    const sourceDir = path.join(root, "from-source");
    const config = makeConfig(root, {
      defaults: { outDir: path.join(root, "from-defaults") },
      sources: [defaultSource({ outDir: sourceDir })],
    });
    const configPath = writeConfigFile(root, config);

    const first = fakePgTools();
    const withCli = await runBackup(
      { sourceName: "manygames-local", outDir: cliDir },
      {
        configPath,
        runPgTool: first.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );
    expect(withCli.ok && path.dirname(withCli.file)).toBe(cliDir);

    const second = fakePgTools();
    const withoutCli = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        runPgTool: second.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );
    expect(withoutCli.ok && path.dirname(withoutCli.file)).toBe(sourceDir);
  });

  test("数据源未覆盖时继承全局默认输出目录", async () => {
    const defaultsDir = path.join(root, "from-defaults");
    const config = makeConfig(root, { defaults: { outDir: defaultsDir } });
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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

    expect(result.ok && path.dirname(result.file)).toBe(defaultsDir);
  });
});

describe("runBackup — 失败路径", () => {
  test("配置文件不存在时失败在 config 步骤", async () => {
    const pg = fakePgTools();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath: path.join(root, "nope.json"),
        runPgTool: pg.run,
        now: fixedClock,
        statePath: path.join(root, "state.json"),
        notify: noopNotify,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe("config");
    expect(pg.calls).toHaveLength(0);
  });

  test("配置文件内容损坏时失败在 config 步骤且说明原因", async () => {
    const configPath = path.join(root, "config.json");
    writeFileSync(configPath, "{ this is not json");
    const pg = fakePgTools();

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
    expect(result.failure.step).toBe("config");
    expect(result.failure.message).toContain(configPath);
  });

  test("数据源不存在时失败在 source 步骤并列出可用数据源", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
    const pg = fakePgTools();

    const result = await runBackup(
      { sourceName: "typo-name" },
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
    expect(result.failure.step).toBe("source");
    expect(result.failure.message).toContain("manygames-local");
  });

  test("连接串非法时失败在 connection 步骤", async () => {
    const config = makeConfig(root, {
      sources: [defaultSource({ url: "mysql://u:p@localhost:3306/manygames" })],
    });
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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
    expect(result.failure.step).toBe("connection");
    expect(pg.calls).toHaveLength(0);
  });

  test("未配置输出目录且未传 --out 时失败在 output-dir 步骤", async () => {
    const config = makeConfig(root, { defaults: { outDir: undefined } });
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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
    expect(result.failure.step).toBe("output-dir");
  });

  test("找不到备份工具时报出解决办法而非底层错误码", async () => {
    const config = makeConfig(root, {
      defaults: { pgBinDir: makeEmptyPgBinDir(root) },
    });
    const configPath = writeConfigFile(root, config);
    const pg = fakePgTools();

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
    expect(result.failure.message).toContain("pg_dump");
    expect(result.failure.message).toContain("brew install libpq");
    expect(pg.calls).toHaveLength(0);
  });

  test("子进程非零退出时判定为失败并带上 stderr", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
    const pg = fakePgTools({ code: 1, stderr: "pg_dump: error: 权限不足" });

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
    expect(result.failure.message).toContain("权限不足");
  });

  test("子进程启动失败时报出可读原因", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
    const pg = fakePgTools({ spawnError: "spawn EACCES" });

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
    expect(result.failure.message).toContain("EACCES");
  });

  test("失败时错误上下文带上数据源名", async () => {
    const configPath = writeConfigFile(root, makeConfig(root));
    const pg = fakePgTools({ code: 2 });

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
    expect(result.source).toBe("manygames-local");
  });

  test("子进程失败后备份目录中不留下任何产物", async () => {
    const outDir = path.join(root, "backups");
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir } })
    );
    const pg = fakePgTools({ code: 1 });

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

    expect(readdirSync(outDir)).toEqual([]);
  });
});

describe("runBackup — 子进程收到的产物路径", () => {
  test("pg_dump 被告知写向备份目录下的目标路径", async () => {
    const outDir = path.join(root, "backups");
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

    const target = outputPathOf(pg.calls[0]!.args);
    expect(target).toBeDefined();
    expect(path.dirname(target!)).toBe(outDir);
  });
});

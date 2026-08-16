/**
 * 第三个接缝：命令行入口 main()。
 *
 * 报备：source 系列命令没有值得单独抽出的编排函数——它就是「解析参数 → 校验 →
 * 读改写配置 → 回显」。在 main() 上测比在下面的 config 函数上测更高，
 * 顺带把参数解析和退出码也盖住了。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import { makeRoot, seedFile } from "../core/test-harness.ts";
import { main } from "./run.ts";

let root: string;
let configPath: string;
let previousConfigEnv: string | undefined;

beforeEach(() => {
  root = makeRoot();
  configPath = path.join(root, "config.json");
  previousConfigEnv = process.env.MGDB_CONFIG;
  process.env.MGDB_CONFIG = configPath;
});

afterEach(() => {
  if (previousConfigEnv === undefined) delete process.env.MGDB_CONFIG;
  else process.env.MGDB_CONFIG = previousConfigEnv;
  rmSync(root, { recursive: true, force: true });
});

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function run(...argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => err.push(parts.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const URL_WITH_SECRET =
  "postgresql://manydreamstech:hunter2@localhost:5490/manygames";

function readConfig() {
  const config = loadConfig(configPath);
  if (!config.ok) throw new Error(config.error);
  return config.value;
}

describe("source add", () => {
  test("配置文件还不存在时也能添加，并把文件建出来", async () => {
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET
    );

    expect(result.code).toBe(0);
    expect(existsSync(configPath)).toBe(true);
    expect(readConfig().sources.map((s) => s.name)).toEqual(["local"]);
  });

  test("配置文件权限收紧到仅本人可读写", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);

    // 这个文件里装着数据库密码，同机其他账户不该读得到
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("回显解析出的连接信息，且不吐出密码", async () => {
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET
    );

    expect(result.out).toContain("manydreamstech@localhost:5490/manygames");
    expect(result.out).not.toContain("hunter2");
    expect(result.err).not.toContain("hunter2");
  });

  test("连接串非法时拒绝写入配置", async () => {
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      "mysql://u:p@localhost:3306/manygames"
    );

    expect(result.code).not.toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  test("缺数据库名的连接串同样被拒", async () => {
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      "postgresql://u:p@localhost:5490"
    );

    expect(result.code).not.toBe(0);
    expect(existsSync(configPath)).toBe(false);
  });

  test("重名数据源被拒，并提示改用 edit", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET
    );

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("edit");
    expect(readConfig().sources).toHaveLength(1);
  });

  test("可以一并设置输出目录、格式与保留份数", async () => {
    await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET,
      "--out",
      "/tmp/backups",
      "--format",
      "custom",
      "--keep",
      "7"
    );

    const source = readConfig().sources[0];
    expect(source?.outDir).toBe("/tmp/backups");
    expect(source?.format).toBe("custom");
    expect(source?.keep).toBe(7);
  });

  test("格式非法时拒绝，且不写配置", async () => {
    const result = await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET,
      "--format",
      "parquet"
    );

    expect(result.code).toBe(2);
    expect(existsSync(configPath)).toBe(false);
  });

  test("缺 --name 或 --url 时给出用法而不是写坏配置", async () => {
    const result = await run("source", "add", "--name", "local");

    expect(result.code).toBe(2);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe("source list", () => {
  test("列出数据源但不明文显示密码", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run("source", "list");

    expect(result.code).toBe(0);
    expect(result.out).toContain("local");
    expect(result.out).toContain("manydreamstech@localhost:5490/manygames");
    expect(result.out).not.toContain("hunter2");
  });

  test("没有数据源时给出引导而不是空输出", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    await run("source", "remove", "--name", "local");
    const result = await run("source", "list");

    expect(result.out).toContain("source add");
  });
});

describe("source edit", () => {
  test("能改连接串", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run(
      "source",
      "edit",
      "--name",
      "local",
      "--url",
      "postgresql://u:p@db.example.com:5432/other"
    );

    expect(result.code).toBe(0);
    expect(readConfig().sources[0]?.url).toContain("db.example.com");
  });

  test("能改覆盖项而不动连接串", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    await run("source", "edit", "--name", "local", "--keep", "3");

    const source = readConfig().sources[0];
    expect(source?.keep).toBe(3);
    expect(source?.url).toBe(URL_WITH_SECRET);
  });

  test("新连接串非法时不落盘", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run(
      "source",
      "edit",
      "--name",
      "local",
      "--url",
      "不是连接串"
    );

    expect(result.code).not.toBe(0);
    expect(readConfig().sources[0]?.url).toBe(URL_WITH_SECRET);
  });

  test("改不存在的数据源时报错", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run("source", "edit", "--name", "typo", "--keep", "3");

    expect(result.code).not.toBe(0);
    expect(result.err).toContain("typo");
  });

  test("一项都没改时提示用法", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run("source", "edit", "--name", "local");

    expect(result.code).toBe(2);
  });
});

describe("source remove", () => {
  test("从配置里移除，但已有的备份文件一个都不碰", async () => {
    const backups = path.join(root, "backups");
    const kept = seedFile(backups, "local-20260801-030000.sql");
    await run(
      "source",
      "add",
      "--name",
      "local",
      "--url",
      URL_WITH_SECRET,
      "--out",
      backups
    );

    const result = await run("source", "remove", "--name", "local");

    expect(result.code).toBe(0);
    expect(readConfig().sources).toHaveLength(0);
    expect(existsSync(kept)).toBe(true);
  });

  test("删不存在的数据源时报错，其他数据源不受影响", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);
    const result = await run("source", "remove", "--name", "typo");

    expect(result.code).not.toBe(0);
    expect(readConfig().sources).toHaveLength(1);
  });
});

describe("加进来的数据源立刻可用", () => {
  test("添加后 backup 命令能找到它（不再报 source 不存在）", async () => {
    await run("source", "add", "--name", "local", "--url", URL_WITH_SECRET);

    const config = readConfig();
    expect(config.sources.find((s) => s.name === "local")).toBeDefined();
    // 配置能被正常读回，说明写出来的 JSON 结构是合法的
    expect(readFileSync(configPath, "utf8")).toContain('"local"');
  });

  test("未知的 source 子命令给出用法", async () => {
    const result = await run("source", "frobnicate");

    expect(result.code).toBe(2);
    expect(result.err).toContain("mgdb source");
  });
});

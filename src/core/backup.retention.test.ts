/**
 * 与 backup.test.ts 同一个接缝（runBackup），这里专注保留清理。
 *
 * 清理是整个工具里唯一会销毁数据的逻辑，所以「哪些必须活着」的断言比
 * 「哪些该被删」更重要——备份目录很可能是 ~/Downloads 这种混杂目录。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { runBackup } from "./backup.ts";
import {
  defaultSource,
  FIXED_STAMP,
  fakePgTools,
  fixedClock,
  makeConfig,
  makeRoot,
  noopNotify,
  seedFile,
  TRUNCATED_SQL,
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

/** 目录里的一切。不做任何过滤——多出来的东西必须让断言看见。 */
function backupsIn(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function runWith(configPath: string, keep?: number) {
  const pg = fakePgTools();
  return runBackup(
    { sourceName: "manygames-local", ...(keep === undefined ? {} : { keep }) },
    {
      configPath,
      runPgTool: pg.run,
      now: fixedClock,
      statePath: path.join(root, "state.json"),
      notify: noopNotify,
    }
  );
}

/** 造 n 份历史备份，时间戳依次更早 */
function seedHistory(count: number, source = "manygames-local"): string[] {
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    const day = String(index + 1).padStart(2, "0");
    const name = `${source}-202607${day}-030000.sql`;
    seedFile(outDir, name);
    names.push(name);
  }
  return names;
}

describe("保留份数", () => {
  test("超出保留份数时删掉最旧的几份", async () => {
    seedHistory(5);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 3 } })
    );

    const result = await runWith(configPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5 份历史 + 1 份新的 = 6，保留 3 份
    expect(backupsIn(outDir)).toEqual([
      "manygames-local-20260704-030000.sql",
      "manygames-local-20260705-030000.sql",
      `manygames-local-${FIXED_STAMP}.sql`,
    ]);
    expect(result.pruned.sort()).toEqual([
      "manygames-local-20260701-030000.sql",
      "manygames-local-20260702-030000.sql",
      "manygames-local-20260703-030000.sql",
    ]);
  });

  test("不足保留份数时一个都不删", async () => {
    seedHistory(2);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 14 } })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned).toEqual([]);
    expect(backupsIn(outDir)).toHaveLength(3);
  });

  test("正好等于保留份数时一个都不删", async () => {
    seedHistory(2);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 3 } })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned).toEqual([]);
    expect(backupsIn(outDir)).toHaveLength(3);
  });

  test("保留份数为 0 表示永不清理", async () => {
    seedHistory(20);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 0 } })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned).toEqual([]);
    expect(backupsIn(outDir)).toHaveLength(21);
  });

  test("保留份数优先级：单次指定 > 数据源 > 全局默认值", async () => {
    seedHistory(5);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, {
        defaults: { outDir, keep: 14 },
        sources: [defaultSource({ keep: 4 })],
      })
    );

    const result = await runWith(configPath, 2);

    expect(result.ok && result.pruned).toHaveLength(4);
    expect(backupsIn(outDir)).toHaveLength(2);
  });

  test("数据源上的保留份数覆盖全局默认值", async () => {
    seedHistory(5);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, {
        defaults: { outDir, keep: 14 },
        sources: [defaultSource({ keep: 4 })],
      })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned).toHaveLength(2);
    expect(backupsIn(outDir)).toHaveLength(4);
  });

  test("混合格式时按数据源统一计数", async () => {
    seedFile(outDir, "manygames-local-20260701-030000.sql");
    seedFile(outDir, "manygames-local-20260702-030000.dump");
    seedFile(outDir, "manygames-local-20260703-030000.sql");
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 2 } })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned.sort()).toEqual([
      "manygames-local-20260701-030000.sql",
      "manygames-local-20260702-030000.dump",
    ]);
  });
});

describe("清理范围：只碰本工具生成的、属于该数据源的文件", () => {
  test("不合命名规则的文件一律不动", async () => {
    seedHistory(5);
    seedFile(outDir, "随手放的笔记.txt");
    seedFile(outDir, "manygames-backup.sql"); // 旧脚本留下的命名
    seedFile(outDir, "manygames-local.sql"); // 缺时间戳
    seedFile(outDir, "manygames-local-2026-07-01.sql"); // 时间戳格式不对
    seedFile(outDir, "report.pdf");

    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 1 } })
    );

    await runWith(configPath);

    for (const survivor of [
      "随手放的笔记.txt",
      "manygames-backup.sql",
      "manygames-local.sql",
      "manygames-local-2026-07-01.sql",
      "report.pdf",
    ]) {
      expect(existsSync(path.join(outDir, survivor))).toBe(true);
    }
  });

  test("其他数据源的产物一律不动", async () => {
    seedHistory(5);
    seedHistory(5, "manygames-prod");

    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 1 } })
    );

    const result = await runWith(configPath);

    expect(
      result.ok && result.pruned.every((n) => n.startsWith("manygames-local-"))
    ).toBe(true);
    expect(
      backupsIn(outDir).filter((n) => n.startsWith("manygames-prod-"))
    ).toHaveLength(5);
  });

  test("备份失败时不执行任何清理", async () => {
    seedHistory(20);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 1 } })
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
    // 既没有新备份、又丢了旧备份，是这个工具最坏的失效模式
    expect(backupsIn(outDir)).toHaveLength(20);
  });
});

describe("回归：刚落盘的产物永远不能被本次清理删掉", () => {
  test("目录里存在时间戳更晚的备份时，新产物仍然活着", async () => {
    // 时钟回拨、从别处拷回旧目录、手工改名，都会造成「未来时间戳」
    seedFile(outDir, "manygames-local-20991231-235959.sql", "来自未来");
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 1 } })
    );

    const result = await runWith(configPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 报告成功就必须真的留下产物，否则退出码 0 是在撒谎
    expect(existsSync(result.file)).toBe(true);
    expect(result.pruned).not.toContain(`manygames-local-${FIXED_STAMP}.sql`);
    expect(result.pruned).toContain("manygames-local-20991231-235959.sql");
  });

  test("keep=1 时旧备份仍然照删，保护不等于放弃清理", async () => {
    seedHistory(4);
    const configPath = writeConfigFile(
      root,
      makeConfig(root, { defaults: { outDir, keep: 1 } })
    );

    const result = await runWith(configPath);

    expect(result.ok && result.pruned).toHaveLength(4);
    expect(backupsIn(outDir)).toEqual([`manygames-local-${FIXED_STAMP}.sql`]);
  });
});

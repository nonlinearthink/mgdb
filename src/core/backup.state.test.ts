/**
 * 与 backup.test.ts 同一个接缝（runBackup），这里专注状态记录与失败通知。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runBackup } from "./backup.ts";
import { loadState } from "./state.ts";
import {
  FIXED_NOW,
  FIXED_STAMP,
  fakeNotify,
  fakePgTools,
  fixedClock,
  makeConfig,
  makeRoot,
  TRUNCATED_SQL,
  writeConfigFile,
} from "./test-harness.ts";

let root: string;
let outDir: string;
let statePath: string;

beforeEach(() => {
  root = makeRoot();
  outDir = path.join(root, "backups");
  statePath = path.join(root, "state.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function config(): string {
  return writeConfigFile(root, makeConfig(root, { defaults: { outDir } }));
}

describe("状态记录", () => {
  test("成功后记下运行时间、成功时间、产物路径与体积", async () => {
    const configPath = config();
    const pg = fakePgTools();
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    const record = loadState(statePath).sources["manygames-local"];
    expect(record?.ok).toBe(true);
    expect(record?.lastRunAt).toBe(FIXED_NOW.toISOString());
    expect(record?.lastSuccessAt).toBe(FIXED_NOW.toISOString());
    expect(record?.file).toBe(result.ok ? result.file : "");
    expect(record?.bytes).toBe(result.ok ? result.bytes : -1);
    expect(record?.error).toBeUndefined();
  });

  test("失败后记为失败，并带上环节与原因", async () => {
    const configPath = config();
    const pg = fakePgTools({ code: 1, stderr: "pg_dump: error: 权限不足" });
    const notifier = fakeNotify();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    const record = loadState(statePath).sources["manygames-local"];
    expect(record?.ok).toBe(false);
    expect(record?.error).toContain("dump");
    expect(record?.error).toContain("权限不足");
  });

  test("失败时保留此前的成功时间——「已经多久没成功」全靠它", async () => {
    const configPath = config();
    const notifier = fakeNotify();

    const success = fakePgTools();
    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: success.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    const later = new Date(2026, 7, 20, 9, 0, 0);
    const failure = fakePgTools({ code: 1, contents: TRUNCATED_SQL });
    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: failure.run,
        notify: notifier.notify,
        now: () => later,
      }
    );

    const record = loadState(statePath).sources["manygames-local"];
    expect(record?.ok).toBe(false);
    expect(record?.lastRunAt).toBe(later.toISOString());
    expect(record?.lastSuccessAt).toBe(FIXED_NOW.toISOString());
  });

  test("产物文件名与状态里的时间取自同一个时钟读数", async () => {
    const configPath = config();
    const pg = fakePgTools();
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(result.ok && path.basename(result.file)).toContain(FIXED_STAMP);
    expect(loadState(statePath).sources["manygames-local"]?.lastRunAt).toBe(
      FIXED_NOW.toISOString()
    );
  });

  test("状态文件损坏时照常备份，并把它当成没有历史记录", async () => {
    const configPath = config();
    writeFileSync(statePath, "{ 这不是 JSON");
    const pg = fakePgTools();
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(result.ok).toBe(true);
    expect(loadState(statePath).sources["manygames-local"]?.ok).toBe(true);
  });

  test("状态写不进去时作为警告上报，不把已落盘的备份判负", async () => {
    const configPath = config();
    // 让 statePath 指向一个目录，写入必然失败
    const blocked = path.join(root, "state-as-dir");
    mkdirSync(blocked, { recursive: true });
    const pg = fakePgTools();
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath: blocked,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("状态未能写入"))).toBe(true);
  });
});

describe("失败通知", () => {
  test("失败时主动发出通知", async () => {
    const configPath = config();
    const pg = fakePgTools({ code: 1, stderr: "pg_dump: error: 连不上" });
    const notifier = fakeNotify();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.title).toContain("manygames-local");
    expect(notifier.sent[0]!.body).toContain("dump");
  });

  test("成功时不打扰使用者", async () => {
    const configPath = config();
    const pg = fakePgTools();
    const notifier = fakeNotify();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(notifier.sent).toHaveLength(0);
  });

  test("配置层面的失败同样会通知，不是只有 dump 才通知", async () => {
    const pg = fakePgTools();
    const notifier = fakeNotify();

    await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath: path.join(root, "缺失的配置.json"),
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.body).toContain("config");
  });

  test("通知本身抛错不改变备份的结论", async () => {
    const configPath = config();
    const pg = fakePgTools({ code: 1 });

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: async () => {
          throw new Error("通知服务挂了");
        },
        now: fixedClock,
      }
    );

    expect(result.ok).toBe(false);
    expect(loadState(statePath).sources["manygames-local"]?.ok).toBe(false);
  });
});

describe("失败时状态也写不进去，这件事本身要说出来", () => {
  test("失败结果带上「状态未能写入」的警告", async () => {
    const configPath = config();
    const blocked = path.join(root, "state-as-dir");
    mkdirSync(blocked, { recursive: true });
    const pg = fakePgTools({ code: 1 });
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath: blocked,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 备份失败本身报得好好的，丢的是「这次失败没能被记进历史」这一条。
    // 不说出来的话，status 会继续显示上一次成功、状态正常。
    expect(result.failure.step).toBe("dump");
    expect(result.warnings.some((w) => w.includes("状态未能写入"))).toBe(true);
  });

  test("状态写得进去时，失败结果不带多余警告", async () => {
    const configPath = config();
    const pg = fakePgTools({ code: 1 });
    const notifier = fakeNotify();

    const result = await runBackup(
      { sourceName: "manygames-local" },
      {
        configPath,
        statePath,
        runPgTool: pg.run,
        notify: notifier.notify,
        now: fixedClock,
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.warnings).toEqual([]);
  });
});

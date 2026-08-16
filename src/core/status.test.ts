/**
 * 第二个接缝：collectStatus。
 *
 * 报备：计划里说过 v1 只有 runBackup 一个接缝。status 是一条独立的读路径——
 * 它算「超期」和「占用空间」，这两件事 runBackup 永远不会执行到，
 * 借着备份去测它只会把测试拧得很别扭。所以这里明确多开了一个接缝。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import type { State } from "./state.ts";
import { collectStatus } from "./status.ts";
import {
  defaultSource,
  makeConfig,
  makeRoot,
  seedFile,
} from "./test-harness.ts";

let root: string;
let outDir: string;

const NOW = new Date(2026, 7, 16, 12, 0, 0);

beforeEach(() => {
  root = makeRoot();
  outDir = path.join(root, "backups");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function stateWith(sources: State["sources"]): State {
  return { sources };
}

describe("份数与占用", () => {
  test("只统计本工具生成的、属于该数据源的产物", () => {
    seedFile(outDir, "manygames-local-20260801-030000.sql", "12345");
    seedFile(outDir, "manygames-local-20260802-030000.sql", "12345");
    seedFile(outDir, "manygames-prod-20260801-030000.sql", "别的源");
    seedFile(outDir, "我的笔记.txt", "无关文件");
    symlinkSync(
      "manygames-local-20260802-030000.sql",
      path.join(outDir, "manygames-local-latest.sql")
    );

    const config = makeConfig(root, { defaults: { outDir } });
    const [status] = collectStatus(config, stateWith({}), NOW);

    expect(status?.count).toBe(2);
    expect(status?.bytes).toBe(10);
  });

  test("没有任何备份时计数为 0 而不是报错", () => {
    const config = makeConfig(root, { defaults: { outDir } });
    const [status] = collectStatus(config, stateWith({}), NOW);

    expect(status?.count).toBe(0);
    expect(status?.bytes).toBe(0);
  });

  test("未配置输出目录时不崩，计数为 0", () => {
    const config = makeConfig(root, { defaults: { outDir: undefined } });
    const [status] = collectStatus(config, stateWith({}), NOW);

    expect(status?.outDir).toBeUndefined();
    expect(status?.count).toBe(0);
  });

  test("数据源上的输出目录覆盖全局默认值", () => {
    const own = path.join(root, "own-dir");
    seedFile(own, "manygames-local-20260801-030000.sql");
    seedFile(outDir, "manygames-local-20260802-030000.sql");

    const config = makeConfig(root, {
      defaults: { outDir },
      sources: [defaultSource({ outDir: own })],
    });
    const [status] = collectStatus(config, stateWith({}), NOW);

    expect(status?.outDir).toBe(own);
    expect(status?.count).toBe(1);
  });
});

describe("超期判定", () => {
  test("从未成功备份过就算超期", () => {
    const config = makeConfig(root, {
      defaults: { outDir, staleAfterDays: 3 },
    });
    const [status] = collectStatus(config, stateWith({}), NOW);

    expect(status?.neverSucceeded).toBe(true);
    expect(status?.stale).toBe(true);
    expect(status?.daysSinceSuccess).toBeUndefined();
  });

  test("距上次成功超过阈值算超期", () => {
    const config = makeConfig(root, {
      defaults: { outDir, staleAfterDays: 3 },
    });
    const [status] = collectStatus(
      config,
      stateWith({
        "manygames-local": {
          lastRunAt: daysAgo(5),
          lastSuccessAt: daysAgo(5),
          ok: true,
        },
      }),
      NOW
    );

    expect(status?.daysSinceSuccess).toBe(5);
    expect(status?.stale).toBe(true);
  });

  test("在阈值以内不算超期", () => {
    const config = makeConfig(root, {
      defaults: { outDir, staleAfterDays: 3 },
    });
    const [status] = collectStatus(
      config,
      stateWith({
        "manygames-local": {
          lastRunAt: daysAgo(1),
          lastSuccessAt: daysAgo(1),
          ok: true,
        },
      }),
      NOW
    );

    expect(status?.daysSinceSuccess).toBe(1);
    expect(status?.stale).toBe(false);
  });

  test("最近跑过但一直失败，仍按上次成功的时间判超期", () => {
    const config = makeConfig(root, {
      defaults: { outDir, staleAfterDays: 3 },
    });
    const [status] = collectStatus(
      config,
      stateWith({
        "manygames-local": {
          lastRunAt: daysAgo(0),
          lastSuccessAt: daysAgo(9),
          ok: false,
          error: "[dump] pg_dump 退出码 1",
        },
      }),
      NOW
    );

    // 天天在跑、天天失败，是最需要被标红的情形
    expect(status?.lastOk).toBe(false);
    expect(status?.stale).toBe(true);
    expect(status?.daysSinceSuccess).toBe(9);
    expect(status?.lastError).toContain("dump");
  });
});

describe("多数据源", () => {
  test("按配置顺序逐个给出状态", () => {
    const config = makeConfig(root, {
      defaults: { outDir },
      sources: [
        defaultSource({ name: "manygames-local" }),
        defaultSource({ name: "manygames-prod" }),
      ],
    });

    const statuses = collectStatus(config, stateWith({}), NOW);

    expect(statuses.map((s) => s.name)).toEqual([
      "manygames-local",
      "manygames-prod",
    ]);
  });

  test("状态文件里没有的数据源不会影响别的数据源", () => {
    const config = makeConfig(root, {
      defaults: { outDir, staleAfterDays: 3 },
      sources: [
        defaultSource({ name: "manygames-local" }),
        defaultSource({ name: "manygames-prod" }),
      ],
    });

    const statuses = collectStatus(
      config,
      stateWith({
        "manygames-local": {
          lastRunAt: daysAgo(1),
          lastSuccessAt: daysAgo(1),
          ok: true,
        },
      }),
      NOW
    );

    expect(statuses[0]?.stale).toBe(false);
    expect(statuses[1]?.neverSucceeded).toBe(true);
    expect(statuses[1]?.stale).toBe(true);
  });
});

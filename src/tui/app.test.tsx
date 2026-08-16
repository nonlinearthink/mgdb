/**
 * 同 status-panel.test.tsx 的接缝（界面渲染）。这里验证整个 App 的主屏装配：
 * 配置与状态确实被读进来、数据源确实出现在面板上、坏配置不会把界面打崩。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render } from "ink-testing-library";
import { saveConfig } from "../core/config.ts";
import { recordRun } from "../core/state.ts";
import {
  defaultSource,
  makeConfig,
  makeRoot,
  noopNotify,
  seedFile,
} from "../core/test-harness.ts";
import { App } from "./app.tsx";
import type { TuiDeps } from "./deps.ts";

let root: string;
let outDir: string;
let configPath: string;
let statePath: string;

beforeEach(() => {
  root = makeRoot();
  outDir = path.join(root, "backups");
  configPath = path.join(root, "config.json");
  statePath = path.join(root, "state.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deps(): TuiDeps {
  return {
    configPath,
    statePath,
    runPgTool: async () => ({ code: 0, stderr: "" }),
    notify: noopNotify,
  };
}

describe("App 主屏", () => {
  test("列出配置里的数据源并显示按键提示", () => {
    saveConfig(configPath, makeConfig(root, { defaults: { outDir } }));

    const { lastFrame } = render(<App deps={deps()} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("mgdb");
    expect(output).toContain("manygames-local");
    expect(output).toContain("b 备份");
    expect(output).toContain("s 数据源管理");
    expect(output).toContain("q 退出");
  });

  test("把备份目录里的份数与占用统计出来", () => {
    saveConfig(configPath, makeConfig(root, { defaults: { outDir } }));
    seedFile(outDir, "manygames-20260801-030000.sql", "12345");
    seedFile(outDir, "manygames-20260802-030000.sql", "12345");

    const { lastFrame } = render(<App deps={deps()} />);

    expect(lastFrame()).toContain("2 份");
  });

  test("从未备份过的数据源被标成超期", () => {
    saveConfig(configPath, makeConfig(root, { defaults: { outDir } }));

    const { lastFrame } = render(<App deps={deps()} />);

    expect(lastFrame()).toContain("从未成功备份过");
  });

  test("刚成功过的数据源显示为正常", () => {
    saveConfig(
      configPath,
      makeConfig(root, { defaults: { outDir, staleAfterDays: 3 } })
    );
    recordRun(statePath, "manygames-local", {
      at: new Date(),
      ok: true,
      file: path.join(outDir, "manygames-20260816-030000.sql"),
      bytes: 10,
    });

    const { lastFrame } = render(<App deps={deps()} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("正常");
    expect(output).not.toContain("从未成功备份过");
  });

  test("上次失败的原因显示在面板上", () => {
    saveConfig(configPath, makeConfig(root, { defaults: { outDir } }));
    recordRun(statePath, "manygames-local", {
      at: new Date(),
      ok: false,
      error: "[dump] pg_dump 退出码 1",
    });

    expect(render(<App deps={deps()} />).lastFrame()).toContain(
      "上次失败：[dump] pg_dump 退出码 1"
    );
  });

  test("配置文件损坏时显示错误而不是白屏或崩溃", () => {
    writeFileSync(configPath, "{ 这不是 JSON");

    const { lastFrame } = render(<App deps={deps()} />);
    const output = lastFrame() ?? "";

    // 不断言整句：Ink 会按终端宽度折行，断言跨行的字符串等于在测排版
    expect(output).toContain("配置文件不是合法的");
    expect(output).toContain("b 备份");
  });

  test("配置文件还不存在时给出添加引导", () => {
    const { lastFrame } = render(<App deps={deps()} />);

    expect(lastFrame()).toContain("还没有任何数据源");
  });

  test("多个数据源都出现在面板上", () => {
    saveConfig(
      configPath,
      makeConfig(root, {
        defaults: { outDir },
        sources: [
          defaultSource({ name: "manygames-local" }),
          defaultSource({ name: "manygames_dev" }),
        ],
      })
    );

    const output = render(<App deps={deps()} />).lastFrame() ?? "";

    expect(output).toContain("manygames-local");
    expect(output).toContain("manygames_dev");
  });
});

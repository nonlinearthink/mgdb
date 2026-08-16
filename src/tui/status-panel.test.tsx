/**
 * 第四个接缝：StatusPanel 的渲染输出。
 *
 * 报备：界面层原计划不测。但状态面板里有一条真正的判断——「该不该标红」——
 * 它是「以为在备份其实早就挂了」的唯一预警，值得钉死。其余交互（按键、
 * 表单流转）仍然只靠手动验证。
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { SourceStatus } from "../core/status.ts";
import { StatusPanel } from "./status-panel.tsx";

function status(over: Partial<SourceStatus> = {}): SourceStatus {
  return {
    name: "manygames-local",
    outDir: "/tmp/backups",
    count: 3,
    bytes: 2048,
    lastSuccessAt: new Date(2026, 7, 16, 3, 45),
    lastOk: true,
    daysSinceSuccess: 0,
    neverSucceeded: false,
    stale: false,
    ...over,
  };
}

describe("StatusPanel", () => {
  test("正常的数据源显示上次成功时间、份数与占用", () => {
    const { lastFrame } = render(<StatusPanel statuses={[status()]} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("manygames-local");
    expect(output).toContain("2026-08-16 03:45");
    expect(output).toContain("3 份");
    expect(output).toContain("2.0 KB");
    expect(output).toContain("正常");
  });

  test("超期的数据源给出「已 N 天没有成功备份」", () => {
    const { lastFrame } = render(
      <StatusPanel statuses={[status({ stale: true, daysSinceSuccess: 12 })]} />
    );

    expect(lastFrame()).toContain("已 12 天没有成功备份");
  });

  test("从未备份过的数据源明确说出来，而不是留空", () => {
    const { lastFrame } = render(
      <StatusPanel
        statuses={[
          status({
            neverSucceeded: true,
            stale: true,
            lastSuccessAt: undefined,
            lastOk: undefined,
            daysSinceSuccess: undefined,
            count: 0,
            bytes: 0,
          }),
        ]}
      />
    );
    const output = lastFrame() ?? "";

    expect(output).toContain("从未成功备份过");
    expect(output).toContain("从未成功");
  });

  test("上次失败时把原因摊开显示", () => {
    const { lastFrame } = render(
      <StatusPanel
        statuses={[
          status({
            lastOk: false,
            lastError: "[dump] pg_dump 退出码 1\n第二行不该显示",
          }),
        ]}
      />
    );
    const output = lastFrame() ?? "";

    expect(output).toContain("上次失败：[dump] pg_dump 退出码 1");
    expect(output).not.toContain("第二行不该显示");
  });

  test("一个数据源都没有时给出引导而不是空面板", () => {
    const { lastFrame } = render(<StatusPanel statuses={[]} />);
    const output = lastFrame() ?? "";

    expect(output).toContain("还没有任何数据源");
    expect(output).toContain("数据源管理");
  });

  test("多个数据源按传入顺序逐行显示", () => {
    const { lastFrame } = render(
      <StatusPanel
        statuses={[
          status({ name: "aaa-local" }),
          status({ name: "zzz-prod", stale: true, daysSinceSuccess: 5 }),
        ]}
      />
    );
    const lines = (lastFrame() ?? "").split("\n");

    expect(lines[0]).toContain("aaa-local");
    expect(lines[1]).toContain("zzz-prod");
  });
});

/**
 * 界面编辑表单的取值语义：表单里清空一项 = 取消这项覆盖、回到全局默认。
 *
 * 这里测的是表单提交路径上的两个纯函数（toDataSource + updateSource）的组合，
 * 不涉及按键与渲染——那部分仍然只有手动验证。
 */
import { describe, expect, test } from "bun:test";
import { updateSource } from "../core/config.ts";
import type { Config, DataSource } from "../core/types.ts";
import { toDataSource } from "./source-manager.tsx";

function draft(over: Record<string, string> = {}) {
  return {
    name: "local",
    host: "localhost",
    port: "5490",
    user: "manydreamstech",
    password: "hunter2",
    database: "manygames",
    outDir: "",
    format: "",
    keep: "",
    ...over,
  };
}

function configWith(source: Partial<DataSource>): Config {
  return {
    defaults: { format: "sql", keep: 14, staleAfterDays: 3 },
    sources: [
      {
        name: "local",
        url: "postgresql://manydreamstech:hunter2@localhost:5490/manygames",
        outDir: "/tmp/old",
        format: "dump",
        keep: 7,
        ...source,
      },
    ],
  };
}

function editWith(fields: Record<string, string>): DataSource {
  const source = toDataSource(draft(fields));
  if (typeof source === "string") throw new Error(source);
  const next = updateSource(configWith({}), "local", source);
  if (!next.ok) throw new Error(next.error);
  const updated = next.value.sources[0];
  if (!updated) throw new Error("数据源不见了");
  return updated;
}

describe("表单留空 = 取消覆盖", () => {
  test("三项全部留空时，三项覆盖都被清掉", () => {
    const updated = editWith({});

    expect(updated.outDir).toBeUndefined();
    expect(updated.format).toBeUndefined();
    expect(updated.keep).toBeUndefined();
  });

  test("清空后的键真的从对象上消失，不是留个 undefined 值", () => {
    expect(Object.keys(editWith({}))).toEqual(["name", "url"]);
  });

  test("只清空一项时，另外两项原样保留", () => {
    const updated = editWith({ outDir: "/tmp/new", format: "sql" });

    expect(updated.outDir).toBe("/tmp/new");
    expect(updated.format).toBe("sql");
    expect(updated.keep).toBeUndefined();
  });

  test("保留份数填 0 是「永不清理」，不等于清空", () => {
    expect(editWith({ keep: "0" }).keep).toBe(0);
  });

  test("填了值就照填的来", () => {
    const updated = editWith({ outDir: "/tmp/new", format: "dump", keep: "3" });

    expect(updated.outDir).toBe("/tmp/new");
    expect(updated.format).toBe("dump");
    expect(updated.keep).toBe(3);
  });

  test("输出目录前后的空白被去掉，全空白等于清空", () => {
    expect(editWith({ outDir: "   " }).outDir).toBeUndefined();
    expect(editWith({ outDir: "  /tmp/new  " }).outDir).toBe("/tmp/new");
  });
});

describe("表单校验仍然挡得住非法输入", () => {
  test("格式写错时拒绝，并说清楚能填什么", () => {
    const result = toDataSource(draft({ format: "parquet" }));

    expect(typeof result).toBe("string");
    expect(result as string).toContain("sql");
    expect(result as string).toContain("dump");
  });

  test("保留份数为负数时拒绝", () => {
    expect(typeof toDataSource(draft({ keep: "-1" }))).toBe("string");
  });

  test("端口非法时拒绝", () => {
    expect(typeof toDataSource(draft({ port: "70000" }))).toBe("string");
  });

  test("名字为空时拒绝", () => {
    expect(typeof toDataSource(draft({ name: "  " }))).toBe("string");
  });

  test("密码里的特殊字符被编码进连接串，且能原样解回来", () => {
    const source = toDataSource(draft({ password: "p@ss/w:rd" }));

    expect(typeof source).not.toBe("string");
    expect((source as DataSource).url).not.toContain("p@ss/w:rd");
    expect((source as DataSource).url).toContain("p%40ss%2Fw%3Ard");
  });
});

describe("改名撞车时拒绝", () => {
  test("改成一个已存在的名字会报错，而不是把那条覆盖掉", () => {
    const config: Config = {
      defaults: { format: "sql", keep: 14, staleAfterDays: 3 },
      sources: [
        { name: "local", url: "postgresql://u:p@localhost:5490/a" },
        { name: "prod", url: "postgresql://u:p@localhost:5490/b" },
      ],
    };

    const result = updateSource(config, "local", { name: "prod" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("prod");
  });
});

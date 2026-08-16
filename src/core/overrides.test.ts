/**
 * 三项覆盖设置的解析规则。命令行（cli/source-command.ts）与界面表单
 * （tui/source-manager.tsx）都委托给这里，所以规则只在这一处定义、也只测一遍。
 */
import { describe, expect, test } from "bun:test";
import { parseOverrides } from "./overrides.ts";

function parse(input: Parameters<typeof parseOverrides>[0]) {
  const result = parseOverrides(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("三种输入对应三种意思", () => {
  test("没给这个键 → 结果里也没有，表示保持不变", () => {
    expect(Object.keys(parse({}))).toEqual([]);
    expect(Object.keys(parse({ keep: "3" }))).toEqual(["keep"]);
  });

  test("给了空串 → 键在、值为 undefined，表示清除该项覆盖", () => {
    const result = parse({ outDir: "", format: "", keep: "" });

    // 键必须存在：updateSource 靠显式的 undefined 来删除，
    // 光是省略的话合并时旧值会被顶回来
    expect(Object.keys(result).sort()).toEqual(["format", "keep", "outDir"]);
    expect(result.outDir).toBeUndefined();
    expect(result.format).toBeUndefined();
    expect(result.keep).toBeUndefined();
  });

  test("给了值 → 校验后写入", () => {
    expect(parse({ outDir: "/tmp/x", format: "dump", keep: "7" })).toEqual({
      outDir: "/tmp/x",
      format: "dump",
      keep: 7,
    });
  });
});

describe("空白处理", () => {
  test("全是空白等同于空串，也就是清除", () => {
    expect(parse({ outDir: "   ", keep: "  " })).toEqual({
      outDir: undefined,
      keep: undefined,
    });
  });

  test("值前后的空白被去掉", () => {
    expect(
      parse({ outDir: "  /tmp/x  ", format: " dump ", keep: " 7 " })
    ).toEqual({ outDir: "/tmp/x", format: "dump", keep: 7 });
  });
});

describe("校验", () => {
  test("保留份数 0 是合法取值（永不清理），不等于清除", () => {
    const result = parse({ keep: "0" });

    expect(result.keep).toBe(0);
    expect(Object.keys(result)).toEqual(["keep"]);
  });

  test("保留份数为负数、小数、非数字都被拒", () => {
    for (const keep of ["-1", "1.5", "abc"]) {
      const result = parseOverrides({ keep });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(keep);
    }
  });

  test("格式只认 sql 和 dump", () => {
    expect(parse({ format: "sql" }).format).toBe("sql");
    expect(parse({ format: "dump" }).format).toBe("dump");

    for (const format of ["custom", "parquet", "SQL "]) {
      const result = parseOverrides({ format });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("sql");
        expect(result.error).toContain("dump");
      }
    }
  });

  test("一项不合法就整体拒绝，不会写进去半套", () => {
    const result = parseOverrides({ outDir: "/tmp/x", keep: "abc" });

    expect(result.ok).toBe(false);
  });
});

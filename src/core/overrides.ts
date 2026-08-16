import {
  type DataSource,
  err,
  ok,
  parseBackupFormat,
  type Result,
} from "./types.ts";

/** 三项覆盖设置的原始输入。命令行参数和界面表单字段都长这样：字符串或没给。 */
export interface OverrideInput {
  outDir?: string;
  format?: string;
  keep?: string;
}

export type SourceOverrides = Partial<
  Pick<DataSource, "outDir" | "format" | "keep">
>;

/**
 * 把三项覆盖设置的原始输入解析成配置里的形状。命令行与界面共用这一份，
 * 否则校验规则和空值语义会各写一遍，改一次漏一处就会出现
 * 「命令行能设、界面设不了」这种对不上的行为。
 *
 * 三种输入对应三种意思：
 *   - 没给这个键        → 结果里也没有，表示保持不变
 *   - 给了空串          → 结果里有这个键、值为 undefined，表示清除该项覆盖
 *   - 给了非空值        → 校验后写入
 *
 * 「清除」必须表达成显式的 undefined 键：updateSource 靠它来删除，
 * 光是省略掉的话，合并时旧值会被顶回来。
 */
export function parseOverrides(input: OverrideInput): Result<SourceOverrides> {
  const overrides: SourceOverrides = {};

  if (input.outDir !== undefined) {
    const trimmed = input.outDir.trim();
    overrides.outDir = trimmed === "" ? undefined : trimmed;
  }

  if (input.format !== undefined) {
    if (input.format.trim() === "") {
      overrides.format = undefined;
    } else {
      const format = parseBackupFormat(input.format.trim());
      if (!format) {
        return err(`备份格式只能是 sql 或 dump，收到的是 ${input.format}`);
      }
      overrides.format = format;
    }
  }

  if (input.keep !== undefined) {
    if (input.keep.trim() === "") {
      overrides.keep = undefined;
    } else {
      // 必须在转数字之前挡住空串：Number("") 是 0，而 0 是合法取值（永不清理）
      const keep = Number(input.keep.trim());
      if (!Number.isInteger(keep) || keep < 0) {
        return err(`保留份数只能是不小于 0 的整数，收到的是 ${input.keep}`);
      }
      overrides.keep = keep;
    }
  }

  return ok(overrides);
}

import type { Notify } from "../core/types.ts";

/** AppleScript 字符串字面量转义 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS 系统通知。通知本身发不出去不该影响主流程——备份已经落盘或已经失败了，
 * 通知只是让人知道，不是流程的一部分。
 */
export const notifyMacOS: Notify = async (notification) => {
  try {
    const script = `display notification ${quote(notification.body)} with title ${quote(
      notification.title
    )}`;
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    // 没有 osascript 或被系统拒绝，都不是备份的问题
  }
};

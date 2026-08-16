import { Box, Text } from "ink";
import { describeStale, formatBytes, formatDateTime } from "../core/format.ts";
import type { SourceStatus } from "../core/status.ts";

export function StatusPanel({ statuses }: { statuses: SourceStatus[] }) {
  if (statuses.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">配置里还没有任何数据源。</Text>
        <Text dimColor>按 s 进入数据源管理，添加第一个。</Text>
      </Box>
    );
  }

  const width = Math.max(...statuses.map((status) => status.name.length));

  return (
    <Box flexDirection="column">
      {statuses.map((status) => (
        <Box key={status.name} flexDirection="column">
          <Box>
            <Text color={status.stale ? "red" : "green"}>● </Text>
            <Text bold>{status.name.padEnd(width)}</Text>
            <Text> 上次成功 {formatDateTime(status.lastSuccessAt)}</Text>
            <Text dimColor>
              {"  "}
              {String(status.count).padStart(3)} 份 /{" "}
              {formatBytes(status.bytes).padStart(9)}
            </Text>
            <Text color={status.stale ? "red" : "gray"}>
              {"  "}
              {describeStale(status)}
            </Text>
          </Box>
          {status.lastOk === false && status.lastError ? (
            <Text color="red" dimColor>
              {" ".repeat(width + 2)}上次失败：{status.lastError.split("\n")[0]}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

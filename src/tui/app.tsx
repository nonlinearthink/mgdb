import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState } from "react";
import { loadConfigOrEmpty } from "../core/config.ts";
import { loadState } from "../core/state.ts";
import { collectStatus, type SourceStatus } from "../core/status.ts";
import type { Config } from "../core/types.ts";
import { BackupFlow } from "./backup-flow.tsx";
import type { TuiDeps } from "./deps.ts";
import { SourceManager } from "./source-manager.tsx";
import { StatusPanel } from "./status-panel.tsx";
import { Hint } from "./widgets.tsx";

type Screen = "status" | "backup" | "sources";

interface Snapshot {
  config: Config;
  statuses: SourceStatus[];
  loadError?: string;
}

/**
 * 读一次盘：配置文件，以及扫描整个备份目录统计份数与占用。
 *
 * 这两件事都是同步 I/O，而组件函数每次重画都会被完整执行一遍，
 * 所以绝不能写在函数体里——那样将来只要给界面加一个会频繁变化的状态，
 * 就会退化成每秒扫几十次目录，而且不报错，只是莫名变卡。
 * 这里把它做成「按需刷新的快照」：只有开屏、按 r、或增删改完数据源才重新读。
 */
function readSnapshot(deps: TuiDeps): Snapshot {
  const loaded = loadConfigOrEmpty(deps.configPath);
  const config: Config = loaded.ok
    ? loaded.value
    : { defaults: { format: "sql", keep: 14, staleAfterDays: 3 }, sources: [] };

  return {
    config,
    statuses: collectStatus(config, loadState(deps.statePath), new Date()),
    ...(loaded.ok ? {} : { loadError: loaded.error }),
  };
}

export function App({ deps }: { deps: TuiDeps }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("status");
  const [snapshot, setSnapshot] = useState<Snapshot>(() => readSnapshot(deps));

  const reload = useCallback(() => setSnapshot(readSnapshot(deps)), [deps]);
  const { config, statuses, loadError } = snapshot;

  useInput(
    (input) => {
      if (input === "q") exit();
      else if (input === "b") setScreen("backup");
      else if (input === "s") setScreen("sources");
      else if (input === "r") reload();
    },
    { isActive: screen === "status" }
  );

  const header = (
    <Box marginBottom={1}>
      <Text bold color="cyan">
        mgdb
      </Text>
      <Text dimColor> — PostgreSQL 备份</Text>
    </Box>
  );

  if (screen === "backup") {
    return (
      <Box flexDirection="column">
        {header}
        <BackupFlow
          config={config}
          deps={deps}
          onExit={() => {
            reload();
            setScreen("status");
          }}
        />
      </Box>
    );
  }

  if (screen === "sources") {
    return (
      <Box flexDirection="column">
        {header}
        <SourceManager
          config={config}
          configPath={deps.configPath}
          onChanged={reload}
          onExit={() => setScreen("status")}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {header}
      {loadError ? <Text color="red">{loadError}</Text> : null}
      <StatusPanel statuses={statuses} />
      <Box marginTop={1}>
        <Hint>b 备份　s 数据源管理　r 刷新　q 退出</Hint>
      </Box>
    </Box>
  );
}

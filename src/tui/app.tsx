import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useMemo, useState } from "react";
import { loadConfigOrEmpty } from "../core/config.ts";
import { loadState } from "../core/state.ts";
import { collectStatus } from "../core/status.ts";
import type { Config } from "../core/types.ts";
import { BackupFlow } from "./backup-flow.tsx";
import type { TuiDeps } from "./deps.ts";
import { SourceManager } from "./source-manager.tsx";
import { StatusPanel } from "./status-panel.tsx";
import { Hint } from "./widgets.tsx";

type Screen = "status" | "backup" | "sources";

export function App({ deps }: { deps: TuiDeps }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("status");
  const [reloads, setReloads] = useState(0);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  // 读配置和扫描整个备份目录都是同步 I/O。组件函数每次重画都会跑一遍，
  // 所以必须挂在 reloads 上：只有按 r 刷新、或增删改完数据源才重新读盘。
  const { config, statuses, loadError } = useMemo(() => {
    const loaded = loadConfigOrEmpty(deps.configPath);
    const resolved: Config = loaded.ok
      ? loaded.value
      : {
          defaults: { format: "sql", keep: 14, staleAfterDays: 3 },
          sources: [],
        };
    return {
      config: resolved,
      statuses: collectStatus(resolved, loadState(deps.statePath), new Date()),
      loadError: loaded.ok ? undefined : loaded.error,
    };
  }, [deps.configPath, deps.statePath, reloads]);

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
          key={reloads}
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
          key={reloads}
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

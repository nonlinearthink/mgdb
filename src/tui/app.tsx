import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useState } from "react";
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

  const loaded = loadConfigOrEmpty(deps.configPath);
  const config: Config = loaded.ok
    ? loaded.value
    : { defaults: { format: "sql", keep: 14, staleAfterDays: 3 }, sources: [] };
  const statuses = collectStatus(config, loadState(deps.statePath), new Date());

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
      {loaded.ok ? null : <Text color="red">{loaded.error}</Text>}
      <StatusPanel statuses={statuses} />
      <Box marginTop={1}>
        <Hint>b 备份　s 数据源管理　r 刷新　q 退出</Hint>
      </Box>
    </Box>
  );
}

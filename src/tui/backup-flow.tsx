import { statSync } from "node:fs";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { BackupResult } from "../core/backup.ts";
import { runBackup } from "../core/backup.ts";
import { FORMAT_LABEL, formatBytes, formatElapsed } from "../core/format.ts";
import type { BackupFormat, Config, DataSource } from "../core/types.ts";
import type { TuiDeps } from "./deps.ts";
import { Hint, SelectList, Spinner, TextField } from "./widgets.tsx";

type Stage =
  | { kind: "pick" }
  | { kind: "confirm"; source: DataSource }
  | { kind: "running"; source: DataSource }
  | { kind: "done"; result: BackupResult };

interface Overrides {
  outDir: string;
  format: BackupFormat;
}

function resolveOverrides(config: Config, source: DataSource): Overrides {
  return {
    outDir: source.outDir ?? config.defaults.outDir ?? "",
    format: source.format ?? config.defaults.format,
  };
}

/**
 * 执行中的画面。刻意不画百分比进度条：pg_dump 不吐进度，
 * 画出来的百分比只能是编的，会误导使用者判断还要等多久。
 * 能如实显示的只有转圈、已用时间，以及产物当前有多大。
 */
function Running({
  sourceName,
  tempFile,
}: {
  sourceName: string;
  tempFile?: string;
}) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAt);
      if (tempFile) {
        try {
          setBytes(statSync(tempFile).size);
        } catch {
          // 还没建出来，或刚被搬走
        }
      }
    }, 200);
    return () => clearInterval(timer);
  }, [startedAt, tempFile]);

  return (
    <Box flexDirection="column">
      <Box>
        <Spinner />
        <Text> 正在备份 {sourceName}</Text>
      </Box>
      <Text dimColor>
        已用 {formatElapsed(elapsed)}　产物已写入 {formatBytes(bytes)}
      </Text>
      <Hint>按 Ctrl-C 可中断，临时文件会被清理，已有备份不受影响。</Hint>
    </Box>
  );
}

function Done({
  result,
  onBack,
}: {
  result: BackupResult;
  onBack: () => void;
}) {
  useInput(() => onBack());

  if (!result.ok) {
    return (
      <Box flexDirection="column">
        <Text color="red">
          备份失败（数据源 {result.source}，环节 {result.failure.step}）
        </Text>
        {result.failure.message.split("\n").map((line) => (
          <Text key={line} color="red">
            {line}
          </Text>
        ))}
        <Text dimColor>已有备份未受任何影响。</Text>
        {result.warnings.map((warning) => (
          <Text key={warning} color="yellow">
            注意：{warning}
          </Text>
        ))}
        <Hint>按任意键返回。</Hint>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="green">备份完成</Text>
      <Text>
        {result.file}（{formatBytes(result.bytes)}）
      </Text>
      {result.pruned.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>已清理 {result.pruned.length} 份旧备份：</Text>
          {result.pruned.map((name) => (
            <Text key={name} dimColor>
              {"  - "}
              {name}
            </Text>
          ))}
        </Box>
      ) : null}
      {result.warnings.map((warning) => (
        <Text key={warning} color="yellow">
          注意：{warning}
        </Text>
      ))}
      <Hint>按任意键返回。</Hint>
    </Box>
  );
}

function Confirm({
  source,
  overrides,
  setOverrides,
  onRun,
  onCancel,
}: {
  source: DataSource;
  overrides: Overrides;
  setOverrides: (next: Overrides) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const [editingDir, setEditingDir] = useState(false);

  useInput((input, key) => {
    if (editingDir) {
      if (key.return) setEditingDir(false);
      else if (key.escape) setEditingDir(false);
      return;
    }
    if (key.escape) onCancel();
    else if (input === "d") setEditingDir(true);
    else if (input === "f") {
      setOverrides({
        ...overrides,
        format: overrides.format === "sql" ? "dump" : "sql",
      });
    } else if (key.return) {
      if (overrides.outDir.trim()) onRun();
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>备份 {source.name}</Text>
      <Box>
        <Text>输出目录：</Text>
        {editingDir ? (
          <TextField
            value={overrides.outDir}
            onChange={(outDir) => setOverrides({ ...overrides, outDir })}
          />
        ) : (
          <Text color={overrides.outDir ? undefined : "red"}>
            {overrides.outDir || "（未设置，必须先指定）"}
          </Text>
        )}
      </Box>
      <Text>产物格式：{FORMAT_LABEL[overrides.format]}</Text>
      <Hint>
        {editingDir
          ? "回车结束编辑"
          : "d 改目录　f 切换格式　回车开始备份　Esc 返回"}
      </Hint>
      <Text dimColor>本次修改只对这一次生效，不写回配置。</Text>
    </Box>
  );
}

export function BackupFlow({
  config,
  deps,
  onExit,
}: {
  config: Config;
  deps: TuiDeps;
  onExit: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [overrides, setOverrides] = useState<Overrides>({
    outDir: "",
    format: "sql",
  });
  const [tempFile, setTempFile] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState(0);

  useEffect(() => {
    if (stage.kind !== "running") return;
    let cancelled = false;
    const source = stage.source;

    void runBackup(
      {
        sourceName: source.name,
        outDir: overrides.outDir,
        format: overrides.format,
      },
      {
        ...deps,
        now: () => new Date(),
        onTempFile: setTempFile,
      }
    ).then((result) => {
      if (!cancelled) setStage({ kind: "done", result });
    });

    return () => {
      cancelled = true;
    };
  }, [stage, overrides, deps]);

  if (config.sources.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">还没有数据源可以备份。</Text>
        <Hint>按 Esc 返回，再按 s 去添加一个。</Hint>
      </Box>
    );
  }

  if (stage.kind === "pick") {
    return (
      <Box flexDirection="column">
        <Text bold>选择要备份的数据源</Text>
        <SelectList
          items={config.sources}
          label={(source) => source.name}
          index={picked}
          onIndexChange={setPicked}
          onSelect={(source) => {
            setOverrides(resolveOverrides(config, source));
            setStage({ kind: "confirm", source });
          }}
          onCancel={onExit}
        />
        <Hint>↑↓ 选择　回车确认　Esc 返回</Hint>
      </Box>
    );
  }

  if (stage.kind === "confirm") {
    return (
      <Confirm
        source={stage.source}
        overrides={overrides}
        setOverrides={setOverrides}
        onRun={() => setStage({ kind: "running", source: stage.source })}
        onCancel={() => setStage({ kind: "pick" })}
      />
    );
  }

  if (stage.kind === "running") {
    return <Running sourceName={stage.source.name} tempFile={tempFile} />;
  }

  return <Done result={stage.result} onBack={onExit} />;
}

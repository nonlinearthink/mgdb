import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  addSource,
  loadConfigOrEmpty,
  removeSource,
  saveConfig,
  updateSource,
} from "../core/config.ts";
import {
  buildPgUrl,
  describeConnection,
  type PgConnection,
  parsePgUrl,
} from "../core/datasource.ts";
import {
  type Config,
  type DataSource,
  parseBackupFormat,
} from "../core/types.ts";
import { Hint, SelectList, TextField } from "./widgets.tsx";

type Screen =
  | { kind: "list" }
  | { kind: "paste" }
  | { kind: "form"; mode: "add" | "edit"; original?: string }
  | { kind: "confirm-delete"; source: DataSource };

interface Draft {
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  outDir: string;
  format: string;
  keep: string;
}

const FIELDS: { key: keyof Draft; label: string; mask?: boolean }[] = [
  { key: "name", label: "名字" },
  { key: "host", label: "主机" },
  { key: "port", label: "端口" },
  { key: "user", label: "用户名" },
  { key: "password", label: "密码", mask: true },
  { key: "database", label: "数据库" },
  { key: "outDir", label: "输出目录（留空则继承默认）" },
  { key: "format", label: "格式 sql/dump（留空则继承）" },
  { key: "keep", label: "保留份数（留空则继承）" },
];

function emptyDraft(): Draft {
  return {
    name: "",
    host: "",
    port: "5432",
    user: "",
    password: "",
    database: "",
    outDir: "",
    format: "",
    keep: "",
  };
}

function draftFrom(source: DataSource, connection: PgConnection): Draft {
  return {
    name: source.name,
    host: connection.host,
    port: String(connection.port),
    user: connection.user,
    password: connection.password ?? "",
    database: connection.database,
    outDir: source.outDir ?? "",
    format: source.format ?? "",
    keep: source.keep === undefined ? "" : String(source.keep),
  };
}

/** 把表单还原成一条数据源。任何一处不合法都在这里挡住，不进配置。 */
function toDataSource(draft: Draft): DataSource | string {
  if (!draft.name.trim()) return "名字不能为空";
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return `端口非法：${draft.port}`;
  }
  const normalizedFormat = draft.format
    ? parseBackupFormat(draft.format)
    : undefined;
  if (draft.format && !normalizedFormat) {
    return `格式只能是 sql 或 dump，收到的是 ${draft.format}`;
  }
  let keep: number | undefined;
  if (draft.keep.trim()) {
    keep = Number(draft.keep);
    if (!Number.isInteger(keep) || keep < 0) {
      return `保留份数只能是不小于 0 的整数，收到的是 ${draft.keep}`;
    }
  }

  const url = buildPgUrl({
    host: draft.host.trim(),
    port,
    user: draft.user.trim(),
    ...(draft.password ? { password: draft.password } : {}),
    database: draft.database.trim(),
  });
  // 用真正的解析器再验一遍，保证存进去的连接串一定读得回来
  const parsed = parsePgUrl(url);
  if (!parsed.ok) return parsed.error;

  // 三项覆盖一律显式给出：留空就是 undefined，也就是「取消这项覆盖、回到全局默认」。
  // 用条件展开省略掉空值的话，updateSource 合并时旧值会被顶回来，清空就永远生效不了。
  return {
    name: draft.name.trim(),
    url,
    outDir: draft.outDir.trim() || undefined,
    format: normalizedFormat,
    keep,
  };
}

export function SourceManager({
  config,
  configPath,
  onChanged,
  onExit,
}: {
  config: Config;
  configPath: string;
  onChanged: () => void;
  onExit: () => void;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [pasted, setPasted] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [focus, setFocus] = useState(0);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);

  function persist(next: Config): void {
    const saved = saveConfig(configPath, next);
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setError(undefined);
    onChanged();
    setScreen({ kind: "list" });
  }

  function save(): void {
    const source = toDataSource(draft);
    if (typeof source === "string") {
      setError(source);
      return;
    }
    const current = loadConfigOrEmpty(configPath);
    if (!current.ok) {
      setError(current.error);
      return;
    }
    const original = screen.kind === "form" ? screen.original : undefined;
    const next = original
      ? updateSource(current.value, original, source)
      : addSource(current.value, source);
    if (!next.ok) {
      setError(next.error);
      return;
    }
    persist(next.value);
  }

  useInput(
    (input, key) => {
      if (screen.kind !== "list") return;
      if (key.escape) onExit();
      else if (input === "a") {
        setDraft(emptyDraft());
        setPasted("");
        setError(undefined);
        setScreen({ kind: "paste" });
      } else if (input === "d") {
        const source = config.sources[selected];
        // 删除永远要过一道确认，哪怕它只动配置不动文件
        if (source) setScreen({ kind: "confirm-delete", source });
      }
    },
    { isActive: screen.kind === "list" }
  );

  useInput(
    (_input, key) => {
      if (screen.kind !== "paste") return;
      if (key.escape) {
        setScreen({ kind: "list" });
      } else if (key.return) {
        const parsed = parsePgUrl(pasted);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        setError(undefined);
        setDraft({
          ...emptyDraft(),
          host: parsed.value.host,
          port: String(parsed.value.port),
          user: parsed.value.user,
          password: parsed.value.password ?? "",
          database: parsed.value.database,
        });
        setFocus(0);
        setScreen({ kind: "form", mode: "add" });
      }
    },
    { isActive: screen.kind === "paste" }
  );

  useInput(
    (_input, key) => {
      if (screen.kind !== "form") return;
      if (key.escape) {
        setScreen({ kind: "list" });
      } else if (key.downArrow || key.tab) {
        setFocus((current) => Math.min(FIELDS.length - 1, current + 1));
      } else if (key.upArrow) {
        setFocus((current) => Math.max(0, current - 1));
      } else if (key.return) {
        if (focus < FIELDS.length - 1) setFocus(focus + 1);
        else save();
      }
    },
    { isActive: screen.kind === "form" }
  );

  useInput(
    (input, key) => {
      if (screen.kind !== "confirm-delete") return;
      if (key.escape || input === "n") setScreen({ kind: "list" });
      else if (input === "y") {
        const current = loadConfigOrEmpty(configPath);
        if (!current.ok) {
          setError(current.error);
          return;
        }
        const next = removeSource(current.value, screen.source.name);
        if (!next.ok) {
          setError(next.error);
          return;
        }
        persist(next.value);
      }
    },
    { isActive: screen.kind === "confirm-delete" }
  );

  if (screen.kind === "paste") {
    return (
      <Box flexDirection="column">
        <Text bold>粘贴完整的 PostgreSQL 连接串</Text>
        <Box>
          <Text>{"> "}</Text>
          <TextField value={pasted} onChange={setPasted} />
        </Box>
        {error ? <Text color="red">{error}</Text> : null}
        <Hint>回车解析　Esc 返回</Hint>
        <Text dimColor>解析之后可以逐字段修改，不必重贴。</Text>
      </Box>
    );
  }

  if (screen.kind === "form") {
    return (
      <Box flexDirection="column">
        <Text bold>{screen.mode === "add" ? "新增数据源" : "编辑数据源"}</Text>
        {FIELDS.map((field, index) => (
          <Box key={field.key}>
            <Text color={index === focus ? "cyan" : undefined}>
              {index === focus ? "❯ " : "  "}
              {field.label}：
            </Text>
            {index === focus ? (
              <TextField
                value={draft[field.key]}
                onChange={(next) => setDraft({ ...draft, [field.key]: next })}
                {...(field.mask ? { mask: true } : {})}
              />
            ) : (
              <Text dimColor>
                {field.mask
                  ? "•".repeat(draft[field.key].length)
                  : draft[field.key]}
              </Text>
            )}
          </Box>
        ))}
        {error ? <Text color="red">{error}</Text> : null}
        <Hint>↑↓ 切换字段　回车下一项／最后一项保存　Esc 取消</Hint>
      </Box>
    );
  }

  if (screen.kind === "confirm-delete") {
    return (
      <Box flexDirection="column">
        <Text color="yellow">确定要删除数据源 {screen.source.name} 吗？</Text>
        <Text dimColor>只从配置里移除，已经备好的文件一个都不会动。</Text>
        <Hint>y 确认　n / Esc 取消</Hint>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>数据源管理</Text>
      {config.sources.length === 0 ? (
        <Text dimColor>还没有数据源。按 a 添加第一个。</Text>
      ) : (
        <SelectList
          items={config.sources}
          index={Math.min(selected, config.sources.length - 1)}
          onIndexChange={setSelected}
          label={(source) => {
            const connection = parsePgUrl(source.url);
            return `${source.name}  ${
              connection.ok
                ? describeConnection(connection.value)
                : "连接串有问题"
            }`;
          }}
          onSelect={(source) => {
            const connection = parsePgUrl(source.url);
            if (!connection.ok) {
              setError(connection.error);
              return;
            }
            setDraft(draftFrom(source, connection.value));
            setFocus(0);
            setError(undefined);
            setScreen({ kind: "form", mode: "edit", original: source.name });
          }}
        />
      )}
      {error ? <Text color="red">{error}</Text> : null}
      <Hint>↑↓ 选择　回车编辑　a 新增　d 删除　Esc 返回</Hint>
    </Box>
  );
}

export { toDataSource };

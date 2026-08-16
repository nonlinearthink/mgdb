import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((n) => n + 1), 90);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="cyan">{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
  );
}

export interface SelectListProps<T> {
  items: T[];
  label: (item: T) => string;
  /** 受控：调用方需要知道当前选中项才能处理自己的快捷键（比如删除） */
  index: number;
  onIndexChange: (next: number) => void;
  onSelect: (item: T) => void;
  onCancel?: () => void;
  isActive?: boolean;
}

export function SelectList<T>({
  items,
  label,
  index,
  onIndexChange,
  onSelect,
  onCancel,
  isActive = true,
}: SelectListProps<T>) {
  useInput(
    (_input, key) => {
      if (key.upArrow) onIndexChange(Math.max(0, index - 1));
      else if (key.downArrow)
        onIndexChange(Math.min(items.length - 1, index + 1));
      else if (key.return) {
        const chosen = items[index];
        if (chosen !== undefined) onSelect(chosen);
      } else if (key.escape) onCancel?.();
    },
    { isActive }
  );

  return (
    <Box flexDirection="column">
      {items.map((item, position) => (
        <Text
          key={label(item)}
          color={position === index ? "cyan" : undefined}
          bold={position === index}
        >
          {position === index ? "❯ " : "  "}
          {label(item)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * 极简单行输入。只处理打字、粘贴与退格——Ink 会把整段粘贴作为一次 input 送来，
 * 所以直接拼接即可。同一时刻只挂载一个，避免多个 useInput 抢同一份按键。
 */
export function TextField({
  value,
  onChange,
  mask,
}: {
  value: string;
  onChange: (next: string) => void;
  mask?: boolean;
}) {
  useInput((input, key) => {
    if (key.return || key.tab || key.escape || key.upArrow || key.downArrow) {
      return;
    }
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input) onChange(value + input);
  });

  return (
    <Text>
      {mask ? "•".repeat(value.length) : value}
      <Text inverse> </Text>
    </Text>
  );
}

export function Hint({ children }: { children: string }) {
  return <Text dimColor>{children}</Text>;
}

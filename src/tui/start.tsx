import { render } from "ink";
import { notifyMacOS } from "../adapters/notify.ts";
import { spawnPgTool } from "../adapters/pg-tool.ts";
import { defaultConfigPath } from "../core/config.ts";
import { defaultStatePath } from "../core/state.ts";
import { App } from "./app.tsx";

/**
 * 界面的唯一启动点。适配器在这里注入，界面自己不 new 任何东西。
 * 这个模块只会被无参启动时动态引入——带参数的命令行路径不会加载 Ink。
 */
export async function startTui(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(
      "交互界面需要终端。在管道或无终端环境下请用带参数的命令，例如：\n" +
        "  mgdb backup --source <数据源名>"
    );
    return 2;
  }

  const instance = render(
    <App
      deps={{
        configPath: defaultConfigPath(),
        statePath: defaultStatePath(),
        runPgTool: spawnPgTool,
        notify: notifyMacOS,
      }}
    />
  );

  await instance.waitUntilExit();
  return 0;
}

import type { Notify, RunPgTool } from "../core/types.ts";

/** 界面拿到的一切外部依赖。界面自己不 new 任何适配器，全部由启动处注入。 */
export interface TuiDeps {
  configPath: string;
  statePath: string;
  runPgTool: RunPgTool;
  notify: Notify;
}

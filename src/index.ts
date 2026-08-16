#!/usr/bin/env bun
import { main } from "./cli/run.ts";

process.exit(await main(Bun.argv.slice(2)));

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Lifecycle } from "../src/lifecycle.ts";

const args = process.argv.slice(2);
const flag = args.indexOf("--agent-dir");
let directory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
if (flag !== -1) {
  if (!args[flag + 1]) throw new Error("--agent-dir requires a path");
  directory = resolve(args[flag + 1]); args.splice(flag, 2);
}
const life = new Lifecycle(directory);
try {
  const [command, source] = args;
  if (command === "enable" || command === "disable") {
    await life.setEnabled(command === "enable");
    console.log(`Compactor ${command}d. Restart pi or run /reload.`);
  } else if (command === "uninstall") {
    if (!source) throw new Error("Usage: node bin/manage.mjs uninstall <installed-source> [--agent-dir <path>]");
    await promisify(execFile)("pi", ["remove", source], { timeout: 30_000 });
    await life.release();
    console.log("Compactor removed. Original native automatic-compaction settings restored.");
  } else if (command === "restore-native") {
    await life.release();
    console.log("Original native automatic-compaction settings restored. Use this only after removing the extension.");
  } else {
    throw new Error("Usage: node bin/manage.mjs <enable|disable|restore-native|uninstall source> [--agent-dir <path>]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}

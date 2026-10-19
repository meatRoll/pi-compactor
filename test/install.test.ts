import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { Lifecycle } from "../src/lifecycle.ts";

const exec = promisify(execFile);
test("actual pi package install, disabled restart and plugin uninstall restore the original native setting", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-install-"));
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const options = { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_TELEMETRY: "0", PI_OFFLINE: "1", PATH: `${resolve("node_modules/.bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }, timeout: 15_000 };
  const prompt = (message: string) => {
    const running = exec(process.execPath, [cli, "--offline", "--mode", "json", "--print", "--no-tools", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--model", "compactor-test/model", message], options);
    running.child.stdin?.end();
    return running;
  };
  const settings = async () => JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1234 }, quietStartup: true }));
    await writeFile(join(root, "models.json"), JSON.stringify({ providers: { "compactor-test": { api: "openai-completions", apiKey: "test-key", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "model", name: "Test", contextWindow: 200_000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await exec(process.execPath, [cli, "install", resolve(".")], options);
    assert.equal((await settings()).packages.length, 1);
    await prompt("/compactor disable");
    const life = new Lifecycle(root);
    assert.equal((await life.read())?.enabled, false);
    assert.equal((await settings()).compaction.enabled, false);
    const disabled = await prompt("/compactor");
    assert.match(disabled.stderr, /disabled/);
    assert.equal((await life.read())?.enabled, false);
    await prompt("/compactor enable");
    assert.equal((await life.read())?.enabled, true);
    const uninstalled = await prompt("/compactor uninstall");
    assert.equal((await settings()).packages.length, 0, uninstalled.stderr);
    assert.equal((await settings()).compaction.enabled, true);
    assert.equal((await settings()).compaction.reserveTokens, 1234);
    assert.equal(await life.read(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git-source install loads the shipped manifest and uninstall restores native ownership", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-git-install-"));
  const checkout = join(root, "source"), agent = join(root, "agent"), work = join(root, "work");
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const source = "git:https://compactor-test.invalid/owner/repository";
  try {
    await Promise.all([mkdir(checkout), mkdir(agent), mkdir(work)]);
    await Promise.all(["src", "bin", "docs", "package.json", "package-lock.json", "README.md", "LICENSE"].map(file => cp(resolve(file), join(checkout, file), { recursive: true })));
    await exec("git", ["init", "--quiet", checkout]);
    await exec("git", ["add", "."], { cwd: checkout });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Fixture"], { cwd: checkout });
    const options = { cwd: work, timeout: 20_000, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0", PI_OFFLINE: "1", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${pathToFileURL(checkout).href}.insteadOf`, GIT_CONFIG_VALUE_0: "https://compactor-test.invalid/owner/repository" } };
    await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
    await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "compactor-test": { api: "openai-completions", apiKey: "test-key", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "model", name: "Test", contextWindow: 200_000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await exec(process.execPath, [cli, "install", source], options);
    const prompt = (message: string) => {
      const running = exec(process.execPath, [cli, "--offline", "--mode", "json", "--print", "--no-tools", "--no-mcp", "--no-context-files", "--no-skills", "--no-prompt-templates", "--model", "compactor-test/model", message], options);
      running.child.stdin?.end(); return running;
    };
    const changed = await prompt("/compactor off");
    const { ConfigStore } = await import("../src/storage.ts");
    assert.equal((await new ConfigStore(agent).load()).automatic, false, changed.stderr);
    assert.equal((await new Lifecycle(agent).read())?.originalNativeEnabled, true);
    const removed = await prompt("/compactor uninstall");
    const native = JSON.parse(await readFile(join(agent, "settings.json"), "utf8"));
    assert.equal(native.packages.length, 0, removed.stderr);
    assert.equal(native.compaction.enabled, true);
    assert.equal(await new Lifecycle(agent).read(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/storage.ts";
import { response } from "./fixture.ts";

test("actual CLI RPC mode applies the request gate and keeps stdout valid JSONL", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-rpc-"));
  const calls: string[] = [];
  const server = createServer(async (request, outgoing) => {
    let data = ""; for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    const summary = JSON.stringify(body.messages[0]).includes("Create a concise context checkpoint");
    calls.push(summary ? "summary" : "chat");
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: summary ? "Checkpoint: continue the task." : "RPC response." }, finish_reason: null }] };
    outgoing.write(`data: ${JSON.stringify(chunk)}\n\n`);
    outgoing.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    outgoing.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { "compactor-test": { api: "openai-completions", apiKey: "test-key", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "model", name: "RPC test", contextWindow: 200_000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await new ConfigStore(root).update(c => { c.global.all = { trigger: { unit: "tokens", value: 30_000 }, target: { unit: "tokens", value: 5_000 } }; });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Earlier conversation. ".repeat(12_000), timestamp: 1 });
  const previous = response(); previous.usage.input = 50_000; previous.usage.totalTokens = 50_001; manager.appendMessage(previous);
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-extensions", "--no-mcp", "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--system-prompt", "Test system", "-e", resolve("src/index.ts"), "--model", "compactor-test/model", "--session", manager.getSessionFile()!], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  const records: any[] = [];
  const waiters = new Set<(record: any) => void>();
  let pending = "", stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n"); if (newline < 0) break;
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      let record: any;
      try { record = JSON.parse(line); } catch { record = { type: "invalid-json", line }; }
      records.push(record); for (const waiter of waiters) waiter(record);
    }
  });
  function waitFor(predicate: (record: any) => boolean): Promise<any> {
    const found = records.find(predicate); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(onRecord); reject(new Error(`RPC timeout. stderr=${stderr}; records=${JSON.stringify(records)}`)); }, 15_000);
      const onRecord = (record: any) => { if (predicate(record)) { clearTimeout(timer); waiters.delete(onRecord); resolve(record); } };
      waiters.add(onRecord);
    });
  }
  const send = (command: object) => child.stdin.write(JSON.stringify(command) + "\n");
  try {
    send({ id: "state", type: "get_state" });
    const state = await waitFor(record => record.id === "state");
    assert.equal(state.success, true, stderr);
    assert.equal(state.data.autoCompactionEnabled, false);
    send({ id: "prompt", type: "prompt", message: "Continue the work." });
    await waitFor(record => record.type === "agent_settled");
    assert.deepEqual(calls, ["summary", "chat"], stderr + JSON.stringify(records));
    assert.equal(records.some(record => record.type === "invalid-json" || record.type === "extension_error"), false);
    assert.equal(records.some(record => record.type === "extension_ui_request" && ["custom", "setStatus", "select", "confirm"].includes(record.method)), false);
    assert.ok(records.some(record => record.type === "message_end" && record.message?.role === "assistant" && record.message.stopReason === "stop"));
    send({ id: "entries", type: "get_entries" });
    const entries = await waitFor(record => record.id === "entries");
    assert.ok(entries.data.entries.some((entry: any) => entry.type === "compaction" && entry.fromHook));
  } finally {
    child.stdin.end(); child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once("exit", () => resolve()); });
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

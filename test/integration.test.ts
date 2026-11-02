import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { estimateMessages } from "../src/compaction.ts";
import { fixture, response } from "./fixture.ts";

async function attempts(root: string): Promise<any[]> {
  const text = await readFile(join(root, "compactor", "compactions.jsonl"), "utf8");
  return text.trim().split("\n").map(line => JSON.parse(line));
}

test("real pi SDK checks before the first provider call, persists a checkpoint and preserves system context", async () => {
  const f = await fixture();
  try {
    f.seed(); await f.session.prompt("Continue the work.");
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.calls.map(c => c.kind), ["summary", "chat"]);
    assert.ok(f.manager.getEntries().some(e => e.type === "compaction" && e.fromHook));
    assert.ok(f.manager.getEntries().some(e => e.type === "message" && e.message.role === "user" && typeof e.message.content === "string" && e.message.content.length > 100_000));
    assert.equal(f.calls[1]!.context.messages[0]?.role, "system");
    assert.ok(estimateMessages(f.session.messages) < 30_000);
    assert.equal(f.session.autoCompactionEnabled, false);
  } finally { await f.close(); }
});

test("summarization caps output above the summary budget without reserving the model limit", async () => {
  const f = await fixture({ maxTokens: 393_216 });
  try {
    f.seed(); await f.session.prompt("Continue the work.");
    const summary = f.calls.find(call => call.kind === "summary");
    assert.ok(summary);
    assert.equal(summary.maxTokens, 32_768);
  } finally { await f.close(); }
});

const DISABLE_THINKING = { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };

for (const level of ["max", "off"] as const) {
  test(`summaries use the request thinking level (${level}) and mirror pi native compaction`, async () => {
    const f = await fixture({ reasoning: true, thinkingLevelMap: DISABLE_THINKING });
    try {
      f.session.setThinkingLevel(level);
      f.seed(); await f.session.prompt("Continue the work.");
      assert.deepEqual(f.errors, []);
      assert.equal(f.calls.find(call => call.kind === "summary")?.reasoning, level === "off" ? undefined : level);
    } finally { await f.close(); }
  });
}

test("models that cannot disable thinking summarize at the clamped lowest level", async () => {
  const f = await fixture({ reasoning: true, thinkingLevelMap: { ...DISABLE_THINKING, off: null } });
  try {
    f.session.setThinkingLevel("off");
    assert.equal(f.session.thinkingLevel, "low");
    f.seed(); await f.session.prompt("Continue the work.");
    assert.deepEqual(f.errors, []);
    assert.equal(f.calls.find(call => call.kind === "summary")?.reasoning, "low");
  } finally { await f.close(); }
});

test("tool follow-up requests are checked, including an oversized inseparable tool-result group", async () => {
  const f = await fixture({ tool: true, chat: index => {
    const r = response();
    if (index === 0) { r.stopReason = "toolUse"; r.content = [{ type: "toolCall", id: "call1", name: "big_result", arguments: {} }]; r.usage.input = 25_000; r.usage.totalTokens = 25_001; }
    return r;
  } });
  try {
    await f.session.prompt("Use the tool and continue.");
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.calls.map(c => c.kind), ["chat", "summary", "chat"]);
    const checkpoint = f.manager.getEntries().find(e => e.type === "compaction");
    assert.ok(checkpoint && checkpoint.type === "compaction");
    assert.equal(checkpoint.firstKeptEntryId, checkpoint.id);
  } finally { await f.close(); }
});

test("a failed summary prevents the conversational provider request and preserves history", async () => {
  const f = await fixture({ summary: () => ({ ...response(), stopReason: "error", errorMessage: "Summary unavailable" }) });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["summary"]);
    assert.equal(f.manager.getEntries().some(e => e.type === "compaction"), false);
    assert.match(f.session.getLastAssistantText() ?? f.session.messages.findLast(m => m.role === "assistant")?.errorMessage ?? "", /Summary unavailable|Compactor/);
  } finally { await f.close(); }
});

test("compaction attempts are recorded with provider failure details", async () => {
  const failed = await fixture({ summary: () => ({ ...response(), stopReason: "error", errorMessage: "terminated" }) });
  try {
    failed.seed(); await failed.session.prompt("Continue.");
    const [record] = await attempts(failed.root);
    assert.ok(record);
    assert.equal(record.ok, false);
    assert.equal(record.phase, "attempt");
    assert.match(record.error, /terminated/);
    assert.equal(record.stopReason, "error");
    assert.equal(record.model.provider, "compactor-test");
    assert.ok(record.tokensBefore >= 50_000);
    assert.equal(record.attempts, 1);
    assert.ok(record.durationMs >= 0);
  } finally { await failed.close(); }
  const completed = await fixture();
  try {
    completed.seed(); await completed.session.prompt("Continue.");
    const [record] = await attempts(completed.root);
    assert.ok(record);
    assert.equal(record.ok, true);
    assert.equal(record.phase, "completed");
    assert.equal(record.error, undefined);
    assert.ok(record.tokensAfter < record.tokensBefore);
    assert.ok(record.summaryChars > 0);
  } finally { await completed.close(); }
});

test("a transient compaction failure cannot trigger pi's enabled automatic model retry", async () => {
  const f = await fixture({ retry: true, summary: () => ({ ...response(), stopReason: "error", errorMessage: "429 rate limit exceeded" }) });
  try {
    f.seed(); await f.session.prompt("Continue.");
    // The summary itself retries under the session policy, but the paused
    // conversational request is never retried by pi's automatic retry.
    assert.deepEqual(f.calls.filter(call => call.kind === "chat"), []);
    assert.equal(f.calls.filter(call => call.kind === "summary").length, 3);
    assert.equal(f.session.autoRetryEnabled, true);
    assert.equal(f.manager.getEntries().some(entry => entry.type === "compaction"), false);
    const [record] = await attempts(f.root);
    assert.equal(record.attempts, 3);
  } finally { await f.close(); }
});

test("a transient summarization failure is retried and the compaction completes", async () => {
  let summaries = 0;
  const f = await fixture({ retry: true, summary: () => {
    summaries++;
    return summaries === 1
      ? { ...response(), stopReason: "error", errorMessage: "terminated" }
      : response("Checkpoint after retry.");
  } });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.equal(summaries, 2);
    assert.deepEqual(f.calls.map(call => call.kind), ["summary", "summary", "chat"]);
    assert.ok(f.manager.getEntries().some(entry => entry.type === "compaction" && entry.fromHook));
    const [record] = await attempts(f.root);
    assert.equal(record.ok, true);
    assert.equal(record.attempts, 2);
  } finally { await f.close(); }
});

test("a deterministic summarization failure is not retried", async () => {
  let summaries = 0;
  const f = await fixture({ retry: true, summary: () => {
    summaries++;
    return { ...response(), stopReason: "error", errorMessage: "401: Invalid 'Authorization' header" };
  } });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.equal(summaries, 1);
    assert.deepEqual(f.calls.map(call => call.kind), ["summary"]);
    const [record] = await attempts(f.root);
    assert.equal(record.attempts, 1);
  } finally { await f.close(); }
});

test("a successful but still oversized checkpoint pauses rather than looping", async () => {
  const f = await fixture({ summary: () => response("x".repeat(140_000)) });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["summary"]);
    assert.equal(f.manager.getEntries().filter(e => e.type === "compaction").length, 1);
  } finally { await f.close(); }
});

test("automatic off skips plugin and native automatic rules even above the native threshold", async () => {
  const f = await fixture({ automatic: false });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
    assert.equal(f.session.autoCompactionEnabled, false);
  } finally { await f.close(); }
});

test("reload refreshes the snapshot and rebinds a single gate to the same SDK session", async () => {
  const f = await fixture();
  try {
    await f.store.update(c => { c.global.all.trigger = { unit: "tokens", value: 70_000 }; });
    assert.equal(f.controller.effective().trigger.tokens, 30_000);
    await f.session.reload();
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.effective().trigger.tokens, 70_000);
    f.seed(); await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
  } finally { await f.close(); }
});

test("unknown model capacity does not fail startup; selecting a known model restores the footer", async () => {
  const f = await fixture({ mode: "tui", unknownCapacity: true });
  try {
    assert.equal(f.session.model?.contextWindow, 0);
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.active, true);
    assert.equal(f.statuses.get("compactor"), undefined);
    assert.ok(f.notices.some(message => message.includes("capacity is unavailable")));
    await f.session.setModel({ ...f.session.model!, id: "known-capacity", contextWindow: 200_000 });
    assert.deepEqual(f.errors, []);
    assert.equal(f.statuses.get("compactor"), "Compact at 15%");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("TUI refusing a corrupt-config reset disables the whole plugin until explicitly enabled", async () => {
  const f = await fixture({ corrupt: true, mode: "tui", reset: false });
  try {
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.active, false);
    assert.equal((await f.controller.lifecycle.read())?.enabled, false);
    assert.equal(f.session.autoCompactionEnabled, false);
    assert.ok(f.notices.some(message => message.includes("disabled")));
    await f.session.prompt("Continue without the plugin.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
    await f.session.reload();
    assert.equal(f.controller.active, false);
    assert.equal(f.session.autoCompactionEnabled, false);
    assert.equal(f.statuses.get("compactor"), undefined);
    await f.store.reset();
    await f.controller.enable(f.session.extensionRunner.createCommandContext());
    assert.equal(f.controller.active, true);
  } finally { await f.close(); }
});

test("TUI consenting to reset recovers configuration without making a backup", async () => {
  const f = await fixture({ corrupt: true, mode: "tui", reset: true });
  try {
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.active, true);
    assert.equal(f.controller.effective().trigger.tokens, 160_000);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual((await readdir(f.controller.store.path.replace(/settings\.json$/, ""))).sort(), ["lifecycle.json", "settings.json"]);
  } finally { await f.close(); }
});

test("manual compaction remains native and available when plugin automatic compaction is off", async () => {
  const f = await fixture({ automatic: false });
  try {
    f.seed();
    f.manager.appendMessage({ role: "user", content: "Another topic. ".repeat(10_000), timestamp: 3 });
    const previous = response("Another answer."); previous.timestamp = 4; f.manager.appendMessage(previous);
    f.session.refreshContext();
    const result = await f.session.compact();
    assert.ok(result.summary);
    assert.ok(f.calls.length > 0);
    assert.equal(f.calls.some(call => call.kind === "summary"), false);
  } finally { await f.close(); }
});

test("edits save immediately without compacting, clearing restores inheritance, and invalid edits never save", async () => {
  const f = await fixture();
  try {
    f.seed();
    await f.controller.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 45_000 }, f.session.model!);
    assert.equal(f.controller.effective().trigger.tokens, 45_000);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.controller.edit({ scope: "repository" }, "target", { unit: "tokens", value: 45_000 }, f.session.model!), /must be below/);
    assert.deepEqual((await f.store.load()).repositories, {});
    await f.controller.edit({ scope: "session" }, "trigger", undefined, f.session.model!);
    assert.equal(f.controller.effective().trigger.tokens, 30_000);
    assert.equal(f.calls.length, 0);
    await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["summary", "chat"]);
  } finally { await f.close(); }
});

test("a persisted target/trigger conflict pauses only when the trigger is reached", async () => {
  const f = await fixture();
  try {
    await f.store.update(c => { c.global.all.target = { unit: "tokens", value: 35_000 }; });
    await f.session.reload();
    await f.session.prompt("A small request is allowed.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
    f.seed(); await f.session.prompt("A large request must pause.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
    assert.equal(f.manager.getEntries().some(entry => entry.type === "compaction"), false);
  } finally { await f.close(); }
});

test("corrupt non-interactive configuration never reaches a provider", async () => {
  const f = await fixture({ corrupt: true });
  try {
    await f.session.prompt("Continue.");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("a 413 request-body overflow compacts and retries the failed turn once", async () => {
  let chats = 0;
  const f = await fixture({ chat: index => index === 0
    ? { ...response(), content: [], stopReason: "error", errorMessage: '413 "Request body too large"' }
    : response("Recovered after compaction.") });
  try {
    await f.controller.edit({ scope: "session" }, "target", { unit: "tokens", value: 10_000 }, f.session.model!);
    f.manager.appendMessage({ role: "user", content: [
      { type: "text", text: "Earlier image and context. ".repeat(2_000) },
      { type: "image", mimeType: "image/png", data: "A".repeat(200_000) },
    ], timestamp: 1 });
    const first = response("Earlier answer."); first.timestamp = 2; first.usage.input = 10_000; first.usage.totalTokens = 10_001;
    f.manager.appendMessage(first);
    f.manager.appendMessage({ role: "user", content: "More recent context. ".repeat(1_700), timestamp: 3 });
    const recent = response("Recent answer."); recent.timestamp = 4; recent.usage.input = 15_000; recent.usage.totalTokens = 15_001;
    f.manager.appendMessage(recent);
    f.session.refreshContext();

    await f.session.prompt("Continue after the failed request.");

    // The failed request is omitted, the image-bearing prefix is compacted once,
    // and the turn is retried without another user prompt or the old image bytes.
    assert.deepEqual(f.calls.map(c => c.kind), ["chat", "summary", "chat"]);
    assert.equal(f.session.getLastAssistantText(), "Recovered after compaction.");
    assert.ok(!JSON.stringify(f.calls.find(call => call.kind === "summary")!.context).includes('"type":"image"'));
    assert.ok(!JSON.stringify(f.calls.at(-1)!.context).includes('"type":"image"'));
    assert.ok(!JSON.stringify(f.calls.at(-1)!.context).includes("Request body too large"));
    const checkpoint = f.manager.getEntries().find(entry => entry.type === "compaction");
    assert.ok(checkpoint && checkpoint.type === "compaction");
    assert.equal(checkpoint.fromHook, true);
    assert.equal(f.session.autoCompactionEnabled, false);
    const [record] = await attempts(f.root);
    assert.equal(record.reason, "overflow");
    assert.equal(record.phase, "completed");
  } finally { await f.close(); }
});

test("a repeated 413 does not start a second compact-and-retry loop", async () => {
  const f = await fixture({ chat: () => ({ ...response(), content: [], stopReason: "error", errorMessage: '413 "Request body too large"' }) });
  try {
    await f.controller.edit({ scope: "session" }, "target", { unit: "tokens", value: 10_000 }, f.session.model!);
    f.manager.appendMessage({ role: "user", content: "Earlier context. ".repeat(2_000), timestamp: 1 });
    const first = response("Earlier answer."); first.timestamp = 2; first.usage.input = 10_000; first.usage.totalTokens = 10_001;
    f.manager.appendMessage(first);
    f.manager.appendMessage({ role: "user", content: "More recent context. ".repeat(1_700), timestamp: 3 });
    const recent = response("Recent answer."); recent.timestamp = 4; recent.usage.input = 15_000; recent.usage.totalTokens = 15_001;
    f.manager.appendMessage(recent);
    f.session.refreshContext();

    await f.session.prompt("This will still be too large.");

    assert.deepEqual(f.calls.map(c => c.kind), ["chat", "summary", "chat"]);
  } finally { await f.close(); }
});

test("automatic off leaves a 413 untouched for manual recovery", async () => {
  const f = await fixture({ automatic: false, chat: () => ({ ...response(), content: [], stopReason: "error", errorMessage: '413 "Request body too large"' }) });
  try {
    f.manager.appendMessage({ role: "user", content: "Earlier context. ".repeat(2_000), timestamp: 1 });
    f.manager.appendMessage(response("Earlier answer."));
    f.session.refreshContext();
    await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["chat"]);
    assert.equal(f.manager.getEntries().some(entry => entry.type === "compaction"), false);
  } finally { await f.close(); }
});

test("a resumed session whose last response was a 413 compacts before the next request", async () => {
  const f = await fixture();
  try {
    await f.controller.edit({ scope: "session" }, "target", { unit: "tokens", value: 10_000 }, f.session.model!);
    f.manager.appendMessage({ role: "user", content: "Earlier context. ".repeat(2_000), timestamp: 1 });
    const first = response("Earlier answer."); first.timestamp = 2; first.usage.input = 10_000; first.usage.totalTokens = 10_001;
    f.manager.appendMessage(first);
    f.manager.appendMessage({ role: "user", content: "More recent context. ".repeat(1_700), timestamp: 3 });
    const failed = { ...response(), content: [], stopReason: "error" as const, errorMessage: '413 "Request body too large"' };
    failed.timestamp = 4;
    f.manager.appendMessage(failed);
    f.session.refreshContext();

    await f.session.prompt("Continue after restarting pi.");

    assert.deepEqual(f.calls.map(c => c.kind), ["summary", "chat"]);
    assert.equal(f.session.getLastAssistantText(), "OK");
    assert.ok(!JSON.stringify(f.calls.at(-1)!.context).includes("Request body too large"));
    const [record] = await attempts(f.root);
    assert.equal(record.reason, "overflow");
  } finally { await f.close(); }
});

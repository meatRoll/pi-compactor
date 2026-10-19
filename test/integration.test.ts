import assert from "node:assert/strict";
import test from "node:test";
import { estimateMessages } from "../src/compaction.ts";
import { fixture, response } from "./fixture.ts";

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

test("a transient compaction failure cannot trigger pi's enabled automatic model retry", async () => {
  const f = await fixture({ retry: true, summary: () => ({ ...response(), stopReason: "error", errorMessage: "429 rate limit exceeded" }) });
  try {
    f.seed(); await f.session.prompt("Continue.");
    assert.deepEqual(f.calls.map(c => c.kind), ["summary"]);
    assert.equal(f.session.autoRetryEnabled, true);
    assert.equal(f.manager.getEntries().some(entry => entry.type === "compaction"), false);
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

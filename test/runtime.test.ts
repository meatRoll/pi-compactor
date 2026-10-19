import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { Compactor } from "../src/controller.ts";
import { sessionSettings } from "../src/session.ts";
import { fixture, response } from "./fixture.ts";

test("real runtime new/resume/fork/clone preserve session independence and the instance configuration snapshot", async () => {
  const f = await fixture();
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); f.session.dispose();
  let current!: Compactor;
  const errors: string[] = [];
  const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Test system", extensionFactories: [pi => {
      const controller = new Compactor(pi, agentDir); current = controller;
      pi.on("session_start", (event, ctx) => controller.start(event, ctx));
      pi.on("session_shutdown", event => controller.shutdown(event.reason));
    }] });
    await resourceLoader.reload();
    const services = { cwd, agentDir, settingsManager, resourceLoader, modelRuntime: f.runtime, diagnostics: [] };
    const result = await createAgentSession({ ...services, sessionManager, sessionStartEvent, model: f.runtime.getModel("compactor-test", "model"), noTools: "all" });
    return { ...result, services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd: f.root, agentDir: f.root, sessionManager: SessionManager.create(f.root, join(f.root, "sessions")) });
  const bind = async () => { await runtime.session.bindExtensions({ mode: "print", onError: error => errors.push(error.error) }); };
  runtime.setRebindSession(bind);
  try {
    await bind();
    const firstUser = runtime.session.sessionManager.appendMessage({ role: "user", content: "Source conversation", timestamp: 1 });
    runtime.session.sessionManager.appendMessage(response()); runtime.session.refreshContext();
    await current.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 42_000 }, runtime.session.model!);
    const source = runtime.session.sessionFile!;
    await f.store.update(c => { c.global.all.trigger = { unit: "tokens", value: 75_000 }; });
    await runtime.fork(firstUser, { position: "before" });
    assert.equal(current.effective().trigger.tokens, 42_000);
    assert.equal(current.configuration.global.all.trigger?.value, 30_000);
    await current.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 43_000 }, runtime.session.model!);
    assert.equal(sessionSettings(SessionManager.open(source).getEntries()).all.trigger?.value, 42_000);
    assert.equal(runtime.session.autoCompactionEnabled, false);
    await runtime.newSession();
    assert.equal(current.session.all.trigger, undefined);
    assert.equal(current.effective().trigger.tokens, 30_000);
    await runtime.switchSession(source);
    assert.equal(current.effective().trigger.tokens, 42_000);
    assert.equal(current.configuration.global.all.trigger?.value, 30_000);
    await runtime.fork(runtime.session.sessionManager.getLeafId()!, { position: "at" }); // pi /clone uses this exact operation.
    assert.equal(current.effective().trigger.tokens, 42_000);
    await current.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 47_000 }, runtime.session.model!);
    assert.equal(sessionSettings(SessionManager.open(source).getEntries()).all.trigger?.value, 42_000);
    await runtime.session.reload();
    assert.equal(current.configuration.global.all.trigger?.value, 75_000);
    assert.equal(current.effective().trigger.tokens, 47_000);
    assert.equal(runtime.session.autoCompactionEnabled, false);
    assert.deepEqual(errors, []);
  } finally { await runtime.dispose(); await rm(f.root, { recursive: true, force: true }); }
});

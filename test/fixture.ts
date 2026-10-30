import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Compactor } from "../src/controller.ts";
import { ConfigStore } from "../src/storage.ts";

export function response(text = "OK"): AssistantMessage {
  return { role: "assistant", api: "openai-completions", provider: "compactor-test", model: "model", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text }], usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export async function fixture(options: { summary?: () => AssistantMessage; chat?: (index: number) => AssistantMessage; corrupt?: boolean; automatic?: boolean; tool?: boolean; mode?: ExtensionContext["mode"]; reset?: boolean; retry?: boolean; unknownCapacity?: boolean; installOnReload?: boolean; maxTokens?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "compactor-sdk-"));
  const store = new ConfigStore(root);
  await store.update(c => { c.global.all = { trigger: { unit: "tokens", value: 30_000 }, target: { unit: "tokens", value: 5_000 } }; c.automatic = options.automatic ?? true; });
  if (options.corrupt) { const { writeFile } = await import("node:fs/promises"); await writeFile(store.path, "broken"); }
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const calls: { kind: "summary" | "chat"; context: Context; maxTokens?: number }[] = [];
  let chats = 0;
  runtime.registerProvider("compactor-test", {
    api: "openai-completions", baseUrl: "https://example.invalid", apiKey: "test-key",
    models: [{ id: "model", name: "Test", contextWindow: 200_000, maxTokens: options.maxTokens ?? 8_192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (_model, context, streamOptions) => {
      const summary = getCurrentSystemPrompt(context.messages).includes("Create a concise context checkpoint");
      calls.push({ kind: summary ? "summary" : "chat", context: structuredClone(context), maxTokens: streamOptions?.maxTokens });
      const message = summary ? options.summary?.() ?? response("Checkpoint: continue the current task.") : options.chat?.(chats++) ?? response();
      const stream = createAssistantMessageEventStream();
      if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
      else stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      stream.end();
      return stream;
    },
  });
  let controller!: Compactor;
  let installed = !options.installOnReload;
  const factory = (pi: ExtensionAPI) => {
    if (!installed) return;
    controller = new Compactor(pi, root);
    pi.registerCommand("compactor", { handler: async () => {} });
    pi.on("session_start", (event, ctx) => controller.start(event, ctx));
    pi.on("session_shutdown", event => controller.shutdown(event.reason));
    if (options.tool) {
      pi.registerTool({ name: "big_result", label: "Result", description: "Return a large result", parameters: { type: "object", properties: {} } as any,
        execute: async () => ({ content: [{ type: "text", text: "result".repeat(30_000) }], details: undefined }) });
    }
  };
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: options.retry ?? false, maxRetries: 2, baseDelayMs: 1 } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, systemPrompt: "Test system", noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
  await loader.reload();
  const manager = SessionManager.inMemory(root);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: options.unknownCapacity ? { ...runtime.getModel("compactor-test", "model")!, contextWindow: 0 } : runtime.getModel("compactor-test", "model"), settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: options.tool ? "builtin" : "all" });
  const errors: string[] = [];
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const ui = { confirm: async () => options.reset ?? false, notify: (message: string) => notices.push(message), setStatus: (key: string, text: string | undefined) => statuses.set(key, text), theme: { style: (text: string) => text } } as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: options.mode ?? "print", ...(options.mode === "tui" ? { uiContext: ui } : {}), onError: error => errors.push(error.error) });
  return { root, store, runtime, calls, session, manager, get controller() { return controller; }, errors, notices, statuses,
    async install() { installed = true; await session.reload(); },
    seed() {
      manager.appendMessage({ role: "user", content: "Earlier conversation. ".repeat(12_000), timestamp: 1 });
      const assistant = response("Previous response."); assistant.timestamp = 2; assistant.usage.input = 50_000; assistant.usage.totalTokens = 50_001;
      manager.appendMessage(assistant); session.refreshContext();
    },
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

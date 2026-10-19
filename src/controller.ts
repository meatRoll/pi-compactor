import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseColor } from "@earendil-works/pi-tui";
import { getAgentDir, getPackageDir, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { defaults, emptyLayer, footer, getLayer, resolve, setField, sourceLabel, type Amount, type Configuration, type Field, type Layer, type ModelIdentity, type Preferences, type Selection } from "./config.ts";
import { compactToTarget, estimateProjection, outcomeMessage, report } from "./compaction.ts";
import { installHostBridge } from "./host.ts";
import { Lifecycle } from "./lifecycle.ts";
import { currentSession, saveSession, sessionSettings } from "./session.ts";
import { ConfigStore, repositoryIdentity } from "./storage.ts";

const handoffKey = Symbol.for("pi-compactor/snapshots/v1");
const shared = globalThis as unknown as Record<symbol, Map<string, Configuration> | undefined>;
const handoffs = shared[handoffKey] ??= new Map();
export class Compactor {
  configuration = defaults();
  session: Layer = emptyLayer();
  repository = "";
  active = false;
  host?: AgentSession;
  context?: ExtensionContext;
  readonly store: ConfigStore;
  readonly lifecycle: Lifecycle;
  private readonly bridge = installHostBridge();
  private detachGate?: () => void;
  private listeners: (() => void)[] = [];
  private startupError?: Error;
  private lastWarning?: string;
  constructor(readonly pi: ExtensionAPI, agentDir = getAgentDir()) {
    this.store = new ConfigStore(agentDir);
    this.lifecycle = new Lifecycle(agentDir);
  }
  effective(model: ModelIdentity | undefined = this.context?.model) {
    if (!model || !(model.contextWindow > 0)) throw new Error("Select a model with a known context capacity.");
    return resolve(this.configuration, this.repository, this.session, model);
  }
  async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    this.host = this.bridge.get(ctx);
    // The SDK override also masks project-level native enabled=true values.
    this.host.settingsManager.applyOverrides({ compaction: { enabled: false } });
    this.active = true;
    this.startupError = undefined;
    this.attachGate(ctx);
    let canReset = false;
    try {
      const state = await this.lifecycle.acquire();
      if (!state.enabled) { this.stop(); return; }
      canReset = true;
      this.repository = await repositoryIdentity(ctx.cwd);
      const inherited = event.reason !== "startup" && event.reason !== "reload" && event.previousSessionFile ? handoffs.get(event.previousSessionFile) : undefined;
      this.configuration = inherited ? structuredClone(inherited) : await this.store.load();
      if (event.previousSessionFile) handoffs.delete(event.previousSessionFile);
      this.session = currentSession(ctx);
      const source = event.reason === "fork" ? event.previousSessionFile : event.reason === "new" ? ctx.sessionManager.getHeader()?.parentSession : undefined;
      if (source) {
        this.session = sessionSettings(SessionManager.open(source).getEntries());
        saveSession(this.pi, this.session);
      }
    } catch (error) {
      this.startupError = asError(error);
      if (!canReset || ctx.mode !== "tui") { report(ctx, this.startupError.message, "error"); return; }
      const reset = await ctx.ui.confirm("Compactor configuration error", `${this.startupError.message}\nReset compactor settings to defaults? Make your own backup first if needed.`);
      if (!reset) {
        await this.disable();
        report(ctx, "Compactor has been disabled. Native automatic compaction remains off. Re-enable explicitly with /compactor enable when ready.", "warning");
        return;
      }
      this.configuration = await this.store.reset();
      this.session = emptyLayer(); saveSession(this.pi, this.session);
      this.repository = await repositoryIdentity(ctx.cwd);
      this.startupError = undefined;
    }
    this.listeners.push(
      this.pi.on("model_select", (_event, context) => { this.context = context; this.warn(); this.updateStatus(); }),
      this.pi.on("session_tree", (_event, context) => { this.context = context; this.session = currentSession(context); this.updateStatus(); }),
      this.pi.on("session_before_compact", event => event.reason === "manual" ? undefined : { cancel: true }),
      this.pi.on("session_compact", () => this.updateStatus()),
      this.pi.on("message_end", () => this.updateStatus()),
      this.pi.on("turn_end", () => this.updateStatus()),
    );
    this.warn(); this.updateStatus();
  }
  private attachGate(ctx: ExtensionContext): void {
    const host = this.host!;
    const previous = host.agent.prepareRequest;
    const controller = this;
    const gate: NonNullable<typeof previous> = async (request, signal) => {
      const prepared = await previous?.(request, signal);
      const next = { ...request, ...prepared };
      if (!controller.active) return next;
      if (controller.startupError) throw paused(controller.startupError);
      // Users may toggle pi's native /settings switch while the plugin is active.
      host.settingsManager.applyOverrides({ compaction: { enabled: false } });
      const effective = controller.effective(next.model);
      const before = estimateProjection(host.sessionManager.buildSessionProjection(), host.sessionManager.getBranch());
      controller.updateStatus(before);
      if (!controller.configuration.automatic || before < effective.triggerPoint) return next;
      if (effective.invalid) {
        report(ctx, `Compactor: ${effective.invalid} Fix the configuration with /compactor.`, "error");
        throw paused(new Error(effective.invalid));
      }
      try {
        report(ctx, "Compacting context…");
        const after = await compactToTarget(host, ctx, effective, before, signal, next.model);
        controller.updateStatus(after);
        report(ctx, outcomeMessage(before, after, effective.target.tokens));
        if (after >= effective.triggerPoint) throw new Error("Compacted context is still at the trigger. Request paused; adjust settings or compact manually.");
        return { ...next, context: { ...next.context, messages: host.sessionManager.buildSessionProjection().messages } };
      } catch (error) {
        report(ctx, asError(error).message, "error");
        throw paused(error);
      }
    };
    host.agent.prepareRequest = gate;
    this.detachGate = () => { if (host.agent.prepareRequest === gate) host.agent.prepareRequest = previous; };
  }
  async edit(selection: Selection, field: Field, amount: Amount | undefined, model: ModelIdentity): Promise<void> {
    const candidate = structuredClone(this.configuration);
    const session = structuredClone(this.session);
    if (selection.scope === "repository" && !Object.hasOwn(candidate.repositories, this.repository)) candidate.repositories[this.repository] = emptyLayer();
    const layer = getLayer(candidate, session, this.repository, selection.scope);
    setField(layer, selection, field, amount);
    const effective = resolve(candidate, this.repository, session, model);
    if (effective.invalid) throw new Error(effective.invalid);
    if (selection.scope === "session") {
      saveSession(this.pi, session);
      this.session = session;
    } else {
      await this.store.update(latest => {
        if (selection.scope === "repository" && !Object.hasOwn(latest.repositories, this.repository)) latest.repositories[this.repository] = emptyLayer();
        setField(getLayer(latest, session, this.repository, selection.scope), selection, field, amount);
      });
      this.configuration = candidate;
    }
    this.warn(); this.updateStatus();
  }
  async preference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
    await this.store.update(c => { c.preferences[key] = value; });
    this.configuration.preferences[key] = value;
    this.updateStatus();
  }
  async automatic(enabled: boolean): Promise<void> {
    await this.store.update(c => { c.automatic = enabled; });
    this.configuration.automatic = enabled;
    this.updateStatus();
  }
  updateStatus(current?: number): void {
    const ctx = this.context;
    if (!ctx || ctx.mode !== "tui") return;
    if (!this.active || !ctx.model || !(ctx.model.contextWindow > 0) || this.startupError) { ctx.ui.setStatus("compactor", undefined); return; }
    const status = footer(this.configuration, this.effective(), ctx.model.contextWindow, current ?? ctx.getContextUsage()?.tokens ?? null);
    ctx.ui.setStatus("compactor", status ? ctx.ui.theme.style(status.text, { fg: status.color === "dim" ? "dim" : parseColor(status.color) }) : undefined);
  }
  warn(): void {
    if (!this.context?.model) return;
    const effective = this.context.model.contextWindow > 0 ? this.effective() : undefined;
    const warning = effective ? [effective.invalid, effective.warning].filter(Boolean).join(" ") || undefined : "The selected model's context capacity is unavailable. Select a model with a known capacity to preview compaction settings.";
    const key = `${this.context.sessionManager.getSessionId()}/${this.context.model.provider}/${this.context.model.id}/${warning}`;
    if (warning && key !== this.lastWarning) report(this.context, warning, "warning");
    this.lastWarning = key;
  }
  async disable(): Promise<void> {
    await this.lifecycle.setEnabled(false);
    this.stop();
  }
  async enable(ctx: ExtensionCommandContext): Promise<void> {
    await this.lifecycle.setEnabled(true);
    if (this.active) return;
    await this.start({ type: "session_start", reason: "reload" }, ctx);
  }
  async uninstall(ctx: ExtensionCommandContext): Promise<void> {
    const command = this.host?.extensionRunner.getRegisteredCommands().find(c => c.name === "compactor");
    if (!command || command.sourceInfo.origin !== "package") throw new Error("For a directly loaded extension, remove its configured path and run the repository's recovery CLI to restore native compaction. See README.");
    const info = command.sourceInfo;
    // Local package metadata is relative to its settings directory, while the
    // remove command resolves paths from cwd. Use the package's absolute root.
    const source = info.baseDir && /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(info.source) ? info.baseDir : info.source;
    const args = ["remove", source];
    if (info.scope === "project") args.push("--local");
    const script = [join(getPackageDir(), "dist", "bundle", "cli.js"), join(getPackageDir(), "dist", "cli.js")].find(existsSync);
    // Invoking the host script directly avoids Windows .cmd shim resolution.
    const executable = script || process.versions.bun ? process.execPath : "pi";
    const result = await this.pi.exec(executable, script ? [script, ...args] : args, { timeout: 30_000 });
    if (result.code !== 0) throw new Error(result.stderr || "Package removal failed; native compaction remains owned by the plugin.");
    this.stop();
    await this.lifecycle.release();
    await this.host!.settingsManager.reload();
    report(ctx, "Compactor uninstalled. Native automatic compaction has been restored. Run /reload to finish removing the extension.");
  }
  stop(): void {
    this.active = false;
    this.detachGate?.(); this.detachGate = undefined;
    for (const unsubscribe of this.listeners.splice(0)) unsubscribe();
    if (this.context?.mode === "tui") this.context.ui.setStatus("compactor", undefined);
  }
  shutdown(reason: string): void {
    const file = this.context?.sessionManager.getSessionFile();
    if (file && ["new", "resume", "fork"].includes(reason)) handoffs.set(file, structuredClone(this.configuration));
    this.stop(); this.bridge.dispose();
  }
  describe(field: Field): string {
    const value = this.effective()[field];
    return `${value.tokens.toLocaleString()} tokens — ${sourceLabel(value.source)}`;
  }
}
export function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
function paused(error: unknown): Error {
  // pi classifies retries by error-message text. Keep provider status/error
  // keywords in the separate notification so a failed summary is not retried.
  return new Error("Compactor paused the request. See the reported error; retry explicitly after resolving it.", { cause: error });
}

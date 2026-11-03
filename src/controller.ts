import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseColor } from "@earendil-works/pi-tui";
import { convertToLlm, getAgentDir, getPackageDir, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionProjection, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { defaults, emptyLayer, footer, getLayer, resolve, setField, sourceLabel, type Amount, type Configuration, type Effective, type Field, type Layer, type ModelIdentity, type Preferences, type Selection } from "./config.ts";
import { CompactionError, compactToTarget, estimateProjection, isOverflowError, isOverflowMessage, isRecoverableFailure, outcomeMessage, report, type CompactionReason, type CompactionResult } from "./compaction.ts";
import { DiagnosticsLog, type CompactionAttempt } from "./diagnostics.ts";
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
  readonly diagnostics: DiagnosticsLog;
  private readonly bridge = installHostBridge();
  private detachGate?: () => void;
  private listeners: (() => void)[] = [];
  private startupError?: Error;
  private lastWarning?: string;
  private routed?: { selection: NonNullable<AgentSession["model"]>; model: NonNullable<AgentSession["model"]>; thinkingLevel?: ThinkingLevel };
  private overflow?: { entryId: string; message: AssistantMessage; model?: NonNullable<AgentSession["model"]>; thinkingLevel?: ThinkingLevel; kind: "overflow" | "length" | "silent"; willRetry: boolean };
  private overflowRecoveryAttempted = false;
  constructor(readonly pi: ExtensionAPI, agentDir = getAgentDir()) {
    this.store = new ConfigStore(agentDir);
    this.lifecycle = new Lifecycle(agentDir);
    this.diagnostics = new DiagnosticsLog(agentDir);
  }
  effective(model: ModelIdentity | undefined = this.context?.model) {
    if (!model || !(model.contextWindow > 0)) throw new Error("Select a model with a known context capacity.");
    return resolve(this.configuration, this.repository, this.session, model);
  }
  /** Resolve settings for the selection, using the routed physical model's capacity. */
  private requestEffective(selection: Pick<ModelIdentity, "provider" | "id">, routed: Pick<ModelIdentity, "contextWindow">) {
    return resolve(this.configuration, this.repository, this.session, { provider: selection.provider, id: selection.id, contextWindow: routed.contextWindow });
  }
  async start(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    this.host = this.bridge.get(ctx);
    // The SDK override also masks project-level native enabled=true values.
    this.host.settingsManager.applyOverrides({ compaction: { enabled: false } });
    this.active = true;
    this.startupError = undefined;
    this.routed = undefined;
    this.overflow = undefined;
    this.overflowRecoveryAttempted = false;
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
      this.pi.on("session_tree", (_event, context) => {
        this.context = context;
        this.session = currentSession(context);
        this.routed = undefined;
        this.overflow = undefined;
        this.overflowRecoveryAttempted = false;
        this.updateStatus();
      }),
      this.pi.on("session_before_compact", event => event.reason === "manual" ? undefined : { cancel: true }),
      this.pi.on("session_compact", () => this.updateStatus()),
      this.pi.on("message_start", event => {
        if (event.message.role === "user") this.overflowRecoveryAttempted = false;
      }),
      this.pi.on("message_end", () => this.updateStatus()),
      this.pi.on("turn_end", event => {
        this.updateStatus();
        const message = event.message;
        if (message.role !== "assistant") { this.overflow = undefined; return; }
        // A recoverable length stop is an overflow signal in pi: output ended
        // below the model's limit, so compaction can make room and retry. A
        // successful response can also overflow silently when its reported
        // usage exceeds the window; pi compacts it without retrying.
        const model = this.messageModel(message) ?? this.routed?.model ?? this.host?.model ?? this.context?.model;
        const likely = model && (message.stopReason === "error" || message.stopReason === "length" ||
          (message.stopReason === "stop" && message.usage.input + message.usage.cacheRead > model.contextWindow));
        const candidate = likely && this.host
          ? this.classifyOverflow(message, model, this.host.sessionManager.buildSessionProjection())
          : undefined;
        this.overflow = candidate ? {
          entryId: candidate.entryId,
          message,
          model,
          thinkingLevel: message.thinkingLevel ?? this.routed?.thinkingLevel,
          kind: candidate.kind,
          willRetry: candidate.willRetry,
        } : undefined;
        if (message.stopReason !== "error" && message.stopReason !== "length") this.overflowRecoveryAttempted = false;
      }),
      // Native overflow recovery is disabled with native automatic compaction. Recover here
      // after the run so the failed request can be compacted and retried once.
      this.pi.on("agent_before_settle", () => this.recoverOverflow()),
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
      // host.model is the session selection (possibly virtual); next.model is the
      // physical model pi routed this request to.
      controller.routed = { selection: host.model ?? next.model, model: next.model, thinkingLevel: next.thinkingLevel };
      const effective = controller.requestEffective(controller.routed.selection, next.model);
      const projection = host.sessionManager.buildSessionProjection();
      let before = estimateProjection(projection, host.sessionManager.getBranch());
      controller.updateStatus(before);
      // Native pi checks the previous response for overflow before a new prompt.
      // Do the same, because native automatic compaction is disabled here. A
      // successful response that silently exceeded the window is compacted
      // without omission; a failed one is omitted before the retry.
      const lastAssistant = projection.messages.findLast(message => message.role === "assistant");
      const overflow = controller.configuration.automatic && lastAssistant
        ? controller.classifyOverflow(lastAssistant, next.model, projection)
        : undefined;
      if (overflow?.willRetry && controller.overflowRecoveryAttempted) {
        const error = new Error(overflow.kind === "length"
          ? "Truncated response recovery failed after one compact-and-retry attempt. Try /compact or reduce context."
          : "Context overflow recovery failed after one compact-and-retry attempt. Try /compact or reduce context.");
        report(ctx, error.message, "error");
        throw paused(error);
      }
      if (!controller.configuration.automatic || (!overflow && before < effective.triggerPoint)) return next;
      if (effective.invalid) {
        report(ctx, `Compactor: ${effective.invalid} Fix the configuration with /compactor.`, "error");
        throw paused(new Error(effective.invalid));
      }
      const reason: CompactionReason = overflow ? "overflow" : "threshold";
      const willRetry = overflow?.willRetry ?? false;
      if (overflow) {
        if (willRetry) {
          try {
            controller.omitAttempt(host, overflow.entryId, lastAssistant!);
          } catch (error) {
            report(ctx, asError(error).message, "error");
            throw paused(error);
          }
          before = estimateProjection(host.sessionManager.buildSessionProjection(), host.sessionManager.getBranch());
          report(ctx, "Context overflow: compacting before retrying…");
        } else {
          report(ctx, "Context overflow: compacting before continuing…");
        }
      }
      const started = Date.now();
      let result: CompactionResult;
      try {
        if (!overflow) report(ctx, "Compacting context…");
        result = await compactToTarget(host, ctx, effective, before, signal, next.model, next.thinkingLevel, reason, willRetry);
      } catch (error) {
        await controller.diagnose(ctx, next.model, effective, before, started, { ok: false, phase: "attempt", error }, reason, willRetry);
        report(ctx, asError(error).message, "error");
        throw paused(error);
      }
      if (result.after >= effective.triggerPoint) {
        const error = new Error("Compacted context is still at the trigger. Request paused; adjust settings or compact manually.");
        await controller.diagnose(ctx, next.model, effective, before, started, { ok: false, phase: "post-check", error, result }, reason, willRetry);
        report(ctx, error.message, "error");
        throw paused(error);
      }
      controller.updateStatus(result.after);
      report(ctx, outcomeMessage(before, result.after, effective.target.tokens));
      await controller.diagnose(ctx, next.model, effective, before, started, { ok: true, phase: "completed", result }, reason, willRetry);
      return { ...next, context: { ...next.context, messages: host.sessionManager.buildSessionProjection().messages } };
    };
    host.agent.prepareRequest = gate;
    this.detachGate = () => { if (host.agent.prepareRequest === gate) host.agent.prepareRequest = previous; };
  }
  private messageModel(message: AssistantMessage) {
    return this.context?.modelRegistry.find(message.provider, message.model);
  }
  /**
   * Classify the previous assistant response the way pi's `_checkCompaction()`
   * does. Overflow from a different model, an attempt older than the latest
   * compaction, or usage that no longer describes the projected context must
   * not trigger another compaction.
   */
  private classifyOverflow(
    message: AssistantMessage,
    model: NonNullable<AgentSession["model"]>,
    projection: SessionProjection,
  ): { entryId: string; willRetry: boolean; kind: "overflow" | "length" | "silent" } | undefined {
    const host = this.host;
    if (!host || message.provider !== model.provider || message.model !== model.id) return undefined;
    const projected = projection.entries.find(entry => entry.messages.includes(message));
    if (!projected) return undefined;
    const branch = host.sessionManager.getBranch();
    const index = branch.findIndex(entry => entry.id === projected.sourceEntry.id);
    if (index < 0) return undefined;
    // Use branch order rather than pi's timestamp comparison: equal-millisecond
    // timestamps (common with fast local providers) must not mark a new error as
    // older than the checkpoint that preceded it.
    const latestCompaction = branch.findLastIndex(entry => entry.type === "compaction");
    if (latestCompaction > index) return undefined;
    const entriesAfter = branch.slice(index + 1);
    const hasContextEdit = entriesAfter.some(entry => entry.type === "context_edit");
    const explicit = isOverflowError(message);
    const failed = isRecoverableFailure(message, model.maxTokens);
    const usageOverflow = !hasContextEdit && isOverflowMessage(message, model.contextWindow);
    if (!failed && !usageOverflow) return undefined;
    // pi only retries after a failed attempt. A completed response that silently
    // overflowed is compacted in place and must be preserved.
    const willRetry = message.stopReason !== "stop";
    return { entryId: projected.sourceEntry.id, willRetry, kind: willRetry ? (explicit ? "overflow" : "length") : "silent" };
  }
  /**
   * Persistently omit a failed attempt and its matching tool results, mirroring
   * pi's `_omitRecoveryAttempt()`. An unpaired tool result fails the next request.
   */
  private omitAttempt(host: AgentSession, entryId: string, message: AssistantMessage): void {
    const projection = host.sessionManager.buildSessionProjection();
    const sources = new Map<AgentMessage, string>();
    for (const entry of projection.entries) for (const projected of entry.messages) sources.set(projected, entry.sourceEntry.id);
    const index = projection.messages.findIndex(projected => projected === message || sources.get(projected) === entryId);
    const toolCallIds = new Set(message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []));
    const targets = new Set([entryId]);
    for (let i = index + 1; index >= 0 && i < projection.messages.length; i++) {
      const projected = projection.messages[i]!;
      if (projected.role === "assistant") break;
      if (projected.role !== "toolResult" || !toolCallIds.has(projected.toolCallId)) continue;
      const target = sources.get(projected);
      if (!target) throw new Error("Cannot persist recovery omission because a projected message has no source entry.");
      targets.add(target);
    }
    for (const target of targets) host.sessionManager.appendContextEdit(target, null);
    host.refreshContext();
  }
  private canContinue(host: AgentSession): boolean {
    const messages = convertToLlm(host.sessionManager.buildSessionProjection().messages);
    return messages.some(message => message.role !== "system") &&
      (messages.at(-1)?.role !== "assistant" || host.agent.hasQueuedMessages());
  }
  /** Seed pi's failed-response routing hint for the continuation request. */
  private markRetry(host: AgentSession, message: AssistantMessage): void {
    // pi has no public setter. Assign only when the host still carries the
    // field so a future rename degrades to a normal continuation.
    const state = host as unknown as { _failedResponse?: AssistantMessage };
    if ("_failedResponse" in state) state._failedResponse = message;
  }
  private async recoverOverflow(): Promise<{ continue: boolean } | undefined> {
    const overflow = this.overflow;
    this.overflow = undefined;
    const ctx = this.context;
    const host = this.host;
    if (!overflow || !ctx || !host || !this.active || this.startupError || !this.configuration.automatic) return;
    if (overflow.willRetry && this.overflowRecoveryAttempted) {
      report(ctx, overflow.kind === "length"
        ? "Truncated response recovery failed after one compact-and-retry attempt. Try /compact or reduce context."
        : "Context overflow recovery failed after one compact-and-retry attempt. Try /compact or reduce context.", "error");
      return;
    }
    const model = overflow.model ?? this.routed?.model ?? host.model ?? ctx.model;
    if (!model || !(model.contextWindow > 0)) return;
    // pi skips overflow recovery when the selection no longer matches the model
    // that produced the message; a larger model may not need compaction. Compare
    // the selection captured for this request, not the physical route: a virtual
    // router may legitimately choose another physical model for the continuation.
    const selection = host.model ?? ctx.model;
    if (selection && this.routed && (selection.provider !== this.routed.selection.provider || selection.id !== this.routed.selection.id)) return;
    let effective: Effective;
    try { effective = this.requestEffective(selection ?? model, model); } catch (error) { report(ctx, asError(error).message, "error"); return; }
    if (effective.invalid) {
      report(ctx, `Compactor: ${effective.invalid} Fix the configuration with /compactor.`, "error");
      return;
    }
    if (overflow.willRetry) {
      this.overflowRecoveryAttempted = true;
      try {
        this.omitAttempt(host, overflow.entryId, overflow.message);
      } catch (error) {
        report(ctx, asError(error).message, "error");
        return;
      }
    }
    const before = estimateProjection(host.sessionManager.buildSessionProjection(), host.sessionManager.getBranch());
    const started = Date.now();
    try {
      report(ctx, overflow.kind === "length"
        ? "Truncated response: compacting before retrying…"
        : overflow.kind === "silent"
          ? "Context overflow: compacting the completed response…"
          : "Context overflow: compacting before retrying…");
      const result = await compactToTarget(host, ctx, effective, before, undefined, model, overflow.thinkingLevel ?? host.thinkingLevel, "overflow", overflow.willRetry);
      if (result.after >= effective.triggerPoint) {
        const error = new Error("Compacted context is still at the trigger. Request paused; adjust settings or compact manually.");
        await this.diagnose(ctx, model, effective, before, started, { ok: false, phase: "post-check", error, result }, "overflow", overflow.willRetry);
        report(ctx, error.message, "error");
        return;
      }
      this.updateStatus(result.after);
      report(ctx, outcomeMessage(before, result.after, effective.target.tokens));
      await this.diagnose(ctx, model, effective, before, started, { ok: true, phase: "completed", result }, "overflow", overflow.willRetry);
      if (!overflow.willRetry) return;
      if (!this.canContinue(host)) {
        report(ctx, "Compacted context cannot continue the interrupted turn. Try /compact or send a new prompt.", "error");
        return;
      }
      this.markRetry(host, overflow.message);
      return { continue: true };
    } catch (error) {
      await this.diagnose(ctx, model, effective, before, started, { ok: false, phase: "attempt", error }, "overflow", overflow.willRetry);
      report(ctx, asError(error).message, "error");
      return;
    }
  }
  private async diagnose(
    ctx: ExtensionContext,
    model: { provider: string; id: string; contextWindow: number; maxTokens: number; reasoning?: boolean },
    effective: Effective,
    before: number,
    started: number,
    outcome: { ok: boolean; phase: CompactionAttempt["phase"]; result?: CompactionResult; error?: unknown },
    reason: CompactionReason = "threshold",
    willRetry = reason === "overflow",
  ): Promise<void> {
    const error = outcome.error === undefined ? undefined : asError(outcome.error);
    const details = error instanceof CompactionError ? error.details : undefined;
    await this.diagnostics.append({
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - started,
      ok: outcome.ok,
      phase: outcome.phase,
      reason,
      willRetry,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      repository: this.repository || undefined,
      model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: Boolean(model.reasoning) },
      trigger: effective.triggerPoint,
      target: effective.target.tokens,
      tokensBefore: before,
      tokensAfter: outcome.result?.after,
      attempts: outcome.result?.attempts ?? details?.attempts,
      summaryChars: outcome.result?.summaryChars ?? details?.summaryChars,
      stopReason: details?.stopReason,
      usage: outcome.result?.usage ?? details?.usage,
      error: error ? describeError(error) : undefined,
    });
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
    this.routed = undefined;
    this.overflow = undefined;
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
function describeError(error: Error): string {
  const cause = error.cause instanceof Error ? ` | cause: ${error.cause.name}: ${error.cause.message}` : "";
  return `${error.name}: ${error.message}${cause}`;
}
function paused(error: unknown): Error {
  // pi classifies retries by error-message text. Keep provider status/error
  // keywords in the separate notification so a failed summary is not retried.
  return new Error("Compactor paused the request. See the reported error; retry explicitly after resolving it.", { cause: error });
}

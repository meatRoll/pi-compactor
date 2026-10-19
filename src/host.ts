import { AgentSession, VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ExtensionContext deliberately exposes no Agent or SettingsManager. Isolate the
// pi 1.3 SDK bootstrap interception here; all per-session work uses public SDK APIs.
interface BridgeState {
  sessions: WeakMap<object, AgentSession>;
  count: number;
  bind: typeof AgentSession.prototype.bindExtensions;
  reload: typeof AgentSession.prototype.reload;
  wrappedBind?: typeof AgentSession.prototype.bindExtensions;
  wrappedReload?: typeof AgentSession.prototype.reload;
}
const symbol = Symbol.for("pi-compactor/sdk-bridge/v1");
const shared = globalThis as unknown as Record<symbol, BridgeState | undefined>;
export function installHostBridge(): { get(ctx: ExtensionContext): AgentSession; dispose(): void } {
  if (!/^1\.3\./.test(VERSION)) throw new Error(`pi-compactor's SDK adapter supports pi 1.3.x; found ${VERSION}.`);
  let state = shared[symbol];
  if (!state) {
    state = { sessions: new WeakMap(), count: 0, bind: AgentSession.prototype.bindExtensions, reload: AgentSession.prototype.reload };
    shared[symbol] = state;
  }
  const s = state;
  if (s.count++ === 0) {
    s.bind = AgentSession.prototype.bindExtensions;
    s.reload = AgentSession.prototype.reload;
    const bind = s.bind, reload = s.reload;
    s.wrappedBind = async function (this: AgentSession, ...args) { s.sessions.set(this.sessionManager, this); return bind.apply(this, args); };
    s.wrappedReload = async function (this: AgentSession, ...args) { s.sessions.set(this.sessionManager, this); return reload.apply(this, args); };
    AgentSession.prototype.bindExtensions = s.wrappedBind;
    AgentSession.prototype.reload = s.wrappedReload;
  }
  let disposed = false;
  return {
    get(ctx) {
      const host = s.sessions.get(ctx.sessionManager);
      if (!host) throw new Error("pi-compactor could not bind the pi SDK session. No compaction rules were applied.");
      return host;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--s.count === 0) {
        if (AgentSession.prototype.bindExtensions === s.wrappedBind) AgentSession.prototype.bindExtensions = s.bind;
        if (AgentSession.prototype.reload === s.wrappedReload) AgentSession.prototype.reload = s.reload;
      }
    },
  };
}

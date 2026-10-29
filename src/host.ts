import { AgentSession, VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ExtensionContext deliberately exposes no Agent or SettingsManager. pi 1.3 and 1.4
// reads active tools after loading extensions, even within an in-flight reload.
interface BridgeState {
  sessions: WeakMap<object, AgentSession>;
  count: number;
  activeTools: typeof AgentSession.prototype.getActiveToolNames;
  wrappedActiveTools?: typeof AgentSession.prototype.getActiveToolNames;
}
const symbol = Symbol.for("pi-compactor/sdk-bridge/v2");
const shared = globalThis as unknown as Record<symbol, BridgeState | undefined>;
export function installHostBridge(): { get(ctx: ExtensionContext): AgentSession; dispose(): void } {
  if (!/^1\.(3|4)\./.test(VERSION)) throw new Error(`pi-compactor's SDK adapter supports pi 1.3.x and 1.4.x; found ${VERSION}.`);
  let state = shared[symbol];
  if (!state) {
    state = { sessions: new WeakMap(), count: 0, activeTools: AgentSession.prototype.getActiveToolNames };
    shared[symbol] = state;
  }
  const s = state;
  if (s.count++ === 0) {
    s.activeTools = AgentSession.prototype.getActiveToolNames;
    const activeTools = s.activeTools;
    s.wrappedActiveTools = function (this: AgentSession, ...args) {
      s.sessions.set(this.sessionManager, this);
      return activeTools.apply(this, args);
    };
    AgentSession.prototype.getActiveToolNames = s.wrappedActiveTools;
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (--s.count === 0 && AgentSession.prototype.getActiveToolNames === s.wrappedActiveTools) {
      AgentSession.prototype.getActiveToolNames = s.activeTools;
    }
  }
  return {
    get(ctx) {
      const host = s.sessions.get(ctx.sessionManager);
      if (!host) throw new Error("pi-compactor could not bind the pi SDK session. No compaction rules were applied.");
      // Capturing is only bootstrap work. Keep no SDK wrapper active while the
      // session runs, including when the whole plugin is disabled.
      dispose();
      return host;
    },
    dispose,
  };
}

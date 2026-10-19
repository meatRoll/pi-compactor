import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyLayer, validateLayer, type Layer } from "./config.ts";
export const SESSION_SETTINGS = "pi-compactor/settings";
export function sessionSettings(entries: readonly SessionEntry[]): Layer {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === SESSION_SETTINGS) {
      validateLayer(entry.data);
      return structuredClone(entry.data);
    }
  }
  return emptyLayer();
}
export function saveSession(pi: ExtensionAPI, layer: Layer): void {
  validateLayer(layer);
  pi.appendEntry(SESSION_SETTINGS, structuredClone(layer));
}
export function currentSession(ctx: ExtensionContext): Layer { return sessionSettings(ctx.sessionManager.getEntries()); }

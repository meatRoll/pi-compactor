import { join } from "node:path";
import { atomicWrite, readOptional, withLock } from "./storage.ts";

export interface LifecycleState { version: 1; enabled: boolean; originalNativeEnabled: boolean | null }
export class Lifecycle {
  readonly path: string;
  readonly nativePath: string;
  readonly agentDir: string;
  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.path = join(agentDir, "compactor", "lifecycle.json");
    this.nativePath = join(agentDir, "settings.json");
  }
  async read(): Promise<LifecycleState | undefined> {
    const text = await readOptional(this.path);
    if (text === undefined) return undefined;
    const data = JSON.parse(text) as LifecycleState;
    if (data.version !== 1 || typeof data.enabled !== "boolean" || (data.originalNativeEnabled !== null && typeof data.originalNativeEnabled !== "boolean")) throw new Error("Invalid compactor lifecycle state; use the recovery CLI.");
    return data;
  }
  async acquire(): Promise<LifecycleState> {
    return withLock(this.path, async () => {
      let state = await this.read();
      await withLock(this.nativePath, async () => {
        const settings = JSON.parse(await readOptional(this.nativePath) ?? "{}");
        if (!state) {
          state = { version: 1, enabled: true, originalNativeEnabled: settings.compaction?.enabled ?? null };
          // Persist ownership before changing the native switch, so recovery retains its prior value.
          await atomicWrite(this.path, JSON.stringify(state, null, 2) + "\n");
        }
        settings.compaction = { ...settings.compaction, enabled: false };
        await atomicWrite(this.nativePath, JSON.stringify(settings, null, 2) + "\n");
      });
      return state!;
    });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    await withLock(this.path, async () => {
      const state = await this.read();
      if (!state) throw new Error("Compactor has not acquired native compaction.");
      await atomicWrite(this.path, JSON.stringify({ ...state, enabled }, null, 2) + "\n");
    });
  }
  async release(): Promise<void> {
    await withLock(this.path, async () => {
      const state = await this.read();
      if (!state) return;
      await withLock(this.nativePath, async () => {
        const settings = JSON.parse(await readOptional(this.nativePath) ?? "{}");
        if (state.originalNativeEnabled === null) {
          if (settings.compaction) delete settings.compaction.enabled;
        } else settings.compaction = { ...settings.compaction, enabled: state.originalNativeEnabled };
        await atomicWrite(this.nativePath, JSON.stringify(settings, null, 2) + "\n");
      });
      const { rm } = await import("node:fs/promises");
      await rm(this.path, { force: true });
    });
  }
}

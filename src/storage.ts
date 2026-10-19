import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { defaults, parseConfiguration, type Configuration } from "./config.ts";

const exec = promisify(execFile);
function isCode(error: unknown, code: string): boolean { return (error as NodeJS.ErrnoException)?.code === code; }
export async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
}
export async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  // Keep the directory empty so pi's proper-lockfile can reap a stale native
  // settings lock after a crash. PID metadata lives beside the directory.
  const ownerPath = `${lock}.owner`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30_000) {
          const owner = Number(await readOptional(ownerPath));
          let alive = false;
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); alive = true; } catch (e) { alive = !isCode(e, "ESRCH"); }
          }
          if (!alive) { await rm(lock, { recursive: true, force: true }); continue; }
        }
      } catch (e) { if (!isCode(e, "ENOENT")) throw e; }
      if (Date.now() >= deadline) throw new Error(`Configuration is locked by another process: ${path}`);
      await delay(20);
    }
  }
  try { await writeFile(ownerPath, String(process.pid), { mode: 0o600 }); return await action(); }
  finally { await rm(ownerPath, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
export class ConfigStore {
  readonly path: string;
  constructor(agentDir: string) { this.path = join(agentDir, "compactor", "settings.json"); }
  async load(): Promise<Configuration> {
    const text = await readOptional(this.path);
    return text === undefined ? defaults() : parseConfiguration(text);
  }
  async update(change: (latest: Configuration) => void): Promise<void> {
    await withLock(this.path, async () => {
      const latest = await this.load();
      change(latest);
      const text = JSON.stringify(latest, null, 2) + "\n";
      parseConfiguration(text);
      await atomicWrite(this.path, text);
    });
  }
  async reset(): Promise<Configuration> {
    return withLock(this.path, async () => {
      const configuration = defaults();
      await atomicWrite(this.path, JSON.stringify(configuration, null, 2) + "\n");
      return configuration;
    });
  }
}
export async function repositoryIdentity(cwd: string): Promise<string> {
  let canonical: string;
  try {
    const { stdout } = await exec("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5_000, maxBuffer: 64 * 1024 });
    canonical = await realpath(resolvePath(cwd, stdout.trim()));
  } catch {
    canonical = await realpath(cwd);
  }
  return createHash("sha256").update(canonical).digest("hex");
}

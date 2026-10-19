import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigStore, repositoryIdentity } from "../src/storage.ts";

test("concurrent field writes merge on disk while existing snapshots remain unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-store-"));
  try {
    const a = new ConfigStore(root); const b = new ConfigStore(root);
    const snapshot = await a.load();
    await Promise.all([
      a.update(c => { c.global.all.trigger = { unit: "tokens", value: 70_000 }; }),
      b.update(c => { c.preferences.basis = "left"; }),
    ]);
    const disk = await a.load();
    assert.equal(disk.global.all.trigger?.value, 70_000);
    assert.equal(disk.preferences.basis, "left");
    assert.equal(snapshot.global.all.trigger, undefined);
    assert.equal(snapshot.preferences.basis, "at");
    await writeFile(a.path, "invalid json");
    await assert.rejects(a.load());
    await assert.rejects(a.update(c => { c.automatic = false; }));
    assert.equal(await readFile(a.path, "utf8"), "invalid json");
    assert.equal((await a.reset()).automatic, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("repository identity is shared across subdirectories and worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-repo-"));
  const repo = join(root, "repo"); const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, "sub"), { recursive: true });
    const run = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    run("init"); run("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test");
    run("worktree", "add", "--detach", worktree);
    assert.equal(await repositoryIdentity(repo), await repositoryIdentity(join(repo, "sub")));
    assert.equal(await repositoryIdentity(repo), await repositoryIdentity(worktree));
    const plainA = join(root, "a"); const plainB = join(root, "b");
    await mkdir(plainA); await mkdir(plainB);
    assert.notEqual(await repositoryIdentity(plainA), await repositoryIdentity(plainB));
  } finally { await rm(root, { recursive: true, force: true }); }
});

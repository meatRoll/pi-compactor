import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiagnosticsLog, type CompactionAttempt } from "../src/diagnostics.ts";

function attempt(overrides: Partial<CompactionAttempt> = {}): CompactionAttempt {
  return {
    timestamp: "2026-10-30T12:57:23.955Z",
    durationMs: 60_270,
    ok: false,
    phase: "attempt",
    sessionId: "session-1",
    cwd: "/work",
    model: { provider: "meatroll", id: "model", contextWindow: 1_000_000, maxTokens: 8_192, reasoning: true },
    trigger: 300_000,
    target: 20_000,
    tokensBefore: 390_064,
    error: "Error: terminated",
    ...overrides,
  };
}

test("compaction attempts append as JSON lines with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-log-"));
  try {
    const log = new DiagnosticsLog(root);
    await log.append(attempt());
    await log.append(attempt({ ok: true, phase: "completed", tokensAfter: 18_500, summaryChars: 6_000, error: undefined }));
    const lines = (await readFile(log.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].phase, "attempt");
    assert.equal(lines[0].error, "Error: terminated");
    assert.equal(lines[1].ok, true);
    assert.equal(lines[1].tokensAfter, 18_500);
    assert.equal((await stat(log.path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the log rotates at the size limit and keeps appending", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-rotate-"));
  try {
    const log = new DiagnosticsLog(root, 100);
    await log.append(attempt());
    await log.append(attempt());
    const rotated = (await readFile(`${log.path}.1`, "utf8")).trim().split("\n");
    const current = (await readFile(log.path, "utf8")).trim().split("\n");
    assert.equal(rotated.length, 1);
    assert.equal(current.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostics never throw when the log path cannot be created", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-log-error-"));
  try {
    const blocker = join(root, "compactor");
    await writeFile(blocker, "");
    const log = new DiagnosticsLog(root);
    await log.append(attempt());
    assert.equal((await stat(blocker)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

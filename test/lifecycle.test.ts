import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { emptyLayer } from "../src/config.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { SESSION_SETTINGS, sessionSettings } from "../src/session.ts";

test("session settings persist independently of conversation compaction and copies do not alias", () => {
  const manager = SessionManager.inMemory(); const layer = emptyLayer();
  layer.all.trigger = { unit: "percent", value: 70 };
  manager.appendCustomEntry(SESSION_SETTINGS, layer);
  const original = sessionSettings(manager.getEntries());
  const copy = sessionSettings(manager.getEntries());
  copy.all.trigger!.value = 60;
  assert.equal(original.all.trigger?.value, 70);
  manager.appendCustomEntry(SESSION_SETTINGS, emptyLayer());
  assert.equal(sessionSettings(manager.getEntries()).all.trigger, undefined);
});

test("native automatic compaction stays masked while disabled; release restores prior behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-life-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ theme: "dark", compaction: { enabled: true, reserveTokens: 1234 } }));
    const life = new Lifecycle(root);
    assert.equal((await life.acquire()).originalNativeEnabled, true);
    await life.setEnabled(false);
    assert.equal((await life.acquire()).enabled, false);
    let settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.equal(settings.compaction.enabled, false);
    await life.release();
    settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    assert.equal(settings.compaction.enabled, true);
    assert.equal(settings.compaction.reserveTokens, 1234);
    assert.equal(settings.theme, "dark");
    assert.equal(await life.read(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("management helper runs directly under Node and restores the recorded native switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "compactor-helper-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
    const life = new Lifecycle(root); await life.acquire();
    const command = promisify(execFile);
    await command(process.execPath, [resolve("bin/manage.mjs"), "disable", "--agent-dir", root]);
    assert.equal((await life.read())?.enabled, false);
    await command(process.execPath, [resolve("bin/manage.mjs"), "enable", "--agent-dir", root]);
    assert.equal((await life.read())?.enabled, true);
    await command(process.execPath, [resolve("bin/manage.mjs"), "restore-native", "--agent-dir", root]);
    assert.equal(await life.read(), undefined);
    assert.equal(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).compaction.enabled, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native release restores an omitted switch or an originally disabled switch", async () => {
  for (const original of [undefined, false]) {
    const root = await mkdtemp(join(tmpdir(), "compactor-original-"));
    try {
      await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: original } }));
      const life = new Lifecycle(root);
      await life.acquire(); await life.release();
      const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
      assert.equal(settings.compaction.enabled, original);
      assert.equal(Object.hasOwn(settings.compaction, "enabled"), original !== undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

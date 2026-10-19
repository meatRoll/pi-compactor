import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { fixture } from "./fixture.ts";

test("installing into an already-bound session captures the host during the first reload", async () => {
  const originalTools = AgentSession.prototype.getActiveToolNames;
  const f = await fixture({ installOnReload: true });
  try {
    assert.equal(f.session.extensionRunner.getCommand("compactor"), undefined);
    assert.equal(f.session.autoCompactionEnabled, true);
    await f.install();
    assert.deepEqual(f.errors, []);
    assert.ok(f.session.extensionRunner.getCommand("compactor"));
    assert.equal(f.controller.host, f.session);
    assert.equal(f.controller.active, true);
    assert.equal(f.session.autoCompactionEnabled, false);
    assert.equal(AgentSession.prototype.getActiveToolNames, originalTools);
    f.seed(); await f.session.prompt("Continue after installing the plugin.");
    assert.deepEqual(f.calls.map(call => call.kind), ["summary", "chat"]);
    await f.session.reload();
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.host, f.session);
    assert.equal(AgentSession.prototype.getActiveToolNames, originalTools);
    await f.controller.disable();
    await f.session.reload();
    assert.deepEqual(f.errors, []);
    assert.equal(f.controller.active, false);
    assert.equal(f.session.autoCompactionEnabled, false);
    assert.equal(AgentSession.prototype.getActiveToolNames, originalTools);
  } finally { await f.close(); }
});

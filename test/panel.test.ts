import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AmountEditor } from "../src/panel.ts";
import { fixture } from "./fixture.ts";

test("editor distinguishes inheritance from being masked by a higher-priority scope", async () => {
  const f = await fixture();
  const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
  try {
    const sessionEditor = new AmountEditor(f.controller, "trigger", { scope: "session" }, f.session.model!, theme, "30000", () => {}, () => false, () => false);
    const inherited = sessionEditor.render(80).join("\n");
    assert.match(inherited, /EDITING SESSION/);
    assert.match(inherited, /Saved here: inherited/);
    assert.doesNotMatch(inherited, /currently overridden/);
    await f.controller.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 40_000 }, f.session.model!);
    const globalEditor = new AmountEditor(f.controller, "trigger", { scope: "global" }, f.session.model!, theme, "30000", () => {}, () => false, () => false);
    assert.match(globalEditor.render(80).join("\n"), /currently overridden by session/);
  } finally { await f.close(); }
});

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { AmountEditor, openPanel } from "../src/panel.ts";
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

test("panel has a single configuration entry and remembers the overview cell only until closed", async () => {
  initTheme("dark", false);
  const f = await fixture({ mode: "tui" });
  const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text } as Theme;
  try {
    await f.controller.edit({ scope: "session" }, "trigger", { unit: "tokens", value: 40_000 }, f.session.model!);
    const ctx = f.session.extensionRunner.createCommandContext();
    const original = ctx.ui.custom;
    const screens: string[] = [];
    const steps = [
      ["\r"], // Main panel -> overview.
      ["\x1b[A", "\x1b[C", "\x1b"], // Session trigger -> repository/model target -> main.
      ["\r"],
      ["e"], // Reopening must edit the remembered repository/model target.
      ["\x1b"], // Close editor without saving.
      ["\x1b"], // Return to main.
      ["\x1b"], // Close panel.
      ["\r"], // New interaction -> overview at the effective trigger again.
      ["\x1b"],
      ["\x1b"],
    ];
    let step = 0;
    const keyActions: Record<string, string> = { "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.editor.cursorLeft": "\x1b[D", "tui.editor.cursorRight": "\x1b[C", "tui.select.cancel": "\x1b", "tui.select.confirm": "\r" };
    ctx.ui.custom = (async (factory: any) => new Promise(resolve => {
      const component = factory({ requestRender() {} }, theme, { matches: (data: string, action: string) => keyActions[action] === data }, resolve);
      screens.push(component.render(120).join("\n"));
      const input = steps[step++];
      assert.ok(input, "Unexpected extra UI screen");
      for (const key of input) component.handleInput(key);
    })) as typeof ctx.ui.custom;
    try { await openPanel(f.controller, ctx); await openPanel(f.controller, ctx); }
    finally { ctx.ui.custom = original; }
    assert.match(screens[0]!, /Configuration overview/);
    assert.doesNotMatch(screens[0]!, /Trigger:|Result target:/);
    assert.match(screens[1]!, /Selected: Session \/ all models · Trigger/);
    assert.match(screens[3]!, /Selected: Repository \/ selected model · Result target/);
    assert.match(screens[4]!, /EDITING REPOSITORY \/ compactor-test\/model/);
    assert.match(screens[4]!, /Compacted context target/);
    assert.match(screens[8]!, /Selected: Session \/ all models · Trigger/);
    assert.equal(step, steps.length);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

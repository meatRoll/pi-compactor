import assert from "node:assert/strict";
import test from "node:test";
import { defaults, emptyLayer, footer, MIN_TRIGGER, modelKey, parseAmount, parseConfiguration, resolve, setField } from "../src/config.ts";

const model = { provider: "provider", id: "model", contextWindow: 200_000 };
const amount = (value: number) => ({ unit: "tokens" as const, value });

test("six-level precedence is scope-first, with independent field inheritance and clearing", () => {
  const c = defaults(); const session = emptyLayer(); const key = modelKey(model);
  c.global.all = { trigger: amount(100_000), target: amount(30_000) };
  c.global.models[key] = { trigger: amount(110_000) };
  c.repositories.repo = emptyLayer(); c.repositories.repo.all.trigger = amount(120_000);
  assert.equal(resolve(c, "repo", session, model).trigger.tokens, 120_000);
  c.repositories.repo.models[key] = { trigger: amount(130_000) };
  session.all.trigger = amount(140_000);
  assert.equal(resolve(c, "repo", session, model).trigger.tokens, 140_000);
  session.models[key] = { trigger: amount(150_000) };
  let result = resolve(c, "repo", session, model);
  assert.equal(result.trigger.tokens, 150_000);
  assert.equal(result.target.tokens, 30_000);
  assert.equal(result.target.source?.scope, "global");
  setField(session, { scope: "session", model: key }, "trigger");
  assert.equal(resolve(c, "repo", session, model).trigger.tokens, 140_000);
  setField(session, { scope: "session" }, "trigger");
  assert.equal(resolve(c, "repo", session, model).trigger.tokens, 130_000);
});

test("defaults, provider isolation, fixed minimum and oversized thresholds", () => {
  const c = defaults(); const s = emptyLayer();
  assert.equal(resolve(c, "r", s, model).trigger.tokens, 160_000);
  assert.equal(resolve(c, "r", s, model).target.tokens, 20_000);
  c.global.models[modelKey(model)] = { trigger: amount(300_000) };
  const oversized = resolve(c, "r", s, model);
  assert.equal(oversized.triggerPoint, 300_000);
  assert.match(oversized.warning!, /cannot be reached/);
  assert.equal(resolve(c, "r", s, { ...model, provider: "other" }).trigger.tokens, 160_000);
  c.global.all = { trigger: amount(1_000), target: amount(500) };
  assert.equal(resolve(c, "r", s, { ...model, provider: "other" }).triggerPoint, MIN_TRIGGER);
});

test("reject invalid target combinations without mutating settings", () => {
  const c = defaults(); c.global.all = { trigger: amount(30_000), target: amount(40_000) };
  assert.match(resolve(c, "r", emptyLayer(), model).invalid!, /must be below/);
  assert.equal(c.global.all.trigger?.value, 30_000);
  c.global.all.target = amount(30_000);
  assert.ok(resolve(c, "r", emptyLayer(), model).invalid);
});

test("token/percentage input and corrupt configurations", () => {
  assert.deepEqual(parseAmount("30k"), amount(30_000));
  assert.deepEqual(parseAmount("1.5M"), amount(1_500_000));
  assert.deepEqual(parseAmount("80%"), { unit: "percent", value: 80 });
  for (const input of ["0", "-5", "1.5", "NaN", "1e20", "x"]) assert.throws(() => parseAmount(input));
  assert.throws(() => parseConfiguration('{"version":2}'));
  const c = defaults(); c.global.all = { trigger: amount(-1) };
  assert.throws(() => parseConfiguration(JSON.stringify(c)));
});

test("all four footer formats are display-only; off/hidden/abnormal states", () => {
  const c = defaults(); const original = resolve(c, "r", emptyLayer(), model);
  assert.equal(footer(c, original, model.contextWindow, 0)?.text, "Compact at 80%");
  c.preferences.unit = "tokens";
  assert.equal(footer(c, original, model.contextWindow, 0)?.text, "Compact at 160k");
  c.preferences.basis = "left";
  assert.equal(footer(c, original, model.contextWindow, 0)?.text, "Compact left 40k");
  c.preferences.unit = "percent";
  assert.equal(footer(c, original, model.contextWindow, 0)?.text, "Compact left 20%");
  assert.deepEqual(resolve(c, "r", emptyLayer(), model), original);
  assert.equal(footer(c, original, model.contextWindow, 160_000)?.color, "#ef4444");
  c.global.all.trigger = amount(300_000);
  assert.equal(footer(c, resolve(c, "r", emptyLayer(), model), model.contextWindow, 0)?.color, "#c084fc");
  c.automatic = false;
  assert.equal(footer(c, original, model.contextWindow, 0)?.text, "Compact off");
  c.preferences.visible = false;
  assert.equal(footer(c, original, model.contextWindow, 0), undefined);
});

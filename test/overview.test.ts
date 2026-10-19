import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaults, emptyLayer, modelKey } from "../src/config.ts";
import { buildOverview, ConfigurationOverview, type OverviewAction, type OverviewCursor } from "../src/overview.ts";

const model = { provider: "provider-a", id: "shared-model", contextWindow: 200_000 };
const theme = { fg: (_token: unknown, text: string) => text, bold: (text: string) => text } as Theme;
function configured() {
  const configuration = defaults(), session = emptyLayer();
  configuration.global.all = { trigger: { unit: "percent", value: 80 }, target: { unit: "tokens", value: 20_000 } };
  configuration.global.models[modelKey(model)] = { trigger: { unit: "percent", value: 75 } };
  configuration.repositories.repo = { all: { target: { unit: "tokens", value: 30_000 } }, models: { [modelKey(model)]: { trigger: { unit: "percent", value: 70 } } } };
  session.all.trigger = { unit: "percent", value: 60 };
  session.models[modelKey(model)] = { target: { unit: "tokens", value: 10_000 } };
  return { configuration, session };
}

test("overview lists all six raw scopes and identifies the two effective fields independently", () => {
  const { configuration, session } = configured();
  const view = buildOverview(configuration, "repo", session, model);
  assert.deepEqual(view.rows.map(row => [row.selection.scope, row.selection.model]), [
    ["global", undefined], ["global", modelKey(model)], ["repository", undefined], ["repository", modelKey(model)], ["session", undefined], ["session", modelKey(model)],
  ]);
  assert.deepEqual(view.rows.map(row => row.trigger.state), ["overridden", "overridden", "inherited", "overridden", "effective", "inherited"]);
  assert.deepEqual(view.rows.map(row => row.target.state), ["overridden", "inherited", "overridden", "inherited", "inherited", "effective"]);
  assert.equal(view.rows[0]!.trigger.amount?.value, 80);
  assert.equal(view.rows[2]!.trigger.amount, undefined);
  assert.equal(view.effective.triggerPoint, 120_000);
  assert.equal(view.effective.target.tokens, 10_000);
  configuration.global.models["provider-b/shared-model"] = { trigger: { unit: "percent", value: 25 } };
  const other = buildOverview(configuration, "repo", session, { ...model, provider: "provider-b" });
  assert.equal(other.rows[1]!.trigger.amount?.value, 25);
  assert.equal(other.rows[3]!.trigger.amount, undefined);
  assert.equal(other.rows[5]!.target.amount, undefined);
  assert.equal(other.effective.target.tokens, 30_000);
});

test("overview separates inherited defaults, intermediate conflicts, and the effective conflict", () => {
  const configuration = defaults(), session = emptyLayer();
  const inherited = buildOverview(configuration, "repo", session, model);
  assert.ok(inherited.rows.every(row => row.trigger.state === "inherited" && row.target.state === "inherited"));
  assert.equal(inherited.effective.trigger.source, null);
  assert.equal(inherited.effective.triggerPoint, 160_000);
  configuration.global.all = { trigger: { unit: "tokens", value: 30_000 }, target: { unit: "tokens", value: 20_000 } };
  configuration.repositories.repo = { all: { target: { unit: "tokens", value: 35_000 } }, models: {} };
  session.all.target = { unit: "tokens", value: 10_000 };
  const repaired = buildOverview(configuration, "repo", session, model);
  assert.match(repaired.rows[2]!.target.conflict!, /must be below/);
  assert.equal(repaired.rows[2]!.target.state, "overridden");
  assert.equal(repaired.effective.invalid, undefined);
  delete session.all.target;
  const invalid = buildOverview(configuration, "repo", session, model);
  assert.match(invalid.effective.invalid!, /must be below/);
  assert.equal(invalid.rows[2]!.target.state, "effective");
});

test("overview navigation and Enter are read only; editing explicitly targets the selected scope and field", () => {
  const { configuration, session } = configured();
  const before = JSON.stringify({ configuration, session });
  const actions: OverviewAction[] = [], cursor: OverviewCursor = { row: 0, field: "trigger" };
  const keys = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", cancel: "\x1b" };
  const component = new ConfigurationOverview(() => buildOverview(configuration, "repo", session, model), model, theme, cursor, action => actions.push(action), (data, action) => data === keys[action]);
  for (let i = 0; i < 4; i++) component.handleInput(keys.down);
  component.handleInput(keys.right);
  component.handleInput("\r");
  assert.deepEqual(actions, []);
  const screen = component.render(100).join("\n");
  assert.match(screen, /Configuration overview — read only/);
  assert.match(screen, /Session \/ all models · Result target/);
  assert.match(screen, /Saved here: inherited/);
  assert.match(screen, /Instance snapshot/);
  component.handleInput("e");
  assert.deepEqual(actions.pop(), { kind: "edit", selection: { scope: "session", model: undefined }, field: "target" });
  component.handleInput("\x0f");
  assert.deepEqual(actions.pop(), { kind: "model" });
  component.handleInput(keys.cancel);
  assert.deepEqual(actions.pop(), { kind: "close" });
  assert.equal(JSON.stringify({ configuration, session }), before);
});

test("overview preserves column bounds for narrow terminals and wide model identifiers", () => {
  const wideModel = { ...model, id: "模型🚀/long-model-identifier" };
  const configuration = defaults(), session = emptyLayer();
  const component = new ConfigurationOverview(() => buildOverview(configuration, "repo", session, wideModel), wideModel, theme, { row: 0, field: "trigger" }, () => {}, () => false);
  for (const width of [120, 80, 60, 40, 20, 1, 0]) {
    const lines = component.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `Overflow at width ${width}`);
    assert.equal(lines.filter(line => line.includes(" / all") || line.includes(" / model") || line.includes(" / selected")).length >= 6, width >= 40);
  }
});

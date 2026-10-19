import { getSelectListTheme, ModelSelectorComponent, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, SelectList, Text, type Component, type Focusable } from "@earendil-works/pi-tui";
import { formatAmount, formatTokens, getLayer, getRule, modelKey, parseAmount, sourceLabel, type Field, type ModelIdentity, type Selection } from "./config.ts";
import { asError, Compactor } from "./controller.ts";
import { report } from "./compaction.ts";

type EditorAction = { kind: "value"; text: string } | { kind: "scope" } | { kind: "model" } | { kind: "clear" } | { kind: "close" };
export function impact(selection: Selection): string {
  const scope = selection.scope === "global" ? "All repositories and sessions" : selection.scope === "repository" ? "All sessions in this repository (including worktrees)" : "This session only";
  return `${scope}; ${selection.model ? "selected model only" : "all models"}. Higher-priority overrides still apply.`;
}
export class AmountEditor implements Component, Focusable {
  readonly input = new Input();
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(readonly controller: Compactor, readonly field: Field, readonly selection: Selection, readonly model: ModelIdentity, readonly theme: Theme, text: string, readonly done: (action: EditorAction) => void, readonly confirm: (data: string) => boolean, readonly cancel: (data: string) => boolean) { this.input.handleInput(text); }
  render(width: number): string[] {
    const c = this.controller;
    const effective = c.effective(this.model);
    const own = getRule(getLayer(c.configuration, c.session, c.repository, this.selection.scope), this.selection.model)[this.field];
    const source = effective[this.field].source;
    const priority = (scope: Selection) => ({ global: 0, repository: 2, session: 4 })[scope.scope] + (scope.model ? 1 : 0);
    const masked = source && priority(source) > priority(this.selection);
    const container = new Container();
    container.addChild(new Text(this.theme.fg("accent", this.theme.bold(`Compactor — ${this.field === "trigger" ? "Trigger threshold" : "Compacted context target"}`)), 0, 0));
    container.addChild(new Text(this.theme.fg(this.selection.scope === "session" ? "accent" : "warning", this.theme.bold(`EDITING ${this.selection.scope.toUpperCase()} / ${this.selection.model ?? "ALL MODELS"}`)), 0, 1));
    container.addChild(new Text(impact(this.selection), 0, 0));
    container.addChild(new Text(`Preview: ${modelKey(this.model)} (${formatTokens(this.model.contextWindow)} context)`, 0, 0));
    container.addChild(new Text(`Saved here: ${own ? formatAmount(own) : "inherited"}\nEffective: ${formatAmount(effective[this.field].amount)} (${formatTokens(effective[this.field].tokens)}) — ${sourceLabel(effective[this.field].source)}`, 0, 1));
    if (masked) container.addChild(new Text(this.theme.fg("warning", `This scope is currently overridden by ${sourceLabel(effective[this.field].source)}.`), 0, 0));
    container.addChild(this.input);
    container.addChild(new Text(this.theme.fg("dim", "Enter a token count (20000, 20k) or percentage (80%).\nEnter: apply immediately · Esc: close · Ctrl+L: level\nCtrl+O: all/single model (search) · Ctrl+R: clear override"), 0, 1));
    return container.render(width);
  }
  invalidate() { this.input.invalidate(); }
  handleInput(data: string): void {
    if (this.cancel(data)) this.done({ kind: "close" });
    else if (this.confirm(data)) this.done({ kind: "value", text: this.input.getValue() });
    else if (matchesKey(data, Key.ctrl("l"))) this.done({ kind: "scope" });
    else if (matchesKey(data, Key.ctrl("o"))) this.done({ kind: "model" });
    else if (matchesKey(data, Key.ctrl("r"))) this.done({ kind: "clear" });
    else this.input.handleInput(data);
  }
}
async function chooseModel(c: Compactor, ctx: ExtensionCommandContext, selected = ctx.model) {
  return ctx.ui.custom<typeof selected>((tui, _theme, _keys, done) => new ModelSelectorComponent(tui, selected, c.host!.modelRuntime, ctx.scopedModels, model => done(model), () => done(undefined)));
}
async function editField(c: Compactor, ctx: ExtensionCommandContext, field: Field, initialModel: NonNullable<ExtensionCommandContext["model"]>): Promise<void> {
  let model = initialModel;
  let selection: Selection = { ...(c.effective(model)[field].source ?? { scope: "global" as const }) };
  const loadValue = () => {
    const own = getRule(getLayer(c.configuration, c.session, c.repository, selection.scope), selection.model)[field];
    const amount = own ?? c.effective(model)[field].amount;
    return amount.unit === "percent" ? `${amount.value}%` : String(amount.value);
  };
  let text = loadValue();
  for (;;) {
    const action = await ctx.ui.custom<EditorAction>((tui, theme, keys, done) => {
      const editor = new AmountEditor(c, field, selection, model, theme, text, done, data => keys.matches(data, "tui.select.confirm"), data => keys.matches(data, "tui.select.cancel"));
      return { get focused() { return editor.focused; }, set focused(value: boolean) { editor.focused = value; }, render: width => editor.render(width), invalidate: () => editor.invalidate(), handleInput: data => { editor.handleInput(data); tui.requestRender(); } };
    });
    if (action.kind === "close") return;
    if (action.kind === "scope") {
      const level = await ctx.ui.select("Editing level — changes apply immediately when entered", ["Global", "Current repository", "Current session"]);
      if (level) selection = { ...selection, scope: level === "Global" ? "global" : level === "Current repository" ? "repository" : "session" };
      text = loadValue();
    } else if (action.kind === "model") {
      const scope = await ctx.ui.select("Model scope", ["All models", "Choose a model…"]);
      if (scope === "All models") selection = { scope: selection.scope };
      else if (scope) {
        const selected = await chooseModel(c, ctx, model);
        if (selected) { model = selected; selection = { scope: selection.scope, model: modelKey(model) }; }
      }
      text = loadValue();
    } else {
      try {
        const value = action.kind === "clear" || !action.text.trim() ? undefined : parseAmount(action.text);
        await c.edit(selection, field, value, model);
        return;
      } catch (error) {
        report(ctx, asError(error).message, "error");
        if (action.kind === "value") text = action.text;
      }
    }
  }
}
export async function openPanel(c: Compactor, ctx: ExtensionCommandContext): Promise<void> {
  if (!c.active) { report(ctx, "Compactor is disabled. Use /compactor enable to re-enable it.", "warning"); return; }
  if (ctx.mode !== "tui") throw new Error("/compactor's panel requires the pi TUI. Saved rules still apply in this mode.");
  let model = ctx.model;
  if (!model) model = await chooseModel(c, ctx);
  if (!model) return;
  let last = "trigger";
  while (c.active) {
    const effective = c.effective(model);
    const p = c.configuration.preferences;
    const items = [
      { value: "trigger", label: `Trigger: ${formatAmount(effective.trigger.amount)} → ${formatTokens(effective.triggerPoint)}`, description: sourceLabel(effective.trigger.source) },
      { value: "target", label: `Result target: ${formatAmount(effective.target.amount)}`, description: sourceLabel(effective.target.source) },
      { value: "automatic", label: `Automatic compaction: ${c.configuration.automatic ? "On" : "Off"}` },
      { value: "visible", label: `Footer status: ${p.visible ? "On" : "Off"}` },
      { value: "basis", label: `Footer basis: ${p.basis === "at" ? "At threshold" : "Remaining threshold"}` },
      { value: "unit", label: `Footer unit: ${p.unit === "percent" ? "Percentage" : "Tokens"}` },
      { value: "colors", label: `Footer colors: ${p.colors}` },
      { value: "disable", label: "Disable plugin", description: "Native automatic compaction remains off" },
      { value: "uninstall", label: "Uninstall plugin…", description: "Remove package and restore native compaction" },
      { value: "close", label: "Close" },
    ];
    const chosen = await ctx.ui.custom<string>((tui, theme, _keys, done) => {
      const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
      list.setSelectedIndex(Math.max(0, items.findIndex(item => item.value === last)));
      list.onSelect = item => done(item.value);
      list.onCancel = () => done("close");
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Compactor")), 0, 0));
      container.addChild(new Text(`${modelKey(model!)} · ${formatTokens(model!.contextWindow)} context\nFixed minimum trigger: 20k · Edits apply immediately`, 0, 1));
      if (effective.invalid || effective.warning) container.addChild(new Text(theme.fg("warning", [effective.invalid, effective.warning].filter(Boolean).join("\n")), 0, 1));
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑/↓: select · Enter: edit/toggle · Esc: close"), 0, 1));
      return { render: width => container.render(width), invalidate: () => container.invalidate(), handleInput: data => { list.handleInput(data); tui.requestRender(); } };
    });
    last = chosen;
    try {
      if (chosen === "close") return;
      if (chosen === "trigger" || chosen === "target") await editField(c, ctx, chosen, model);
      else if (chosen === "automatic") await c.automatic(!c.configuration.automatic);
      else if (chosen === "visible") await c.preference("visible", !p.visible);
      else if (chosen === "basis") await c.preference("basis", p.basis === "at" ? "left" : "at");
      else if (chosen === "unit") await c.preference("unit", p.unit === "percent" ? "tokens" : "percent");
      else if (chosen === "colors") await c.preference("colors", p.colors === "classic" ? "contrast" : "classic");
      else if (chosen === "disable") { await c.disable(); report(ctx, "Compactor disabled until /compactor enable. Native automatic compaction remains off."); }
      else if (chosen === "uninstall" && await ctx.ui.confirm("Uninstall Compactor?", "Remove this package and restore pi's original native automatic-compaction setting?")) { await c.uninstall(ctx); return; }
    } catch (error) { report(ctx, asError(error).message, "error"); }
  }
}

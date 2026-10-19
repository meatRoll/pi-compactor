import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { defaults, emptyLayer, formatAmount, formatTokens, getLayer, getRule, modelKey, resolve, setField, tokens, type Amount, type Configuration, type Effective, type Field, type Layer, type ModelIdentity, type Selection } from "./config.ts";

export interface OverviewCell {
  amount?: Amount;
  state: "inherited" | "effective" | "overridden";
  conflict?: string;
}
export interface OverviewRow {
  selection: Selection;
  trigger: OverviewCell;
  target: OverviewCell;
  atLevel: Effective;
}
export interface OverviewData { rows: OverviewRow[]; effective: Effective }
export interface OverviewCursor { row: number; field: Field }
export type OverviewAction = { kind: "edit"; selection: Selection; field: Field } | { kind: "model" } | { kind: "close" };
export const levelLabel = (selection: Selection | null): string => selection ? `${selection.scope === "global" ? "Global" : selection.scope === "repository" ? "Repository" : "Session"} / ${selection.model ? "selected model" : "all models"}` : "Built-in defaults";

export function buildOverview(configuration: Configuration, repository: string, session: Layer, model: ModelIdentity): OverviewData {
  const effective = resolve(configuration, repository, session, model);
  const prefix = defaults(), prefixSession = emptyLayer();
  prefix.repositories[repository] = emptyLayer();
  const rows: OverviewRow[] = [];
  for (const scope of ["global", "repository", "session"] as const) {
    for (const key of [undefined, modelKey(model)]) {
      const selection: Selection = { scope, model: key };
      const rule = getRule(getLayer(configuration, session, repository, scope), key);
      for (const field of ["trigger", "target"] as const) setField(getLayer(prefix, prefixSession, repository, scope), selection, field, rule[field]);
      const atLevel = resolve(prefix, repository, prefixSession, model);
      const cell = (field: Field): OverviewCell => {
        const amount = rule[field], source = effective[field].source;
        return {
          amount,
          state: !amount ? "inherited" : source?.scope === scope && source.model === key ? "effective" : "overridden",
          conflict: amount ? atLevel.invalid : undefined,
        };
      };
      rows.push({ selection, trigger: cell("trigger"), target: cell("target"), atLevel });
    }
  }
  return { rows, effective };
}

export class ConfigurationOverview implements Component {
  constructor(readonly data: () => OverviewData, readonly model: ModelIdentity, readonly theme: Theme, readonly cursor: OverviewCursor, readonly done: (action: OverviewAction) => void, readonly matches: (data: string, action: "up" | "down" | "left" | "right" | "cancel") => boolean) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (this.matches(data, "cancel")) this.done({ kind: "close" });
    else if (this.matches(data, "up")) this.cursor.row = Math.max(0, this.cursor.row - 1);
    else if (this.matches(data, "down")) this.cursor.row = Math.min(5, this.cursor.row + 1);
    else if (this.matches(data, "left")) this.cursor.field = "trigger";
    else if (this.matches(data, "right")) this.cursor.field = "target";
    else if (matchesKey(data, Key.ctrl("o"))) this.done({ kind: "model" });
    else if (matchesKey(data, "e") || matchesKey(data, "shift+e")) {
      this.done({ kind: "edit", selection: { ...this.data().rows[this.cursor.row]!.selection }, field: this.cursor.field });
    }
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const { rows, effective } = this.data();
    const narrow = width < 76;
    const labelWidth = narrow ? Math.max(6, Math.floor(width * 0.35)) : 28;
    const triggerWidth = Math.max(1, Math.floor((width - labelWidth - 6) / 2));
    const targetWidth = Math.max(1, width - labelWidth - triggerWidth - 6);
    const pad = (text: string, size: number) => {
      const clipped = truncateToWidth(text, size);
      return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
    };
    const formatCell = (cell: OverviewCell, selected: boolean, size: number) => {
      const marker = cell.state === "effective" ? " ✓" : cell.state === "overridden" ? " ~" : "";
      let text = cell.amount ? `${formatAmount(cell.amount)}${marker}${cell.conflict ? " !" : ""}` : "—";
      if (selected) text = `[${text}]`;
      const styled = this.theme.fg(cell.conflict ? "error" : cell.state === "effective" ? "success" : "dim", pad(text, size));
      return selected ? this.theme.bold(styled) : styled;
    };
    const lines = [
      this.theme.fg("accent", this.theme.bold("Configuration overview — read only")),
      `Preview: ${modelKey(this.model)} · ${formatTokens(this.model.contextWindow)} context`,
      `  ${pad("Configuration layer", labelWidth)}  ${pad("Trigger", triggerWidth)}  ${pad("Result target", targetWidth)}`,
    ];
    rows.forEach((row, index) => {
      const selected = index === this.cursor.row;
      const label = narrow ? `${row.selection.scope === "repository" ? "Repo" : row.selection.scope === "global" ? "Global" : "Session"} / ${row.selection.model ? "model" : "all"}` : levelLabel(row.selection);
      lines.push(`${selected ? this.theme.fg("accent", "> ") : "  "}${pad(label, labelWidth)}  ${formatCell(row.trigger, selected && this.cursor.field === "trigger", triggerWidth)}  ${formatCell(row.target, selected && this.cursor.field === "target", targetWidth)}`);
    });
    const selectedRow = rows[this.cursor.row]!, selectedCell = selectedRow[this.cursor.field];
    const raw = selectedCell.amount;
    const exact = !raw ? "inherited" : raw.unit === "tokens" ? `${raw.value.toLocaleString("en-US")} tokens` : `${raw.value}% (${tokens(raw, this.model.contextWindow).toLocaleString("en-US")} tokens)`;
    const state = selectedCell.state === "overridden" ? `overridden by ${levelLabel(effective[this.cursor.field].source)}` : selectedCell.state === "effective" ? "effective" : "no override here";
    lines.push(
      this.theme.fg("dim", "— inherits · ✓ effective · ~ overridden · ! conflict at this level"),
      `Effective trigger: ${formatAmount(effective.trigger.amount)} → ${formatTokens(effective.triggerPoint)} — ${levelLabel(effective.trigger.source)}`,
      `Effective target: ${formatAmount(effective.target.amount)} → ${formatTokens(effective.target.tokens)} — ${levelLabel(effective.target.source)}`,
      "Built-in defaults: trigger 80% / target 20k · Fixed minimum: 20k",
      this.theme.fg("accent", `Selected: ${levelLabel(selectedRow.selection)} · ${this.cursor.field === "trigger" ? "Trigger" : "Result target"}`),
      `Saved here: ${exact} · ${state}`,
    );
    if (selectedRow.atLevel.invalid) lines.push(this.theme.fg("error", `At this level: ${selectedRow.atLevel.invalid}`));
    if (effective.invalid) lines.push(this.theme.fg("error", `Effective conflict: ${effective.invalid}`));
    if (effective.warning) lines.push(this.theme.fg("warning", effective.warning));
    lines.push(
      this.theme.fg("dim", "Instance snapshot · Own edits apply now; external edits need /reload"),
      this.theme.fg("dim", "↑/↓: level · ←/→: field · E: edit selected field"),
      this.theme.fg("dim", "Ctrl+O: search model · Esc: return · Viewing does not save changes"),
    );
    return lines.map(line => truncateToWidth(line, Math.max(1, width)));
  }
}

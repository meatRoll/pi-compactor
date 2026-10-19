export const MIN_TRIGGER = 20_000;
export type Amount = { unit: "tokens" | "percent"; value: number };
export type Field = "trigger" | "target";
export type Rule = Partial<Record<Field, Amount>>;
export interface Layer { all: Rule; models: Record<string, Rule> }
export interface Preferences {
  visible: boolean;
  basis: "at" | "left";
  unit: "tokens" | "percent";
  colors: "classic" | "contrast";
}
export interface Configuration {
  version: 1;
  automatic: boolean;
  preferences: Preferences;
  global: Layer;
  repositories: Record<string, Layer>;
}
export interface ModelIdentity { provider: string; id: string; contextWindow: number }
export type Scope = "global" | "repository" | "session";
export interface Selection { scope: Scope; model?: string }
export interface EffectiveField { amount: Amount; tokens: number; source: Selection | null }
export interface Effective {
  trigger: EffectiveField;
  target: EffectiveField;
  triggerPoint: number;
  invalid?: string;
  warning?: string;
}
export const emptyLayer = (): Layer => ({ all: {}, models: Object.create(null) as Record<string, Rule> });
export function defaults(): Configuration {
  return { version: 1, automatic: true, preferences: { visible: true, basis: "at", unit: "percent", colors: "classic" }, global: emptyLayer(), repositories: Object.create(null) as Record<string, Layer> };
}
export const modelKey = (model: Pick<ModelIdentity, "provider" | "id">): string => `${model.provider}/${model.id}`;
export function tokens(amount: Amount, contextWindow: number): number {
  return amount.unit === "tokens" ? amount.value : Math.ceil(contextWindow * amount.value / 100);
}
export function validateAmount(value: unknown): asserts value is Amount {
  const a = value as Amount | null;
  if (!a || !["tokens", "percent"].includes(a.unit) || !Number.isFinite(a.value) || a.value <= 0 ||
      (a.unit === "tokens" && !Number.isSafeInteger(a.value))) {
    throw new Error("Enter a positive token integer or percentage.");
  }
}
function validateRule(value: unknown): asserts value is Rule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid rule.");
  for (const [key, amount] of Object.entries(value)) {
    if (key !== "trigger" && key !== "target") throw new Error(`Unknown rule field: ${key}`);
    validateAmount(amount);
  }
}
export function validateLayer(value: unknown): asserts value is Layer {
  const layer = value as Layer | null;
  if (!layer || typeof layer !== "object" || !layer.models || typeof layer.models !== "object" || Array.isArray(layer.models)) throw new Error("Invalid configuration layer.");
  validateRule(layer.all);
  for (const rule of Object.values(layer.models)) validateRule(rule);
}
export function parseConfiguration(text: string): Configuration {
  const c = JSON.parse(text) as Configuration;
  if (!c || c.version !== 1 || typeof c.automatic !== "boolean" || !c.repositories || typeof c.repositories !== "object" || Array.isArray(c.repositories)) throw new Error("Invalid or unsupported compactor configuration.");
  validateLayer(c.global);
  for (const layer of Object.values(c.repositories)) validateLayer(layer);
  const p = c.preferences;
  if (!p || typeof p.visible !== "boolean" || !["at", "left"].includes(p.basis) || !["tokens", "percent"].includes(p.unit) || !["classic", "contrast"].includes(p.colors)) throw new Error("Invalid display preferences.");
  return c;
}
export function getLayer(c: Configuration, session: Layer, repository: string, scope: Scope): Layer {
  if (scope === "session") return session;
  if (scope === "global") return c.global;
  return c.repositories[repository] ?? emptyLayer();
}
export function getRule(layer: Layer, model?: string): Rule {
  return model ? (Object.hasOwn(layer.models, model) ? layer.models[model]! : {}) : layer.all;
}
export function setField(layer: Layer, selection: Selection, field: Field, value?: Amount): void {
  let rule = layer.all;
  if (selection.model) {
    if (!Object.hasOwn(layer.models, selection.model)) Object.defineProperty(layer.models, selection.model, { value: {}, writable: true, enumerable: true, configurable: true });
    rule = layer.models[selection.model]!;
  }
  if (value) rule[field] = value;
  else delete rule[field];
  if (selection.model && !Object.keys(rule).length) delete layer.models[selection.model];
}
export function resolve(c: Configuration, repository: string, session: Layer, model: ModelIdentity): Effective {
  const fields: Record<Field, { amount: Amount; source: Selection | null }> = {
    trigger: { amount: { unit: "percent", value: 80 }, source: null },
    target: { amount: { unit: "tokens", value: 20_000 }, source: null },
  };
  for (const scope of ["global", "repository", "session"] as const) {
    const layer = getLayer(c, session, repository, scope);
    for (const key of [undefined, modelKey(model)]) {
      const rule = getRule(layer, key);
      for (const field of ["trigger", "target"] as const) {
        if (rule[field]) fields[field] = { amount: rule[field]!, source: { scope, model: key } };
      }
    }
  }
  const trigger = { ...fields.trigger, tokens: tokens(fields.trigger.amount, model.contextWindow) };
  const target = { ...fields.target, tokens: tokens(fields.target.amount, model.contextWindow) };
  const triggerPoint = Math.max(MIN_TRIGGER, trigger.tokens);
  const invalid = target.tokens >= triggerPoint ? `Target (${formatTokens(target.tokens)}) must be below the actual trigger (${formatTokens(triggerPoint)}).` : undefined;
  const warning = model.contextWindow < MIN_TRIGGER ? `The fixed 20k automatic minimum exceeds this model's ${formatTokens(model.contextWindow)} context limit. Manual /compact remains available.` : triggerPoint >= model.contextWindow ? `Compaction trigger ${formatTokens(triggerPoint)} cannot be reached before this model's ${formatTokens(model.contextWindow)} context limit.` : undefined;
  return { trigger, target, triggerPoint, invalid, warning };
}
export function parseAmount(text: string): Amount {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(%|k|m)?\s*$/i.exec(text);
  if (!match) throw new Error("Use a token count (20000 or 20k) or a percentage (80%).");
  const suffix = match[2]?.toLowerCase();
  const amount: Amount = { unit: suffix === "%" ? "percent" : "tokens", value: Number(match[1]) * (suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1) };
  validateAmount(amount);
  return amount;
}
export function formatTokens(n: number): string {
  const magnitude = Math.abs(n);
  if (magnitude >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  if (magnitude >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`;
  return String(Math.round(n));
}
export const formatAmount = (a: Amount): string => a.unit === "percent" ? `${a.value}%` : formatTokens(a.value);
export function sourceLabel(source: Selection | null): string {
  return source ? `${source.scope} / ${source.model ?? "all models"}` : "built-in defaults";
}
export function footer(c: Configuration, effective: Effective, capacity: number, current: number | null): { text: string; color: "dim" | `#${string}` } | undefined {
  const p = c.preferences;
  if (!p.visible) return undefined;
  if (!c.automatic) return { text: "Compact off", color: "dim" };
  const at = effective.triggerPoint;
  const value = p.basis === "left" ? capacity - at : at;
  const number = p.unit === "percent" ? `${Number((value / capacity * 100).toFixed(1))}%` : formatTokens(value);
  const ratio = current === null ? 0 : current / at;
  const color = effective.invalid || effective.warning ? "#c084fc" : ratio >= 1 ? "#ef4444" : ratio >= 0.95 ? "#f97316" : ratio >= 0.8 ? "#eab308" : p.colors === "contrast" ? "#22d3ee" : "#22c55e";
  return { text: `Compact ${p.basis} ${number}`, color };
}

/**
 * diff_dod (design section 8.4): what changed between two versions of a type (each
 * merged with its base) or of the base. Every entry names its origin, so a review sees
 * whether a change came from the base or from the type.
 */
import { canonicalJson } from '../dod/sync.ts';

export interface Comparable {
  id: string;
  origin: string;
  at?: unknown;
  [key: string]: unknown;
}

export interface Side {
  label: string;
  first_seen_at: string | null;
  criteria: Comparable[];
  rules: Comparable[];
  template?: string | undefined;
}

export interface FieldChange {
  key: string;
  from: unknown;
  to: unknown;
}

export interface ListDiff {
  added: Record<string, unknown>[];
  removed: Record<string, unknown>[];
  changed: { id: string; origin: string; fields: FieldChange[] }[];
}

export interface DiffResult {
  type: string;
  from: string;
  to: string;
  criteria: ListDiff;
  rules: ListDiff;
  template_changed: boolean;
  first_seen: { from: string | null; to: string | null };
  summary: { added: number; removed: number; changed: number };
}

function strip(item: Comparable): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...item };
  delete rest.at;
  return rest;
}

function diffList(from: Comparable[], to: Comparable[]): ListDiff {
  const before = new Map(from.map((c) => [c.id, strip(c)]));
  const after = new Map(to.map((c) => [c.id, strip(c)]));
  const result: ListDiff = { added: [], removed: [], changed: [] };
  for (const [id, item] of after) if (!before.has(id)) result.added.push(item);
  for (const [id, item] of before) if (!after.has(id)) result.removed.push(item);
  for (const [id, newItem] of after) {
    const oldItem = before.get(id);
    if (!oldItem) continue;
    const keys = [...new Set([...Object.keys(oldItem), ...Object.keys(newItem)])].sort();
    const fields = keys
      .filter((k) => canonicalJson(oldItem[k]) !== canonicalJson(newItem[k]))
      .map((k) => ({ key: k, from: oldItem[k] ?? null, to: newItem[k] ?? null }));
    if (fields.length > 0) result.changed.push({ id, origin: String(newItem.origin), fields });
  }
  return result;
}

export function diffSides(type: string, from: Side, to: Side): DiffResult {
  const criteria = diffList(from.criteria, to.criteria);
  const rules = diffList(from.rules, to.rules);
  const count = (k: keyof ListDiff) => criteria[k].length + rules[k].length;
  return {
    type,
    from: from.label,
    to: to.label,
    criteria,
    rules,
    template_changed: (from.template ?? '') !== (to.template ?? ''),
    first_seen: { from: from.first_seen_at, to: to.first_seen_at },
    summary: { added: count('added'), removed: count('removed'), changed: count('changed') },
  };
}

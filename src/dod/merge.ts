/**
 * Base + type = the effective DoD of a type (design section 5). Every criterion and
 * rule keeps its origin, file and line, so a reader sees where it comes from.
 */
import type { Criterion, DodFile, DodSet, Rule, ValidationError } from './model.ts';
import { typeErrors } from './load.ts';

export type Origin = 'base' | string;

export type MergedCriterion = Criterion & { origin: Origin };
export type MergedRule = Rule & { origin: Origin };

export interface MergedDod {
  type: string;
  title: string;
  description?: string;
  /** e.g. "kundenanfrage@3+base@2" */
  dod_version: string;
  versions: { base: number; type: number };
  files: { base: string; type: string };
  criteria: MergedCriterion[];
  rules: MergedRule[];
  template?: string;
}

export function dodVersionLabel(type: string, typeVersion: number, baseVersion: number): string {
  return `${type}@${typeVersion}+base@${baseVersion}`;
}

export function mergeDod(base: DodFile, type: DodFile): MergedDod {
  const merged: MergedDod = {
    type: type.name,
    title: type.title,
    dod_version: dodVersionLabel(type.name, type.version, base.version),
    versions: { base: base.version, type: type.version },
    files: { base: base.file, type: type.file },
    criteria: [
      ...base.criteria.map((c) => ({ ...c, origin: 'base' })),
      ...type.criteria.map((c) => ({ ...c, origin: type.name })),
    ],
    rules: [
      ...base.rules.map((r) => ({ ...r, origin: 'base' })),
      ...type.rules.map((r) => ({ ...r, origin: type.name })),
    ],
  };
  if (type.description !== undefined) merged.description = type.description;
  if (type.template !== undefined) merged.template = type.template;
  return merged;
}

export type Effective = { ok: true; dod: MergedDod } | { ok: false; errors: ValidationError[] };

/** The merged DoD of a type file in the set, or why there is none. */
export function effectiveDod(set: DodSet, type: string): Effective {
  const state = set.types.get(type);
  const base = set.base.parsed;
  if (!state || !state.parsed || !base) {
    return { ok: false, errors: typeErrors(set, type) };
  }
  return { ok: true, dod: mergeDod(base, state.parsed) };
}

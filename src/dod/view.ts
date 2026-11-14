/**
 * The JSON shapes that resources and get_dod return (design sections 8.1 and 9). One
 * shape for a type, valid or not, and one overview; tools and resources share them.
 */
import type { DodSet, ValidationError } from './model.ts';
import { effectiveDod, type MergedCriterion, type MergedDod, type MergedRule } from './merge.ts';
import type { DodStore } from '../store/store.ts';
import { typeHistory, type VersionEntry } from './history.ts';
import { invalidDod } from './resolve.ts';

export function typeUri(type: string): string {
  return `dod://type/${type}`;
}
export function templateUri(type: string): string {
  return `template://${type}`;
}
export function rubricUri(type: string): string {
  return `rubric://dod/${type}`;
}

/** A criterion without the internal location object: origin, file and line instead. */
export function criterionView(c: MergedCriterion): Record<string, unknown> {
  const { at, origin, id, ...rest } = c;
  return { id, origin, file: at.file, line: at.line, ...rest };
}

export function ruleView(r: MergedRule): Record<string, unknown> {
  const { at, origin, id, ...rest } = r;
  return { id, origin, file: at.file, line: at.line, ...rest };
}

export function errorView(e: ValidationError): Record<string, unknown> {
  const view: Record<string, unknown> = {
    file: e.file,
    line: e.line,
    column: e.column,
    code: e.code,
    message: e.message,
  };
  if (e.related) view.related = { ...e.related };
  return view;
}

export function mappingOf(
  set: DodSet,
  type: string,
): {
  mapped: boolean;
  ticket_types: string[];
  labels: string[];
} {
  const entry = set.mapping.parsed?.entries.find((e) => e.type === type);
  return {
    mapped: entry !== undefined,
    ticket_types: entry?.ticket_types ?? [],
    labels: entry?.labels ?? [],
  };
}

export function dodView(set: DodSet, dod: MergedDod): Record<string, unknown> {
  const view: Record<string, unknown> = {
    type: dod.type,
    title: dod.title,
    valid: true,
    dod_version: dod.dod_version,
    versions: dod.versions,
    files: dod.files,
    mapping: mappingOf(set, dod.type),
    criteria: dod.criteria.map(criterionView),
    rules: dod.rules.map(ruleView),
    template: templateUri(dod.type),
    rubric: rubricUri(dod.type),
  };
  if (dod.description !== undefined) view.description = dod.description;
  return view;
}

export function invalidView(set: DodSet, type: string): Record<string, unknown> {
  const state = set.types.get(type);
  return {
    type,
    valid: false,
    file: state?.file ?? `${type}.yaml`,
    errors: [...set.base.errors, ...(state?.errors ?? [])].map(errorView),
  };
}

/** Recorded versions of a type, if the history is available. */
export function historyOf(
  set: DodSet,
  store: DodStore | undefined,
  type: string,
): VersionEntry[] | undefined {
  if (!store || !set.history?.available) return undefined;
  try {
    return typeHistory(store, type);
  } catch {
    return undefined;
  }
}

/** The view of one type file, valid or not; undefined if there is no such file. */
export function typeView(
  set: DodSet,
  type: string,
  store?: DodStore,
): Record<string, unknown> | undefined {
  if (!set.types.has(type)) return undefined;
  const result = effectiveDod(set, type);
  const view = result.ok ? dodView(set, result.dod) : invalidView(set, type);
  const history = historyOf(set, store, type);
  if (history) view.history = history;
  return view;
}

/** The merged DoD for a tool, or the domain error invalid_dod with file and line. */
export function requireDod(set: DodSet, type: string): MergedDod {
  const result = effectiveDod(set, type);
  if (!result.ok) throw invalidDod(result.errors, type);
  return result.dod;
}

export function typesOverview(set: DodSet, store?: DodStore): Record<string, unknown> {
  const base = set.base.parsed;
  return {
    history: set.history ?? { available: false, backend: 'none' },
    base: {
      file: set.base.file,
      valid: base !== null,
      version: base?.version ?? null,
      criteria: base?.criteria.length ?? 0,
    },
    mapping: {
      file: set.mapping.file,
      valid: set.mapping.parsed !== null,
      version: set.mapping.parsed?.version ?? null,
    },
    types: [...set.types.entries()].map(([type, state]) => {
      const result = effectiveDod(set, type);
      const mapping = mappingOf(set, type);
      return {
        type,
        file: state.file,
        uri: typeUri(type),
        valid: result.ok,
        title: result.ok ? result.dod.title : null,
        dod_version: result.ok ? result.dod.dod_version : null,
        criteria: result.ok
          ? {
              base: result.dod.criteria.filter((c) => c.origin === 'base').length,
              type: result.dod.criteria.filter((c) => c.origin !== 'base').length,
            }
          : null,
        ...mapping,
        versions: historyOf(set, store, type)?.map((v) => v.version) ?? [],
      };
    }),
    errors: [
      ...set.base.errors,
      ...set.mapping.errors,
      ...[...set.types.values()].flatMap((t) => t.errors),
    ].map(errorView),
  };
}

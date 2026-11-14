/**
 * Sync before each request (design section 6.2): every valid file version the server
 * sees is recorded in the store; a changed file with an old version number, or a version
 * lower than one already recorded, makes the file invalid. Idempotent: repeating the
 * sync changes nothing.
 *
 * If the store fails, the server keeps serving the current files without version checks
 * and marks the history as unavailable.
 */
import { createHash } from 'node:crypto';
import { logError } from '../logger.ts';
import type { DodStore, FileKind } from '../store/store.ts';
import type { DodFile, DodSet, FileState, MappingFile, ValidationError } from './model.ts';
import { sortErrors } from './validate.ts';
import { parseYaml } from './yamlFile.ts';

/** JSON with sorted keys, so the hash does not depend on key order or formatting. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function contentHash(data: unknown): string {
  return createHash('sha256').update(canonicalJson(data)).digest('hex');
}

type Versioned = { file: string; version: number; text: string; data: unknown };

function versionError(
  file: Versioned,
  code: 'version_not_bumped' | 'version_regressed',
  message: string,
): ValidationError {
  const parsed = parseYaml(file.file, file.text);
  const at = parsed.source?.location(['version']) ?? { file: file.file, line: 1, column: 1 };
  return { ...at, code, message };
}

/** Checks one valid file against the store and records it; returns an error if it may not be served. */
function syncFile(
  store: DodStore,
  file: Versioned,
  kind: FileKind,
  now: string,
): ValidationError | undefined {
  const latest = store.latestVersion(file.file);
  if (latest !== undefined && file.version < latest) {
    return versionError(
      file,
      'version_regressed',
      `version ${file.version} is lower than version ${latest}, which was already in force. A change, also a revert, needs a version above ${latest}.`,
    );
  }
  const hash = contentHash(file.data);
  const stored = store.getFileVersion(file.file, file.version);
  if (stored && stored.content_sha256 !== hash) {
    return versionError(
      file,
      'version_not_bumped',
      `The content changed, but version ${file.version} was already recorded with other content on ${stored.first_seen_at}. Raise the version to ${(latest ?? file.version) + 1}.`,
    );
  }
  if (!stored) {
    store.recordFileVersion({
      file: file.file,
      kind,
      version: file.version,
      content_sha256: hash,
      content: file.text,
      first_seen_at: now,
    });
  }
  return undefined;
}

function invalidate<T>(state: FileState<T>, error: ValidationError): FileState<T> {
  return { file: state.file, parsed: null, errors: sortErrors([...state.errors, error]) };
}

export function syncDodSet(set: DodSet, store: DodStore | undefined, now: Date): DodSet {
  if (!store) return set;
  const at = now.toISOString();
  try {
    return store.transaction(() => {
      let base: FileState<DodFile> = set.base;
      if (base.parsed) {
        const error = syncFile(store, base.parsed, 'base', at);
        if (error) base = invalidate(base, error);
      }
      let mapping: FileState<MappingFile> = set.mapping;
      if (mapping.parsed) {
        const error = syncFile(store, mapping.parsed, 'mapping', at);
        if (error) mapping = invalidate(mapping, error);
      }
      const types = new Map<string, FileState<DodFile>>();
      for (const [name, state] of set.types) {
        let next = state;
        if (state.parsed) {
          const error = syncFile(store, state.parsed, 'type', at);
          if (error) next = invalidate(state, error);
        }
        if (next.parsed && base.parsed) {
          store.recordEdition({
            type: name,
            type_version: next.parsed.version,
            base_version: base.parsed.version,
            first_seen_at: at,
          });
        }
        types.set(name, next);
      }
      return {
        ...set,
        base,
        mapping,
        types,
        history: { available: true, backend: store.description },
      };
    });
  } catch (error) {
    logError('the store failed; serving the current files without history', error);
    return {
      ...set,
      history: {
        available: false,
        backend: store.description,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

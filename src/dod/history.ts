/**
 * Earlier versions from the store (design section 6.3). "Version n of a type" means the
 * type file at version n, together with the base version in force when the server first
 * saw version n. Stored file texts go through the same loader as current files.
 */
import type { DodStore } from '../store/store.ts';
import { mergeDod, type MergedDod } from './merge.ts';
import type { DodFile } from './model.ts';
import { validateDodFile } from './validate.ts';

export interface StoredEdition {
  dod: MergedDod;
  first_seen_at: string;
}

export function loadBaseVersion(store: DodStore, version: number): DodFile | undefined {
  const stored = store.getFileVersion('base.yaml', version);
  if (!stored) return undefined;
  const result = validateDodFile('base.yaml', stored.content, 'base', 'base');
  if (!result.parsed) {
    throw new Error(`base.yaml version ${version} in the store no longer validates.`);
  }
  return result.parsed;
}

export function loadEdition(
  store: DodStore,
  type: string,
  typeVersion: number,
): StoredEdition | undefined {
  const edition = store.firstEdition(type, typeVersion);
  const stored = store.getFileVersion(`${type}.yaml`, typeVersion);
  if (!edition || !stored) return undefined;
  const baseStored = store.getFileVersion('base.yaml', edition.base_version);
  if (!baseStored) return undefined;
  const base = validateDodFile('base.yaml', baseStored.content, 'base', 'base');
  const file = validateDodFile(`${type}.yaml`, stored.content, 'type', type, base.ids);
  if (!base.parsed || !file.parsed) {
    throw new Error(`${type}.yaml version ${typeVersion} in the store no longer validates.`);
  }
  return { dod: mergeDod(base.parsed, file.parsed), first_seen_at: edition.first_seen_at };
}

export interface VersionEntry {
  version: number;
  base_version: number | null;
  first_seen_at: string;
  uri: string;
}

/** The recorded versions of a type file, each with the base it was first served with. */
export function typeHistory(store: DodStore, type: string): VersionEntry[] {
  return store.listVersions(`${type}.yaml`).map((v) => ({
    version: v.version,
    base_version: store.firstEdition(type, v.version)?.base_version ?? null,
    first_seen_at: v.first_seen_at,
    uri: `dod://type/${type}/version/${v.version}`,
  }));
}

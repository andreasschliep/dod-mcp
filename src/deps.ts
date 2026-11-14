/**
 * What the tools and resources need from the outside world, injectable for tests.
 */
import { dodDirFromEnv } from './config.ts';
import { DomainError } from './errors.ts';
import { DodUnavailableError, loadDodSet } from './dod/load.ts';
import type { DodSet } from './dod/model.ts';
import { syncDodSet } from './dod/sync.ts';
import { logError } from './logger.ts';
import {
  DEFAULT_DATABASE,
  openStore,
  UnsupportedDatabaseError,
  type DodStore,
} from './store/store.ts';

export interface ServerDeps {
  dodDir: string;
  /** Reads the DoD folder and syncs it with the store; called on every request (no cache). */
  loadSet(): DodSet;
  now(): Date;
  /** The version history; undefined if it could not be opened. */
  store: DodStore | undefined;
}

export function createDeps(
  dodDir: string,
  store: DodStore | undefined,
  now = () => new Date(),
): ServerDeps {
  return { dodDir, store, now, loadSet: () => syncDodSet(loadDodSet(dodDir), store, now()) };
}

/**
 * From the environment. An unsupported DOD_DATABASE stops the server (design 6.4); a
 * store that cannot be opened (e.g. read-only volume) leaves the server running without
 * history.
 */
export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const url = env.DOD_DATABASE?.trim() || DEFAULT_DATABASE;
  let store: DodStore | undefined;
  try {
    store = openStore(url);
  } catch (error) {
    if (error instanceof UnsupportedDatabaseError) throw error;
    logError('the store cannot be opened; serving without history', error);
  }
  return createDeps(dodDirFromEnv(env), store);
}

/** loadSet() for tools: a missing folder or base.yaml becomes the domain error dod_unavailable. */
export function loadForTool(deps: ServerDeps): DodSet {
  try {
    return deps.loadSet();
  } catch (error) {
    if (error instanceof DodUnavailableError) {
      throw new DomainError(
        'dod_unavailable',
        error.message,
        'Check DOD_DIR: it must point to a folder with base.yaml, types.yaml and one file per task type.',
      );
    }
    throw error;
  }
}

/** The store for history tools, or the domain error history_unavailable. */
export function storeForHistory(deps: ServerDeps, set: DodSet): DodStore {
  if (!deps.store || set.history?.available === false) {
    throw new DomainError(
      'history_unavailable',
      `The version history cannot be read${set.history?.error ? `: ${set.history.error}` : '.'}`,
      `Check DOD_DATABASE (${deps.store?.description ?? 'not open'}); the current DoD still works with get_dod and check_dod.`,
    );
  }
  return deps.store;
}

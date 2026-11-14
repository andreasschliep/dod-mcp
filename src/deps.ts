/**
 * What the tools and resources need from the outside world, injectable for tests.
 */
import { dodDirFromEnv } from './config.ts';
import { DomainError } from './errors.ts';
import { DodUnavailableError, loadDodSet } from './dod/load.ts';
import type { DodSet } from './dod/model.ts';

export interface ServerDeps {
  dodDir: string;
  /** Reads the DoD folder; called on every request (no cache). */
  loadSet(): DodSet;
  now(): Date;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const dodDir = dodDirFromEnv(env);
  return { dodDir, loadSet: () => loadDodSet(dodDir), now: () => new Date() };
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

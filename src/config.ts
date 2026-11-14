/**
 * Configuration from the environment only (design section 11.3).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root: one level above src/ (tests) or dist/ (built server). */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Limits from design section 11.4 (T6). */
export const LIMITS = {
  fileBytes: 100 * 1024,
  typeFiles: 50,
  criteriaPerFile: 200,
  rulesPerFile: 50,
  yamlAliases: 100,
} as const;

export function dodDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.DOD_DIR?.trim();
  return dir ? resolve(dir) : resolve(REPO_ROOT, 'dod');
}

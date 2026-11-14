/**
 * The store (design section 6): every version of every DoD file the server has seen,
 * and which combinations of type and base it served. The YAML files stay the source of
 * truth; the store only remembers.
 *
 * The server uses it only through this narrow interface. Version 1 implements sqlite:
 * (src/store/sqlite.ts); another backend is another implementation of the interface.
 */
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { SqliteStore } from './sqlite.ts';

export type FileKind = 'base' | 'type' | 'mapping';

export interface FileVersion {
  file: string;
  kind: FileKind;
  version: number;
  /** SHA-256 of the parsed, normalised content (comments and formatting do not count). */
  content_sha256: string;
  /** The full YAML text, read back through the same loader as a current file. */
  content: string;
  first_seen_at: string;
}

export type FileVersionInfo = Omit<FileVersion, 'content'>;

export interface Edition {
  type: string;
  type_version: number;
  base_version: number;
  first_seen_at: string;
}

export interface DodStore {
  /** "sqlite:memory" or "sqlite:<file name>", for messages; never a full path. */
  readonly description: string;
  /** Runs fn in one transaction; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
  recordFileVersion(version: FileVersion): boolean;
  recordEdition(edition: Edition): boolean;
  latestVersion(file: string): number | undefined;
  listVersions(file: string): FileVersionInfo[];
  getFileVersion(file: string, version: number): FileVersion | undefined;
  /** The first combination with base in which this type version was served. */
  firstEdition(type: string, typeVersion: number): Edition | undefined;
  close(): void;
}

/** The configured backend is not supported; the server stops at start (design 6.4). */
export class UnsupportedDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedDatabaseError';
  }
}

export const DEFAULT_DATABASE = `sqlite:${resolve(REPO_ROOT, 'local', 'dod.sqlite')}`;

/**
 * Opens the store named by a database URL:
 *   sqlite::memory:      in memory (tests)
 *   sqlite:<path>        a file; relative paths against the working directory
 */
export function openStore(url: string): DodStore {
  const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(url.trim());
  if (!match) {
    throw new UnsupportedDatabaseError(
      `DOD_DATABASE "${url}" is not a database URL such as sqlite:/data/dod.sqlite.`,
    );
  }
  const scheme = match[1]!.toLowerCase();
  const rest = match[2]!;
  if (scheme !== 'sqlite') {
    throw new UnsupportedDatabaseError(
      `DOD_DATABASE uses "${scheme}:", but this version supports only sqlite:. ` +
        'Another backend is another implementation of the DodStore interface.',
    );
  }
  if (rest === ':memory:') return new SqliteStore(':memory:', 'sqlite:memory');
  if (rest === '')
    throw new UnsupportedDatabaseError('DOD_DATABASE sqlite: needs a file path or :memory:.');
  const path = isAbsolute(rest) ? rest : resolve(process.cwd(), rest);
  mkdirSync(dirname(path), { recursive: true });
  return new SqliteStore(path, `sqlite:${path.split(/[/\\]/).pop() ?? 'dod.sqlite'}`);
}

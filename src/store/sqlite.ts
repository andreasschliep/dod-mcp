/**
 * SQLite backend for the store, with the built-in node:sqlite (no native addon). WAL
 * mode for files; one container, one writer (design section 6.4).
 */
import { DatabaseSync } from 'node:sqlite';
import type { DodStore, Edition, FileKind, FileVersion, FileVersionInfo } from './store.ts';

/** Numbered migrations; PRAGMA user_version holds the number of the last one applied. */
const MIGRATIONS: string[] = [
  `CREATE TABLE dod_file_versions (
     file TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('base', 'type', 'mapping')),
     version INTEGER NOT NULL CHECK (version > 0),
     content_sha256 TEXT NOT NULL,
     content TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     PRIMARY KEY (file, version)
   );
   CREATE TABLE dod_editions (
     type TEXT NOT NULL,
     type_version INTEGER NOT NULL,
     base_version INTEGER NOT NULL,
     first_seen_at TEXT NOT NULL,
     PRIMARY KEY (type, type_version, base_version)
   );`,
];

type Row = Record<string, unknown>;

export class SqliteStore implements DodStore {
  readonly description: string;
  private readonly db: DatabaseSync;

  constructor(path: string, description: string) {
    this.description = description;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordFileVersion(v: FileVersion): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO dod_file_versions (file, kind, version, content_sha256, content, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(v.file, v.kind, v.version, v.content_sha256, v.content, v.first_seen_at);
    return Number(result.changes) > 0;
  }

  recordEdition(e: Edition): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO dod_editions (type, type_version, base_version, first_seen_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(e.type, e.type_version, e.base_version, e.first_seen_at);
    return Number(result.changes) > 0;
  }

  latestVersion(file: string): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM dod_file_versions WHERE file = ?')
      .get(file) as Row | undefined;
    return row?.version === null || row?.version === undefined ? undefined : Number(row.version);
  }

  listVersions(file: string): FileVersionInfo[] {
    return (
      this.db
        .prepare(
          `SELECT file, kind, version, content_sha256, first_seen_at FROM dod_file_versions
           WHERE file = ? ORDER BY version`,
        )
        .all(file) as Row[]
    ).map((r) => ({
      file: String(r.file),
      kind: String(r.kind) as FileKind,
      version: Number(r.version),
      content_sha256: String(r.content_sha256),
      first_seen_at: String(r.first_seen_at),
    }));
  }

  getFileVersion(file: string, version: number): FileVersion | undefined {
    const r = this.db
      .prepare('SELECT * FROM dod_file_versions WHERE file = ? AND version = ?')
      .get(file, version) as Row | undefined;
    if (!r) return undefined;
    return {
      file: String(r.file),
      kind: String(r.kind) as FileKind,
      version: Number(r.version),
      content_sha256: String(r.content_sha256),
      content: String(r.content),
      first_seen_at: String(r.first_seen_at),
    };
  }

  firstEdition(type: string, typeVersion: number): Edition | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM dod_editions WHERE type = ? AND type_version = ?
         ORDER BY first_seen_at, base_version LIMIT 1`,
      )
      .get(type, typeVersion) as Row | undefined;
    if (!r) return undefined;
    return {
      type: String(r.type),
      type_version: Number(r.type_version),
      base_version: Number(r.base_version),
      first_seen_at: String(r.first_seen_at),
    };
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

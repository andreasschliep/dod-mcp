/**
 * Test helpers: a temporary copy of the example DoD folder with some files replaced,
 * added or removed, so every invalid case is visible in the test that uses it.
 */
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const EXAMPLE_DOD = fileURLToPath(new URL('../dod', import.meta.url));

const created: string[] = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Copies dod/ to a temporary folder; a string replaces or adds a file, null removes it. */
export function tempDod(changes: Record<string, string | null> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dod-test-'));
  created.push(dir);
  cpSync(EXAMPLE_DOD, dir, { recursive: true });
  for (const [file, content] of Object.entries(changes)) {
    const path = join(dir, file);
    if (content === null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
  return dir;
}

/** Joins lines, so the line numbers in a test can be read off the array index + 1. */
export function lines(...rows: string[]): string {
  return `${rows.join('\n')}\n`;
}

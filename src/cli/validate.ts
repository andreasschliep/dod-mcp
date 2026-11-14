#!/usr/bin/env node
/**
 * dod-validate: checks a DoD folder with the same loader the server uses, for pull
 * requests on dod/ (design section 17, F3a). Prints every error as file:line:column,
 * the form CI logs and editors understand.
 *
 *   dod-validate [folder]      default: $DOD_DIR, else ./dod
 *
 * Exit codes: 0 valid, 1 at least one error, 2 the folder or base.yaml is missing.
 *
 * It checks the files only. Whether a changed file got a new version number needs the
 * history in the server's store (version_not_bumped, design section 6.2).
 */
import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allErrors, DodUnavailableError, loadDodSet } from '../dod/load.ts';
import type { DodSet, ValidationError } from '../dod/model.ts';

export function formatError(error: ValidationError): string {
  const head = `${error.file}:${error.line}:${error.column} ${error.code}: ${error.message}`;
  return error.related
    ? `${head}\n  see ${error.related.file}:${error.related.line}:${error.related.column}`
    : head;
}

export function summarise(set: DodSet): string[] {
  const lines: string[] = [];
  const base = set.base.parsed;
  lines.push(
    base
      ? `${set.base.file}: valid, version ${base.version}, ${plural(base.criteria.length, 'criterion', 'criteria')}, ${plural(base.rules.length, 'rule', 'rules')}`
      : `${set.base.file}: invalid`,
  );
  for (const [name, state] of set.types) {
    const t = state.parsed;
    lines.push(
      t && base
        ? `${state.file}: valid, ${name}@${t.version}+base@${base.version}, ${plural(t.criteria.length, 'criterion', 'criteria')} of its own`
        : `${state.file}: invalid`,
    );
  }
  lines.push(
    set.mapping.parsed
      ? `${set.mapping.file}: valid, version ${set.mapping.parsed.version}, ${set.mapping.parsed.entries.length} mappings`
      : `${set.mapping.file}: invalid`,
  );
  return lines;
}

export function run(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const dir = resolve(args[0] ?? env.DOD_DIR ?? 'dod');
  const shown = relative(process.cwd(), dir) || '.';
  let set: DodSet;
  try {
    set = loadDodSet(dir);
  } catch (error) {
    if (error instanceof DodUnavailableError) {
      console.error(`${shown}: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const errors = allErrors(set);
  for (const line of summarise(set)) console.log(line);
  if (errors.length === 0) {
    console.log(`${shown}: no errors`);
    return 0;
  }
  console.log('');
  for (const error of errors) console.log(formatError(error));
  console.log(`\n${shown}: ${plural(errors.length, 'error', 'errors')}`);
  return 1;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = run(process.argv.slice(2));
}

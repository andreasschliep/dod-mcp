/**
 * Reads the DoD folder (design section 5.1): base.yaml, types.yaml and every other
 * *.yaml as a type file. The folder is read on every call; there is no cache (D13 of
 * the first draft, kept: a new or changed file takes effect without a restart).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../config.ts';
import type { DodFile, DodSet, FileState, ValidationError } from './model.ts';
import {
  isValidTypeName,
  sortErrors,
  validateDodFile,
  validateMapping,
  type BaseIds,
} from './validate.ts';

export const BASE_FILE = 'base.yaml';
export const MAPPING_FILE = 'types.yaml';

/** The folder or base.yaml is missing: nothing can be served (domain error dod_unavailable). */
export class DodUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DodUnavailableError';
  }
}

export function loadDodSet(dir: string): DodSet {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new DodUnavailableError('The DoD folder cannot be read.');
  }
  if (!names.includes(BASE_FILE)) {
    throw new DodUnavailableError(`The DoD folder has no ${BASE_FILE}.`);
  }

  const baseRead = readLimited(dir, BASE_FILE);
  const baseResult =
    'error' in baseRead
      ? { file: BASE_FILE, parsed: null, errors: [baseRead.error], ids: emptyIds() }
      : validateDodFile(BASE_FILE, baseRead.text, 'base', 'base');
  const base: FileState<DodFile> = {
    file: baseResult.file,
    parsed: baseResult.parsed,
    errors: baseResult.errors,
  };

  const types = new Map<string, FileState<DodFile>>();
  const typeFiles = names.filter((n) => n !== BASE_FILE && n !== MAPPING_FILE);
  typeFiles.forEach((file, index) => {
    const name = file.slice(0, -'.yaml'.length);
    const errors: ValidationError[] = [];
    if (index >= LIMITS.typeFiles) {
      types.set(name, {
        file,
        parsed: null,
        errors: [
          at(
            file,
            'invalid_value',
            `More than ${LIMITS.typeFiles} type files; this one is ignored.`,
          ),
        ],
      });
      return;
    }
    if (!isValidTypeName(name)) {
      errors.push(
        at(file, 'type_name_mismatch', `The file name must match ^[a-z][a-z0-9-]{0,39}\\.yaml$.`),
      );
    }
    const read = readLimited(dir, file);
    if ('error' in read) {
      types.set(name, { file, parsed: null, errors: [...errors, read.error] });
      return;
    }
    const result = validateDodFile(file, read.text, 'type', name, baseResult.ids);
    const all = sortErrors([...errors, ...result.errors]);
    types.set(name, { file, parsed: all.length === 0 ? result.parsed : null, errors: all });
  });

  const typeNames = new Set(types.keys());
  let mapping: DodSet['mapping'];
  if (!names.includes(MAPPING_FILE)) {
    mapping = {
      file: MAPPING_FILE,
      parsed: null,
      errors: [
        at(
          MAPPING_FILE,
          'invalid_mapping',
          `${MAPPING_FILE} is missing; types can only be chosen with an explicit type.`,
        ),
      ],
    };
  } else {
    const read = readLimited(dir, MAPPING_FILE);
    mapping =
      'error' in read
        ? { file: MAPPING_FILE, parsed: null, errors: [read.error] }
        : validateMapping(MAPPING_FILE, read.text, typeNames);
  }

  return { dir, base, mapping, types };
}

function readLimited(dir: string, file: string): { text: string } | { error: ValidationError } {
  const path = join(dir, file);
  try {
    if (statSync(path).size > LIMITS.fileBytes) {
      return {
        error: at(file, 'invalid_value', `The file is larger than ${LIMITS.fileBytes / 1024} KB.`),
      };
    }
    return { text: readFileSync(path, 'utf8') };
  } catch {
    return { error: at(file, 'invalid_value', 'The file cannot be read.') };
  }
}

function at(file: string, code: ValidationError['code'], message: string): ValidationError {
  return { file, line: 1, column: 1, code, message };
}

function emptyIds(): BaseIds {
  return { criteria: new Map(), rules: new Map() };
}

/** Every error that makes a type unusable: the base's and its own (5.6, "Effect of an error"). */
export function typeErrors(set: DodSet, type: string): ValidationError[] {
  const state = set.types.get(type);
  return [...set.base.errors, ...(state?.errors ?? [])];
}

/** All errors in the folder, sorted by file and line. */
export function allErrors(set: DodSet): ValidationError[] {
  return sortErrors([
    ...set.base.errors,
    ...set.mapping.errors,
    ...[...set.types.values()].flatMap((t) => t.errors),
  ]);
}

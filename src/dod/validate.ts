/**
 * Validation of one DoD file (base or type) and of types.yaml, with file and line for
 * every error (design section 5.6). The add-only rule is enforced here: no removal or
 * override keys, no base ids in a type file, and `extends: base` is required.
 */
import {
  CHECK_KINDS,
  RULE_KINDS,
  type CheckKind,
  type Criterion,
  type DodFile,
  type FileState,
  type Location,
  type MappingEntry,
  type MappingFile,
  type Rule,
  type RuleKind,
  type ValidationError,
} from './model.ts';
import {
  BaseFileSchema,
  CRITERION_SCHEMAS,
  MappingFileSchema,
  OVERRIDE_KEYS,
  REMOVAL_KEYS,
  RULE_SCHEMAS,
  TypeFileSchema,
  issuesToErrors,
} from './schema.ts';
import { isPlainObject, parseYaml, type YamlPath, type YamlSource } from './yamlFile.ts';

/** Ids defined in the base, with their location, for the collision check. */
export interface BaseIds {
  criteria: Map<string, Location>;
  rules: Map<string, Location>;
}

export interface DodFileResult extends FileState<DodFile> {
  /** Ids found in the file, even if it is invalid (used for base collisions). */
  ids: BaseIds;
}

const TYPE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export function validateDodFile(
  file: string,
  text: string,
  kind: 'base' | 'type',
  expectedName: string,
  base?: BaseIds,
): DodFileResult {
  const ids: BaseIds = { criteria: new Map(), rules: new Map() };
  const parsed = parseYaml(file, text);
  if (!parsed.source) return { file, parsed: null, errors: parsed.errors, ids };
  const source = parsed.source;
  const data = source.data;
  if (!isPlainObject(data)) {
    return {
      file,
      parsed: null,
      errors: [
        { ...source.location([]), code: 'invalid_value', message: 'The file must be a mapping.' },
      ],
      ids,
    };
  }

  const errors: ValidationError[] = [];
  const top: Record<string, unknown> = { ...data };

  if (kind === 'type') {
    for (const key of Object.keys(data)) {
      if (REMOVAL_KEYS.has(key)) {
        errors.push({
          ...source.location([key], 'key'),
          code: 'base_criterion_removed',
          message: `"${key}" would remove base criteria. A type may only add to the base.`,
        });
        delete top[key];
      } else if (OVERRIDE_KEYS.has(key)) {
        errors.push({
          ...source.location([key], 'key'),
          code: 'base_criterion_overridden',
          message: `"${key}" would change base criteria. A type may only add to the base.`,
        });
        delete top[key];
      }
    }
  }

  const schema = kind === 'base' ? BaseFileSchema : TypeFileSchema;
  const result = schema.safeParse(top);
  if (!result.success) errors.push(...issuesToErrors(source, result.error.issues, []));

  if (typeof data.type === 'string' && data.type !== expectedName) {
    errors.push({
      ...source.location(['type']),
      code: 'type_name_mismatch',
      message:
        kind === 'base'
          ? `base.yaml must say type: base, not "${data.type}".`
          : `type "${data.type}" does not match the file name ${file}; it must be "${expectedName}".`,
    });
  }

  if (kind === 'type') {
    if (!Object.hasOwn(data, 'extends')) {
      errors.push({
        ...source.location([]),
        code: 'base_criterion_removed',
        message: 'Missing "extends: base". Without it the type would drop every base criterion.',
      });
    } else if (data.extends !== 'base') {
      errors.push({
        ...source.location(['extends']),
        code: 'base_criterion_removed',
        message: `"extends" must be "base", not ${JSON.stringify(data.extends)}. A type always inherits the base.`,
      });
    }
  }

  const criteria = validateItems(source, data.criteria, ['criteria'], 'check', validateCriterion);
  errors.push(...criteria.errors);
  const acceptance = isPlainObject(data.acceptance) ? data.acceptance : {};
  const rules = validateItems(
    source,
    acceptance.rules,
    ['acceptance', 'rules'],
    'kind',
    validateRule,
  );
  errors.push(...rules.errors);

  collectIds(source, data.criteria, ['criteria'], ids.criteria, 'criterion', errors);
  collectIds(source, acceptance.rules, ['acceptance', 'rules'], ids.rules, 'rule', errors);

  if (kind === 'type' && base) {
    for (const [id, at] of ids.criteria) {
      const original = base.criteria.get(id);
      if (original) {
        errors.push({
          ...at,
          code: 'base_criterion_overridden',
          message: `Criterion ${id} is already defined in ${original.file}:${original.line}. A type may only add to the base.`,
          related: original,
        });
      }
    }
    for (const [id, at] of ids.rules) {
      const original = base.rules.get(id);
      if (original) {
        errors.push({
          ...at,
          code: 'base_criterion_overridden',
          message: `Rule ${id} is already defined in ${original.file}:${original.line}. A type may only add to the base.`,
          related: original,
        });
      }
    }
  }

  if (errors.length > 0 || !result.success) {
    return { file, parsed: null, errors: sortErrors(errors), ids };
  }

  const ok = result.data;
  const dod: DodFile = {
    file,
    kind,
    name: expectedName,
    version: ok.version,
    title: ok.title,
    criteria: criteria.items,
    rules: rules.items,
    text,
    data,
  };
  if (ok.description !== undefined) dod.description = ok.description;
  const template: unknown =
    ok.acceptance && 'template' in ok.acceptance ? ok.acceptance.template : undefined;
  if (typeof template === 'string') dod.template = template;
  return { file, parsed: dod, errors: [], ids };
}

type ItemValidator<T> = (
  source: YamlSource,
  item: Record<string, unknown>,
  path: YamlPath,
) => { item: T | null; errors: ValidationError[] };

function validateItems<T>(
  source: YamlSource,
  list: unknown,
  path: YamlPath,
  discriminator: string,
  validate: ItemValidator<T>,
): { items: T[]; errors: ValidationError[] } {
  const items: T[] = [];
  const errors: ValidationError[] = [];
  if (!Array.isArray(list)) return { items, errors }; // the top-level schema reports it
  list.forEach((raw, index) => {
    const itemPath = [...path, index];
    if (!isPlainObject(raw)) {
      errors.push({
        ...source.location(itemPath),
        code: 'invalid_value',
        message: `Every entry in ${path.join('.')} must be a mapping with ${discriminator}.`,
      });
      return;
    }
    const result = validate(source, raw, itemPath);
    errors.push(...result.errors);
    if (result.item) items.push(result.item);
  });
  return { items, errors };
}

const KEYS_BY_CHECK = Object.fromEntries(
  CHECK_KINDS.map((k) => [k, Object.keys(CRITERION_SCHEMAS[k].shape)]),
) as Record<CheckKind, string[]>;

const validateCriterion: ItemValidator<Criterion> = (source, item, path) => {
  const check = item.check;
  if (check === undefined) {
    return {
      item: null,
      errors: [{ ...source.location(path), code: 'missing_key', message: 'Missing key "check".' }],
    };
  }
  if (typeof check !== 'string' || !(CHECK_KINDS as readonly string[]).includes(check)) {
    return {
      item: null,
      errors: [
        {
          ...source.location([...path, 'check']),
          code: 'invalid_value',
          message: `check must be one of ${CHECK_KINDS.join(', ')}, not ${JSON.stringify(check)}.`,
        },
      ],
    };
  }
  const kind = check as CheckKind;
  const result = CRITERION_SCHEMAS[kind].safeParse(item);
  if (!result.success) {
    const hint = (key: string): string | undefined => {
      const owner = CHECK_KINDS.find((k) => k !== kind && KEYS_BY_CHECK[k].includes(key));
      return owner ? `for check: ${kind} (it belongs to check: ${owner})` : `for check: ${kind}`;
    };
    return { item: null, errors: issuesToErrors(source, result.error.issues, path, hint) };
  }
  return { item: { ...result.data, at: source.location(path) } as Criterion, errors: [] };
};

const validateRule: ItemValidator<Rule> = (source, item, path) => {
  const kind = item.kind;
  if (kind === undefined) {
    return {
      item: null,
      errors: [{ ...source.location(path), code: 'missing_key', message: 'Missing key "kind".' }],
    };
  }
  if (typeof kind !== 'string' || !(RULE_KINDS as readonly string[]).includes(kind)) {
    return {
      item: null,
      errors: [
        {
          ...source.location([...path, 'kind']),
          code: 'invalid_value',
          message: `kind must be one of ${RULE_KINDS.join(', ')}, not ${JSON.stringify(kind)}.`,
        },
      ],
    };
  }
  const result = RULE_SCHEMAS[kind as RuleKind].safeParse(item);
  if (!result.success) {
    return {
      item: null,
      errors: issuesToErrors(source, result.error.issues, path, () => `for kind: ${kind}`),
    };
  }
  return { item: { ...result.data, at: source.location(path) } as Rule, errors: [] };
};

/** Records every string id with its location; a second occurrence is duplicate_id. */
function collectIds(
  source: YamlSource,
  list: unknown,
  path: YamlPath,
  into: Map<string, Location>,
  what: string,
  errors: ValidationError[],
): void {
  if (!Array.isArray(list)) return;
  list.forEach((raw, index) => {
    if (!isPlainObject(raw) || typeof raw.id !== 'string') return;
    const at = source.location([...path, index]);
    const first = into.get(raw.id);
    if (first) {
      errors.push({
        ...source.location([...path, index, 'id']),
        code: 'duplicate_id',
        message: `The ${what} id ${raw.id} is already used in line ${first.line}.`,
        related: first,
      });
    } else {
      into.set(raw.id, at);
    }
  });
}

export function validateMapping(
  file: string,
  text: string,
  typeNames: ReadonlySet<string>,
): FileState<MappingFile> {
  const parsed = parseYaml(file, text);
  if (!parsed.source) return { file, parsed: null, errors: parsed.errors };
  const source = parsed.source;
  const result = MappingFileSchema.safeParse(source.data);
  if (!result.success) {
    return {
      file,
      parsed: null,
      errors: sortErrors(issuesToErrors(source, result.error.issues, [])),
    };
  }
  const errors: ValidationError[] = [];
  const entries: MappingEntry[] = [];
  const seen = { ticket_types: new Map<string, Location>(), labels: new Map<string, Location>() };
  for (const [type, mapping] of Object.entries(result.data.mappings)) {
    const at = source.location(['mappings', type], 'key');
    if (!typeNames.has(type)) {
      errors.push({
        ...at,
        code: 'invalid_mapping',
        message: `There is no type file ${type}.yaml for this mapping.`,
      });
    }
    const entry: MappingEntry = { type, ticket_types: [], labels: [], at };
    for (const list of ['ticket_types', 'labels'] as const) {
      (mapping[list] ?? []).forEach((name, index) => {
        const key = normaliseName(name);
        const here = source.location(['mappings', type, list, index]);
        const first = seen[list].get(key);
        if (first) {
          errors.push({
            ...here,
            code: 'invalid_mapping',
            message: `${list === 'labels' ? 'Label' : 'Ticket type'} "${name}" is already mapped in line ${first.line}; it may belong to one type only.`,
            related: first,
          });
        } else {
          seen[list].set(key, here);
          entry[list].push(name.trim());
        }
      });
    }
    entries.push(entry);
  }
  if (errors.length > 0) return { file, parsed: null, errors: sortErrors(errors) };
  return {
    file,
    parsed: { file, version: result.data.version, entries, text, data: source.data },
    errors: [],
  };
}

/** Ticket types and labels match without case and surrounding whitespace (5.5). */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

export function isValidTypeName(name: string): boolean {
  return TYPE_NAME.test(name);
}

export function sortErrors(errors: ValidationError[]): ValidationError[] {
  return [...errors].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.code.localeCompare(b.code),
  );
}

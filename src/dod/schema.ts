/**
 * zod schemas for the DoD files (design section 5) and the mapping from zod issues to
 * validation errors with file and line.
 *
 * Objects are strict: an unknown key is an error, never silently ignored. Criteria and
 * rules are validated one by one after their `check` or `kind`, so the message can say
 * which keys fit which kind.
 */
import { z } from 'zod';
import { LIMITS } from '../config.ts';
import type { CheckKind, RuleKind, ValidationError } from './model.ts';
import { existsIn, type YamlPath, type YamlSource } from './yamlFile.ts';

const CRITERION_ID = /^[A-Z][A-Z0-9-]{1,39}$/;
const RULE_ID = /^AK-[A-Z0-9-]{1,36}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/;

const Id = z.string().regex(CRITERION_ID, 'must match ^[A-Z][A-Z0-9-]{1,39}$');
const RuleId = z.string().regex(RULE_ID, 'must match ^AK-[A-Z0-9-]{1,36}$');
const Text = z.string().trim().min(1).max(500);
const ShortText = z.string().trim().min(1).max(200);
const Version = z.number().int().positive();
const Scalar = z.union([z.string(), z.number(), z.boolean()]);
const FetchWith = z
  .array(z.string().regex(TOOL_NAME, 'must look like server:tool or tool').max(200))
  .max(10);
const MaxAgeHours = z
  .number()
  .positive()
  .max(24 * 366);
const Words = z.array(z.string().trim().min(1).max(60)).min(1).max(100);

const OPERATORS = ['equals', 'one_of', 'min', 'max', 'present', 'not_after'] as const;

export const ExpectSchema = z
  .strictObject({
    field: z.string().trim().min(1).max(100).optional(),
    equals: Scalar.optional(),
    one_of: z.array(Scalar).min(1).max(50).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    present: z.literal(true).optional(),
    not_after: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    const used = OPERATORS.filter((op) => value[op] !== undefined);
    if (used.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message:
          `expect needs exactly one operator (${OPERATORS.join(', ')}); ` +
          (used.length === 0 ? 'found none' : `found ${used.join(', ')}`),
      });
    }
    if (value.not_after !== undefined && value.field === undefined) {
      ctx.addIssue({ code: 'custom', message: 'not_after compares two fields; set field too' });
    }
  });

export const CRITERION_SCHEMAS = {
  evidence: z.strictObject({
    id: Id,
    text: Text,
    check: z.literal('evidence'),
    source: ShortText,
    expect: ExpectSchema,
    max_age_hours: MaxAgeHours.optional(),
    same_ref: z.boolean().optional(),
    fetch_with: FetchWith.optional(),
  }),
  judgment: z.strictObject({
    id: Id,
    text: Text,
    check: z.literal('judgment'),
    question: Text,
    plausible_if: z.array(Text).max(10).optional(),
    doubtful_if: z.array(Text).max(10).optional(),
    fetch_with: FetchWith.optional(),
  }),
  attestation: z.strictObject({
    id: Id,
    text: Text,
    check: z.literal('attestation'),
    role: z.string().trim().min(1).max(100),
    max_age_hours: MaxAgeHours.optional(),
    fetch_with: FetchWith.optional(),
  }),
} satisfies Record<CheckKind, z.ZodType>;

const FieldSpecSchema = z
  .strictObject({
    name: z.string().regex(/^\p{L}[\p{L}\p{N} -]{0,39}$/u, 'must be a word of up to 40 letters'),
    list: z.boolean().optional(),
    min_items: z.number().int().min(1).max(50).optional(),
    format: z.enum(['date', 'duration', 'date_or_duration']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.min_items !== undefined && value.list !== true) {
      ctx.addIssue({ code: 'custom', message: 'min_items needs list: true' });
    }
    if (value.list === true && value.format !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'a list field has no format' });
    }
  });

export const RULE_SCHEMAS = {
  gherkin: z.strictObject({ id: RuleId, kind: z.literal('gherkin') }),
  observable_then: z.strictObject({
    id: RuleId,
    kind: z.literal('observable_then'),
    phrases: Words,
  }),
  vague_words: z.strictObject({ id: RuleId, kind: z.literal('vague_words'), words: Words }),
  numbers_need_units: z.strictObject({
    id: RuleId,
    kind: z.literal('numbers_need_units'),
    units: z.array(z.string().trim().min(1).max(20)).min(1).max(100),
  }),
  fields: z.strictObject({
    id: RuleId,
    kind: z.literal('fields'),
    fields: z.array(FieldSpecSchema).min(1).max(20),
  }),
} satisfies Record<RuleKind, z.ZodType>;

const TopCommon = {
  type: z.string(),
  version: Version,
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).optional(),
  criteria: z.array(z.unknown()).max(LIMITS.criteriaPerFile).optional(),
};

export const BaseFileSchema = z.strictObject({
  ...TopCommon,
  acceptance: z
    .strictObject({ rules: z.array(z.unknown()).max(LIMITS.rulesPerFile).optional() })
    .optional(),
});

export const TypeFileSchema = z.strictObject({
  ...TopCommon,
  // Required in substance; checked separately to give the add-only message (5.6).
  extends: z.unknown().optional(),
  acceptance: z
    .strictObject({
      template: z.string().max(5000).optional(),
      rules: z.array(z.unknown()).max(LIMITS.rulesPerFile).optional(),
    })
    .optional(),
});

const Names = z.array(z.string().trim().min(1).max(100)).max(50);

export const MappingFileSchema = z.strictObject({
  version: Version,
  mappings: z.record(
    z.string(),
    z.strictObject({ ticket_types: Names.optional(), labels: Names.optional() }),
  ),
});

/** Keys that look like removing or overriding base criteria (design section 5.6). */
export const REMOVAL_KEYS = new Set([
  'remove',
  'removes',
  'exclude',
  'excludes',
  'omit',
  'omits',
  'without',
]);
export const OVERRIDE_KEYS = new Set(['override', 'overrides', 'replace', 'replaces']);

/**
 * Turns zod issues into validation errors. `prefix` is the path of the validated value
 * inside the file; `keyHint` may explain an unknown key (e.g. which check kind it fits).
 */
export function issuesToErrors(
  source: YamlSource,
  issues: readonly z.core.$ZodIssue[],
  prefix: YamlPath,
  keyHint?: (key: string) => string | undefined,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const issue of issues) {
    const path: (string | number)[] = [
      ...prefix,
      ...issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
    ];
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const hint = keyHint?.(key);
        errors.push({
          ...source.location([...path, key], 'key'),
          code: 'unknown_key',
          message: `Unknown key "${key}"${hint ? ` ${hint}` : ''}.`,
        });
      }
    } else if (path.length > 0 && !existsIn(source.data, path)) {
      errors.push({
        ...source.location(path.slice(0, -1)),
        code: 'missing_key',
        message: `Missing key "${String(path[path.length - 1])}".`,
      });
    } else {
      errors.push({
        ...source.location(path),
        code: 'invalid_value',
        message: `${describePath(path)}: ${issue.message}.`,
      });
    }
  }
  return errors;
}

export function describePath(path: YamlPath): string {
  return path.length === 0
    ? 'file'
    : path
        .map((p) => (typeof p === 'number' ? `[${p}]` : p))
        .join('.')
        .replace(/\.\[/g, '[');
}

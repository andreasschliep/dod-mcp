/**
 * The `expect` operators (design section 5.3): a fixed, small set, exactly one per
 * criterion. Deterministic; no expressions or patterns from YAML.
 */
import type { Expect, Scalar } from '../dod/model.ts';

export type ExpectOutcome =
  { ok: true } | { ok: false; kind: 'not_met' | 'invalid'; message: string };

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch for an ISO 8601 timestamp with time zone, else undefined. */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function describeExpect(expect: Expect): string {
  const field = expect.field ? `${expect.field} ` : '';
  if (expect.equals !== undefined) return `${field}= ${JSON.stringify(expect.equals)}`;
  if (expect.one_of !== undefined)
    return `${field}one of ${expect.one_of.map((v) => JSON.stringify(v)).join(', ')}`;
  if (expect.min !== undefined) return `${field}≥ ${expect.min}`;
  if (expect.max !== undefined) return `${field}≤ ${expect.max}`;
  if (expect.present !== undefined) return `${field}present`.trim();
  return `${field}not after ${expect.not_after ?? '?'}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export function evaluateExpect(expect: Expect, raw: unknown): ExpectOutcome {
  let value: unknown = raw;
  if (expect.field !== undefined) {
    if (!isObject(raw) || !Object.hasOwn(raw, expect.field)) {
      return {
        ok: false,
        kind: 'invalid',
        message: `The raw value has no field "${expect.field}".`,
      };
    }
    value = raw[expect.field];
  }
  const label = expect.field ?? 'value';

  if (expect.equals !== undefined) {
    if (!isScalar(value) || typeof value !== typeof expect.equals) {
      return {
        ok: false,
        kind: 'invalid',
        message: `${label} is ${show(value)}; expected a ${typeof expect.equals}.`,
      };
    }
    return value === expect.equals
      ? { ok: true }
      : {
          ok: false,
          kind: 'not_met',
          message: `${label} is ${show(value)}, expected ${show(expect.equals)}.`,
        };
  }

  if (expect.one_of !== undefined) {
    if (!isScalar(value)) {
      return {
        ok: false,
        kind: 'invalid',
        message: `${label} is ${show(value)}; expected a single value.`,
      };
    }
    return expect.one_of.includes(value)
      ? { ok: true }
      : {
          ok: false,
          kind: 'not_met',
          message: `${label} is ${show(value)}, expected one of ${expect.one_of.map(show).join(', ')}.`,
        };
  }

  if (expect.min !== undefined || expect.max !== undefined) {
    const n = typeof value === 'number' ? value : Array.isArray(value) ? value.length : undefined;
    if (n === undefined || Number.isNaN(n)) {
      return {
        ok: false,
        kind: 'invalid',
        message: `${label} is ${show(value)}; expected a number or a list.`,
      };
    }
    const what = Array.isArray(value) ? `${label} has ${n} entries` : `${label} is ${n}`;
    if (expect.min !== undefined && n < expect.min) {
      return { ok: false, kind: 'not_met', message: `${what}, expected at least ${expect.min}.` };
    }
    if (expect.max !== undefined && n > expect.max) {
      return { ok: false, kind: 'not_met', message: `${what}, expected at most ${expect.max}.` };
    }
    return { ok: true };
  }

  if (expect.present !== undefined) {
    const empty =
      value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && value.length === 0) ||
      (isObject(value) && Object.keys(value).length === 0);
    return empty ? { ok: false, kind: 'not_met', message: `${label} is empty.` } : { ok: true };
  }

  // not_after: both fields are timestamps with time zone.
  const other = expect.not_after!;
  const limitRaw = isObject(raw) ? raw[other] : undefined;
  const at = parseTimestamp(value);
  const limit = parseTimestamp(limitRaw);
  if (at === undefined || limit === undefined) {
    const which = at === undefined ? label : other;
    return {
      ok: false,
      kind: 'invalid',
      message: `${which} must be an ISO 8601 timestamp with time zone.`,
    };
  }
  return at <= limit
    ? { ok: true }
    : {
        ok: false,
        kind: 'not_met',
        message: `${label} ${String(value)} is after ${other} ${String(limitRaw)}.`,
      };
}

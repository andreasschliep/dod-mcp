/**
 * check_dod (design section 8.2): the agent passes evidence it collected through the
 * official servers; the server checks form, age, revision and value per criterion and
 * reports met / not_met / needs_judgment. There is no overall status: whether the item
 * is done is the team's decision.
 */
import type { MergedCriterion, MergedDod } from '../dod/merge.ts';
import type { Resolution } from '../dod/resolve.ts';
import { rubricUri } from '../dod/view.ts';
import { describeExpect, evaluateExpect, parseTimestamp } from './expect.ts';

export interface EvidenceInput {
  criterion: string;
  source: string;
  tool: string;
  arguments?: Record<string, unknown> | undefined;
  retrieved_at: string;
  raw?: unknown;
  ref?: string | undefined;
  link?: string | undefined;
}

export interface ItemInput {
  id: string;
  type?: string | undefined;
  ticket_type?: string | undefined;
  labels?: string[] | undefined;
  ref?: string | undefined;
}

export interface CheckInput {
  item: ItemInput;
  evidence: EvidenceInput[];
  as_of?: string | undefined;
}

export type Status = 'met' | 'not_met' | 'needs_judgment';

export type FindingCode =
  | 'evidence_missing'
  | 'attestation_missing'
  | 'evidence_invalid'
  | 'evidence_stale'
  | 'ref_missing'
  | 'evidence_other_ref'
  | 'expectation_not_met'
  | 'role_mismatch'
  | 'unexpected_source'
  | 'multiple_evidence';

export interface Finding {
  code: FindingCode;
  message: string;
}

export interface EvidenceView {
  index: number;
  source: string;
  tool: string;
  retrieved_at: string;
  age_hours?: number;
  raw: string;
  ref?: string;
  link?: string;
}

export type WhoDecides = 'server' | 'model_then_team' | 'role';

export interface CriterionResult {
  id: string;
  origin: string;
  check: MergedCriterion['check'];
  text: string;
  status: Status;
  findings: Finding[];
  evidence?: EvidenceView;
  material?: EvidenceView[];
  hint?: string;
  question?: string;
  rubric?: string;
  role?: string;
  who_decides: WhoDecides;
}

export interface CheckResult {
  item: { id: string; ref?: string };
  type: string;
  dod_version: string;
  resolution: { via: Resolution['via']; candidates: string[] };
  as_of: string;
  summary: { criteria: number; met: number; not_met: number; needs_judgment: number };
  criteria: CriterionResult[];
  unused_evidence: { index: number; criterion: string; reason: 'unknown_criterion' }[];
  limits: string[];
}

export const RAW_OUTPUT_CHARS = 200;
export const RAW_INPUT_BYTES = 10 * 1024;

const NOT_MET: ReadonlySet<FindingCode> = new Set([
  'evidence_missing',
  'attestation_missing',
  'evidence_invalid',
  'evidence_stale',
  'ref_missing',
  'evidence_other_ref',
  'expectation_not_met',
  'role_mismatch',
]);

export const CHECK_LIMITS = [
  'Evidence comes from the agent; the server checks its form, age, revision and value, not its authenticity.',
  'The server does not verify who gave a confirmation; raw.by only has to be set.',
];

/** The tool name after the last ":" or "__": clients name their servers themselves. */
export function toolName(tool: string): string {
  return tool.split(/__|:/).pop()?.trim() ?? tool;
}

/** Equal, or one a prefix of the other from 7 characters (short and long commit hashes). */
export function sameRef(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export function checkDod(
  dod: MergedDod,
  resolution: Resolution,
  input: CheckInput,
  now: Date,
): CheckResult {
  const asOf = input.as_of ?? now.toISOString();
  const asOfMs = parseTimestamp(asOf) ?? now.getTime();
  const ids = new Set(dod.criteria.map((c) => c.id));
  const byCriterion = new Map<string, { index: number; ev: EvidenceInput }[]>();
  const unused: CheckResult['unused_evidence'] = [];
  input.evidence.forEach((ev, index) => {
    if (!ids.has(ev.criterion)) {
      unused.push({ index, criterion: ev.criterion, reason: 'unknown_criterion' });
      return;
    }
    const list = byCriterion.get(ev.criterion) ?? [];
    list.push({ index, ev });
    byCriterion.set(ev.criterion, list);
  });

  const criteria = dod.criteria.map((c) =>
    evaluateCriterion(c, dod.type, byCriterion.get(c.id) ?? [], input.item, asOfMs),
  );
  const count = (s: Status) => criteria.filter((c) => c.status === s).length;
  const item: CheckResult['item'] = { id: input.item.id };
  if (input.item.ref !== undefined) item.ref = input.item.ref;
  return {
    item,
    type: dod.type,
    dod_version: dod.dod_version,
    resolution: { via: resolution.via, candidates: resolution.candidates },
    as_of: asOf,
    summary: {
      criteria: criteria.length,
      met: count('met'),
      not_met: count('not_met'),
      needs_judgment: count('needs_judgment'),
    },
    criteria,
    unused_evidence: unused,
    limits: CHECK_LIMITS,
  };
}

function evaluateCriterion(
  c: MergedCriterion,
  type: string,
  entries: { index: number; ev: EvidenceInput }[],
  item: ItemInput,
  asOfMs: number,
): CriterionResult {
  const base = { id: c.id, origin: c.origin, check: c.check, text: c.text };

  if (c.check === 'judgment') {
    const result: CriterionResult = {
      ...base,
      status: 'needs_judgment',
      findings: [],
      question: c.question,
      rubric: rubricUri(type),
      who_decides: 'model_then_team',
    };
    if (entries.length > 0) result.material = entries.map((e) => view(e.index, e.ev, asOfMs));
    return result;
  }

  const result: CriterionResult = {
    ...base,
    status: 'met',
    findings: [],
    who_decides: c.check === 'evidence' ? 'server' : 'role',
  };
  if (c.check === 'attestation') result.role = c.role;

  if (entries.length === 0) {
    const finding: Finding =
      c.check === 'attestation'
        ? { code: 'attestation_missing', message: `No confirmation by the role ${c.role}.` }
        : { code: 'evidence_missing', message: `No evidence from ${c.source}.` };
    const hint = hintFor(finding, c, item);
    return { ...result, status: 'not_met', findings: [finding], ...(hint ? { hint } : {}) };
  }

  const decisive = pickDecisive(entries);
  const { ev } = decisive;
  result.evidence = view(decisive.index, ev, asOfMs);
  const findings = result.findings;
  if (entries.length > 1) {
    findings.push({
      code: 'multiple_evidence',
      message: `${entries.length} pieces of evidence; the most recent one decides (index ${decisive.index}), the others are ${entries
        .filter((e) => e !== decisive)
        .map((e) => e.index)
        .join(', ')}.`,
    });
  }

  const at = parseTimestamp(ev.retrieved_at);
  if (at === undefined) {
    findings.push({
      code: 'evidence_invalid',
      message: `retrieved_at "${ev.retrieved_at}" is not an ISO 8601 timestamp with time zone.`,
    });
  } else if (at > asOfMs) {
    findings.push({ code: 'evidence_invalid', message: 'retrieved_at lies after as_of.' });
  } else if (c.max_age_hours !== undefined && (asOfMs - at) / 3_600_000 > c.max_age_hours) {
    findings.push({
      code: 'evidence_stale',
      message: `The evidence is ${hours(asOfMs - at)} h old; at most ${c.max_age_hours} h are allowed.`,
    });
  }

  const rawText = JSON.stringify(ev.raw) ?? 'undefined';
  const rawTooLarge = Buffer.byteLength(rawText) > RAW_INPUT_BYTES;
  if (rawTooLarge) {
    findings.push({ code: 'evidence_invalid', message: 'The raw value is larger than 10 KB.' });
  }

  if (c.check === 'evidence') {
    if (c.same_ref) {
      if (!item.ref || !ev.ref) {
        findings.push({
          code: 'ref_missing',
          message: !item.ref
            ? 'The criterion needs the item revision, but item.ref is missing.'
            : 'The criterion needs the revision of the evidence, but ref is missing.',
        });
      } else if (!sameRef(item.ref, ev.ref)) {
        findings.push({
          code: 'evidence_other_ref',
          message: `The evidence belongs to ${ev.ref}; the item is at ${item.ref}.`,
        });
      }
    }
    if (!rawTooLarge) {
      const outcome = evaluateExpect(c.expect, ev.raw);
      if (!outcome.ok) {
        findings.push({
          code: outcome.kind === 'invalid' ? 'evidence_invalid' : 'expectation_not_met',
          message:
            outcome.kind === 'invalid'
              ? `${outcome.message} Expected: ${describeExpect(c.expect)}.`
              : outcome.message,
        });
      }
    }
  } else if (!rawTooLarge) {
    const raw = ev.raw;
    const role = isObject(raw) && typeof raw.role === 'string' ? raw.role.trim() : undefined;
    const by = isObject(raw) && typeof raw.by === 'string' ? raw.by.trim() : '';
    if (!isObject(raw)) {
      findings.push({
        code: 'evidence_invalid',
        message: 'A confirmation needs a raw value { role, by }.',
      });
    } else if (role === undefined || role.toLowerCase() !== c.role.toLowerCase() || by === '') {
      findings.push({
        code: 'role_mismatch',
        message:
          by === ''
            ? 'The confirmation does not say who gave it (raw.by).'
            : `Confirmed by the role ${role ?? '(none)'}; required is ${c.role}.`,
      });
    }
  }

  if (c.fetch_with && c.fetch_with.length > 0) {
    const expected = c.fetch_with.map(toolName);
    if (!expected.includes(toolName(ev.tool))) {
      findings.push({
        code: 'unexpected_source',
        message: `The evidence comes from ${ev.tool}; the DoD expects ${expected.join(' or ')}.`,
      });
    }
  }

  const blocking = findings.find((f) => NOT_MET.has(f.code));
  if (blocking) {
    result.status = 'not_met';
    const hint = hintFor(blocking, c, item);
    if (hint) result.hint = hint;
  } else if (findings.some((f) => f.code === 'unexpected_source')) {
    result.status = 'needs_judgment';
    result.hint = 'A person decides whether this source is equivalent to the one the DoD names.';
  }
  return result;
}

function pickDecisive(entries: { index: number; ev: EvidenceInput }[]): {
  index: number;
  ev: EvidenceInput;
} {
  let best: { index: number; ev: EvidenceInput; at: number } | undefined;
  for (const entry of entries) {
    const at = parseTimestamp(entry.ev.retrieved_at);
    if (at === undefined) continue;
    if (!best || at >= best.at) best = { ...entry, at };
  }
  return best ?? entries[0]!;
}

function hintFor(finding: Finding, c: MergedCriterion, item: ItemInput): string | undefined {
  if (c.check === 'judgment') return undefined;
  const code = finding.code;
  const tools = (c.fetch_with ?? []).map(toolName);
  const fetch =
    tools.length > 0
      ? `Fetch with ${tools.join(' or ')}`
      : `Fetch it from ${c.check === 'evidence' ? c.source : 'the ticket'}`;
  const forRef = c.check === 'evidence' && c.same_ref && item.ref ? ` for commit ${item.ref}` : '';
  switch (code) {
    case 'evidence_missing':
    case 'evidence_stale':
    case 'evidence_other_ref':
      return `${fetch}${forRef}.`;
    case 'ref_missing':
      return item.ref
        ? `${fetch}${forRef}, with the commit as ref.`
        : 'Pass item.ref, the commit the item is at.';
    case 'attestation_missing':
      return `Ask the role ${c.check === 'attestation' ? c.role : ''} to confirm; the agent does not confirm on its own.`;
    case 'role_mismatch':
      return `The confirmation must come from the role ${c.check === 'attestation' ? c.role : ''} and name who gave it.`;
    case 'evidence_invalid':
      if (finding.message.startsWith('retrieved_at')) {
        return 'Pass retrieved_at as ISO 8601 with time zone, e.g. 2026-11-14T09:30:00Z, no later than as_of.';
      }
      return c.check === 'evidence'
        ? `Pass raw exactly as the tool returned it; the DoD expects ${describeExpect(c.expect)}.`
        : 'Pass raw as { role, by } from the confirmation in the ticket.';
    default:
      return undefined;
  }
}

function view(index: number, ev: EvidenceInput, asOfMs: number): EvidenceView {
  const raw = JSON.stringify(ev.raw) ?? 'undefined';
  const v: EvidenceView = {
    index,
    source: ev.source,
    tool: ev.tool,
    retrieved_at: ev.retrieved_at,
    raw: raw.length > RAW_OUTPUT_CHARS ? `${raw.slice(0, RAW_OUTPUT_CHARS - 1)}…` : raw,
  };
  const at = parseTimestamp(ev.retrieved_at);
  if (at !== undefined && at <= asOfMs) v.age_hours = hours(asOfMs - at);
  if (ev.ref !== undefined) v.ref = ev.ref;
  if (ev.link !== undefined) v.link = ev.link;
  return v;
}

function hours(ms: number): number {
  return Math.round((ms / 3_600_000) * 10) / 10;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * check_dod (design section 8.2): each finding on its own, the example evidence, and
 * reproducibility with as_of.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  checkDod,
  sameRef,
  toolName,
  type CheckInput,
  type EvidenceInput,
} from '../src/check/checkDod.ts';
import { evaluateExpect } from '../src/check/expect.ts';
import { loadDodSet } from '../src/dod/load.ts';
import { resolveType } from '../src/dod/resolve.ts';
import { requireDod } from '../src/dod/view.ts';
import { EXAMPLE_DOD } from './helpers.ts';

const set = loadDodSet(EXAMPLE_DOD);
const NOW = new Date('2026-11-14T10:00:00Z');
const AS_OF = '2026-11-14T10:00:00Z';

function example(name: string): CheckInput {
  const path = fileURLToPath(new URL(`../examples/evidence/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as CheckInput;
}

function run(input: CheckInput) {
  const resolution = resolveType(set, input.item);
  return checkDod(requireDod(set, resolution.type), resolution, input, NOW);
}

function criterion(input: CheckInput, id: string) {
  const c = run(input).criteria.find((x) => x.id === id);
  assert.ok(c, id);
  return c;
}

const gate = (overrides: Partial<EvidenceInput> = {}): EvidenceInput => ({
  criterion: 'QUALITY-GATE',
  source: 'sonarqube',
  tool: 'sonarqube:get_project_quality_gate_status',
  retrieved_at: '2026-11-14T09:00:00Z',
  raw: { status: 'OK' },
  ref: '9f2c1ab',
  ...overrides,
});

const story = (evidence: EvidenceInput[], ref: string | null = '9f2c1ab'): CheckInput => ({
  item: { id: 'DEMO-1', ticket_type: 'Story', ...(ref ? { ref } : {}) },
  evidence,
  as_of: AS_OF,
});

test('example with gaps: 4 met, 3 not met, 2 need judgment', () => {
  const result = run(example('software-dev-gaps'));
  assert.equal(result.dod_version, 'software-dev@4+base@3');
  assert.deepEqual(result.summary, { criteria: 9, met: 4, not_met: 3, needs_judgment: 2 });
  const status = Object.fromEntries(
    result.criteria.map((c) => [c.id, [c.status, c.findings.map((f) => f.code)]]),
  );
  assert.deepEqual(status['QUALITY-GATE'], ['not_met', ['evidence_other_ref']]);
  assert.deepEqual(status.TESTS, ['not_met', ['evidence_stale']]);
  assert.deepEqual(status['ZWEITE-PERSON'], ['not_met', ['attestation_missing']]);
  assert.deepEqual(status.RUNBOOK, ['met', []]);
  const gateResult = result.criteria.find((c) => c.id === 'QUALITY-GATE')!;
  assert.equal(gateResult.hint, 'Fetch with get_project_quality_gate_status for commit 9f2c1ab.');
  assert.equal(gateResult.who_decides, 'server');
});

test('example with every gap closed: only the judgment criteria stay open', () => {
  const result = run(example('software-dev-complete'));
  assert.deepEqual(result.summary, { criteria: 9, met: 7, not_met: 0, needs_judgment: 2 });
  for (const c of result.criteria.filter((x) => x.check === 'judgment')) {
    assert.equal(c.who_decides, 'model_then_team');
    assert.equal(c.rubric, 'rubric://dod/software-dev');
    assert.ok(c.question);
  }
});

test('customer request: answer too late, wrong role, evidence for an unknown criterion', () => {
  const result = run(example('kundenanfrage-gaps'));
  const frist = result.criteria.find((c) => c.id === 'FRIST')!;
  assert.equal(frist.status, 'not_met');
  assert.equal(frist.findings[0]!.code, 'expectation_not_met');
  assert.match(frist.findings[0]!.message, /first_response_at .* is after due_at/);
  const zusage = result.criteria.find((c) => c.id === 'ZUSAGE')!;
  assert.deepEqual([zusage.status, zusage.findings[0]!.code], ['not_met', 'role_mismatch']);
  assert.match(
    zusage.findings[0]!.message,
    /Confirmed by the role Teammitglied; required is Vertrieb/,
  );
  assert.deepEqual(result.unused_evidence, [
    { index: 4, criterion: 'QUALITY-GATE', reason: 'unknown_criterion' },
  ]);
});

test('document: unexpected source needs judgment, wrong raw shape is invalid', () => {
  const result = run(example('dokument-gaps'));
  const links = result.criteria.find((c) => c.id === 'LINKS')!;
  assert.deepEqual(
    [links.status, links.findings.map((f) => f.code)],
    ['needs_judgment', ['unexpected_source']],
  );
  const linked = result.criteria.find((c) => c.id === 'ERGEBNIS-VERLINKT')!;
  assert.deepEqual([linked.status, linked.findings[0]!.code], ['not_met', 'evidence_invalid']);
  assert.match(linked.hint ?? '', /the DoD expects result_links present/);
  assert.equal(
    result.criteria.find((c) => c.id === 'FACHFREIGABE')!.findings[0]!.code,
    'attestation_missing',
  );
});

test('missing evidence is not_met with a hint naming the tool (F1)', () => {
  const c = criterion(story([]), 'BUILD');
  assert.deepEqual([c.status, c.findings[0]!.code], ['not_met', 'evidence_missing']);
  assert.equal(c.hint, 'Fetch with get_build for commit 9f2c1ab.');
});

test('a ref is needed on both sides; short and long hashes match', () => {
  const noItemRef = criterion(story([gate()], null), 'QUALITY-GATE');
  assert.equal(noItemRef.findings[0]!.code, 'ref_missing');
  assert.equal(noItemRef.hint, 'Pass item.ref, the commit the item is at.');
  assert.equal(
    criterion(story([gate({ ref: undefined })]), 'QUALITY-GATE').findings[0]!.code,
    'ref_missing',
  );
  assert.equal(criterion(story([gate({ ref: '9F2C1AB0D3E4' })]), 'QUALITY-GATE').status, 'met');
  assert.equal(sameRef('9f2c1a', '9f2c1ab'), false);
});

test('timestamps: without zone or after as_of is invalid, older than allowed is stale', () => {
  const noZone = criterion(story([gate({ retrieved_at: '2026-11-14T09:00:00' })]), 'QUALITY-GATE');
  assert.equal(noZone.findings[0]!.code, 'evidence_invalid');
  assert.match(noZone.hint ?? '', /ISO 8601 with time zone/);
  const future = criterion(story([gate({ retrieved_at: '2026-11-14T10:00:01Z' })]), 'QUALITY-GATE');
  assert.equal(future.findings[0]!.code, 'evidence_invalid');
  const stale = criterion(story([gate({ retrieved_at: '2026-11-13T09:59:00Z' })]), 'QUALITY-GATE');
  assert.equal(stale.findings[0]!.code, 'evidence_stale');
  assert.match(stale.findings[0]!.message, /24 h old; at most 24 h/);
  const offset = criterion(
    story([gate({ retrieved_at: '2026-11-14T10:30:00+01:00' })]),
    'QUALITY-GATE',
  );
  assert.equal(offset.status, 'met');
});

test('the most recent evidence decides; the others are named', () => {
  const c = criterion(
    story([
      gate({ raw: { status: 'ERROR' }, retrieved_at: '2026-11-14T09:30:00Z' }),
      gate({ retrieved_at: '2026-11-14T08:00:00Z' }),
    ]),
    'QUALITY-GATE',
  );
  assert.equal(c.status, 'not_met');
  assert.equal(c.evidence?.index, 0);
  assert.deepEqual(
    c.findings.map((f) => f.code),
    ['multiple_evidence', 'expectation_not_met'],
  );
});

test('tool names match after the last ":" or "__"', () => {
  assert.equal(
    toolName('mcp__sonarqube__get_project_quality_gate_status'),
    'get_project_quality_gate_status',
  );
  assert.equal(
    toolName('sonar:get_project_quality_gate_status'),
    'get_project_quality_gate_status',
  );
  assert.equal(
    criterion(story([gate({ tool: 'get_project_quality_gate_status' })]), 'QUALITY-GATE').status,
    'met',
  );
  const other = criterion(story([gate({ tool: 'ci:quality_report' })]), 'QUALITY-GATE');
  assert.deepEqual(
    [other.status, other.findings[0]!.code],
    ['needs_judgment', 'unexpected_source'],
  );
});

test('raw values over 10 KB are invalid; output raw is cut to 200 characters', () => {
  const big = criterion(
    story([gate({ raw: { status: 'OK', log: 'x'.repeat(11 * 1024) } })]),
    'QUALITY-GATE',
  );
  assert.equal(big.findings[0]!.code, 'evidence_invalid');
  assert.ok((big.evidence?.raw.length ?? 0) <= 200);
});

test('expect operators', () => {
  assert.deepEqual(evaluateExpect({ field: 'status', equals: 'OK' }, { status: 'OK' }), {
    ok: true,
  });
  assert.equal(evaluateExpect({ field: 'status', equals: 'OK' }, { status: 1 }).ok, false);
  assert.deepEqual(evaluateExpect({ one_of: ['a', 'b'] }, 'b'), { ok: true });
  assert.deepEqual(evaluateExpect({ min: 2 }, ['x', 'y']), { ok: true });
  const max = evaluateExpect({ field: 'failed', max: 0 }, { failed: 3 });
  assert.ok(
    !max.ok && max.kind === 'not_met' && /failed is 3, expected at most 0/.test(max.message),
  );
  assert.equal(evaluateExpect({ present: true }, []).ok, false);
  assert.equal(evaluateExpect({ present: true }, 'x').ok, true);
  const missing = evaluateExpect({ field: 'status', equals: 'OK' }, 'OK');
  assert.ok(!missing.ok && missing.kind === 'invalid');
  const notAfter = evaluateExpect(
    { field: 'at', not_after: 'due' },
    { at: '2026-01-01T10:00:00Z', due: 'tomorrow' },
  );
  assert.ok(!notAfter.ok && notAfter.kind === 'invalid' && /due must be/.test(notAfter.message));
});

test('same input and as_of give the same output, whatever the clock says', () => {
  const input = example('software-dev-gaps');
  const resolution = resolveType(set, input.item);
  const dod = requireDod(set, resolution.type);
  const a = checkDod(dod, resolution, input, new Date('2026-11-14T10:00:00Z'));
  const b = checkDod(dod, resolution, input, new Date('2030-01-01T00:00:00Z'));
  assert.deepEqual(a, b);
  const withoutAsOf = checkDod(
    dod,
    resolution,
    { ...input, as_of: undefined },
    new Date('2026-11-14T10:00:00Z'),
  );
  assert.equal(withoutAsOf.as_of, '2026-11-14T10:00:00.000Z');
});

test('output budget: check_dod on software-dev stays under 8,000 tokens', () => {
  const json = JSON.stringify(run(example('software-dev-gaps')));
  assert.ok(json.length / 4 < 8000, `${json.length / 4} tokens`);
});

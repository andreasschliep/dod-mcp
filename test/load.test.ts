/**
 * Phase 1: loading, validation with file and line, and merging (design sections 5 and 15).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/cli/validate.ts';
import { allErrors, DodUnavailableError, loadDodSet, typeErrors } from '../src/dod/load.ts';
import { effectiveDod } from '../src/dod/merge.ts';
import type { DodSet, ValidationError } from '../src/dod/model.ts';
import { EXAMPLE_DOD, lines, tempDod } from './helpers.ts';

function only(errors: ValidationError[], code: string): ValidationError {
  const found = errors.filter((e) => e.code === code);
  assert.equal(found.length, 1, `exactly one ${code} in ${JSON.stringify(errors, null, 2)}`);
  return found[0]!;
}

function errorsOf(set: DodSet, type: string): ValidationError[] {
  return set.types.get(type)?.errors ?? [];
}

const SOFTWARE_HEAD = ['type: software-dev', 'version: 5', 'title: Softwareentwicklung'];

test('the example folder is valid: base, three types and the mapping', () => {
  const set = loadDodSet(EXAMPLE_DOD);
  assert.deepEqual(allErrors(set), []);
  assert.deepEqual([...set.types.keys()], ['dokument', 'kundenanfrage', 'software-dev']);
  assert.equal(set.base.parsed?.version, 3);
  assert.deepEqual(
    set.mapping.parsed?.entries.map((e) => [e.type, e.ticket_types, e.labels]),
    [
      ['software-dev', ['Story', 'Bug'], ['code']],
      ['dokument', ['Dokument'], ['doku']],
      ['kundenanfrage', ['Anfrage'], ['kunde']],
    ],
  );
});

test('merging keeps base criteria first, each with origin, file and line', () => {
  const set = loadDodSet(EXAMPLE_DOD);
  const result = effectiveDod(set, 'software-dev');
  assert.ok(result.ok);
  const { dod } = result;
  assert.equal(dod.dod_version, 'software-dev@4+base@3');
  assert.deepEqual(
    dod.criteria.map((c) => `${c.origin}:${c.id}:${c.check}`),
    [
      'base:ERGEBNIS-VERLINKT:evidence',
      'base:FOLGEARBEIT:judgment',
      'base:ZWEITE-PERSON:attestation',
      'software-dev:QUALITY-GATE:evidence',
      'software-dev:BUILD:evidence',
      'software-dev:TESTS:evidence',
      'software-dev:TESTAENDERUNG-AUSGEWIESEN:evidence',
      'software-dev:KRITERIEN-GETESTET:judgment',
      'software-dev:RUNBOOK:attestation',
    ],
  );
  assert.deepEqual(dod.criteria[0]!.at, { file: 'base.yaml', line: 8, column: 5 });
  assert.deepEqual(dod.criteria[3]!.at, { file: 'software-dev.yaml', line: 9, column: 5 });
  assert.deepEqual(
    dod.rules.map((r) => `${r.origin}:${r.id}`),
    [
      'base:AK-VAGE',
      'software-dev:AK-GWT',
      'software-dev:AK-DANN',
      'software-dev:AK-EINHEIT',
      'software-dev:AK-VAGE-SW',
    ],
  );
  assert.match(dod.template ?? '', /Angenommen/);
});

test('a type that redefines a base criterion is invalid, with both locations', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'criteria:',
      '  - id: ZWEITE-PERSON',
      '    text: Zwei Personen haben es angesehen.',
      '    check: attestation',
      '    role: Teammitglied',
    ),
  });
  const set = loadDodSet(dir);
  const error = only(errorsOf(set, 'software-dev'), 'base_criterion_overridden');
  assert.deepEqual(
    { file: error.file, line: error.line, column: error.column },
    { file: 'software-dev.yaml', line: 6, column: 5 },
  );
  assert.deepEqual(error.related, { file: 'base.yaml', line: 22, column: 5 });
  assert.match(error.message, /ZWEITE-PERSON.*base\.yaml:22.*may only add/);
  assert.equal(effectiveDod(set, 'software-dev').ok, false);
  // Other types keep working (design D5).
  assert.equal(effectiveDod(set, 'dokument').ok, true);
});

test('a type that reuses a base rule id is invalid', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'acceptance:',
      '  rules:',
      '    - id: AK-VAGE',
      '      kind: vague_words',
      '      words: [schnell]',
    ),
  });
  const error = only(errorsOf(loadDodSet(dir), 'software-dev'), 'base_criterion_overridden');
  assert.equal(error.line, 7);
  assert.deepEqual(error.related, { file: 'base.yaml', line: 29, column: 7 });
});

test('removal and override keys are errors at the key', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'remove: [FOLGEARBEIT]',
      'override:',
      '  ZWEITE-PERSON: { role: Betrieb }',
    ),
  });
  const errors = errorsOf(loadDodSet(dir), 'software-dev');
  const removed = only(errors, 'base_criterion_removed');
  assert.equal(removed.line, 5);
  assert.match(removed.message, /"remove" would remove base criteria/);
  assert.equal(only(errors, 'base_criterion_overridden').line, 6);
  assert.equal(errors.filter((e) => e.code === 'unknown_key').length, 0);
});

test('a type without extends: base, or with another value, drops the base and is invalid', () => {
  const missing = errorsOf(
    loadDodSet(tempDod({ 'software-dev.yaml': lines(...SOFTWARE_HEAD, 'criteria: []') })),
    'software-dev',
  );
  assert.equal(only(missing, 'base_criterion_removed').line, 1);

  const other = errorsOf(
    loadDodSet(tempDod({ 'software-dev.yaml': lines(...SOFTWARE_HEAD, 'extends: nothing') })),
    'software-dev',
  );
  const error = only(other, 'base_criterion_removed');
  assert.equal(error.line, 4);
  assert.match(error.message, /must be "base"/);
});

test('a key that fits another check kind says which one', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'criteria:',
      '  - id: BUILD',
      '    text: Der Build ist grün.',
      '    check: evidence',
      '    source: ci.build',
      '    expect: { field: result, equals: succeeded }',
      '    role: Betrieb',
    ),
  });
  const error = only(errorsOf(loadDodSet(dir), 'software-dev'), 'unknown_key');
  assert.equal(error.line, 11);
  assert.match(error.message, /"role" for check: evidence \(it belongs to check: attestation\)/);
});

test('required keys per check kind: judgment without question', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'criteria:',
      '  - id: LESBAR',
      '    text: Der Code ist lesbar.',
      '    check: judgment',
    ),
  });
  const error = only(errorsOf(loadDodSet(dir), 'software-dev'), 'missing_key');
  assert.equal(error.line, 6);
  assert.match(error.message, /"question"/);
});

test('unknown check kind, two operators in expect, duplicate ids', () => {
  const dir = tempDod({
    'software-dev.yaml': lines(
      ...SOFTWARE_HEAD,
      'extends: base',
      'criteria:',
      '  - id: GATE',
      '    text: Gate grün.',
      '    check: evidence',
      '    source: sonarqube',
      '    expect: { field: status, equals: OK, present: true }',
      '  - id: GATE',
      '    text: Noch einmal.',
      '    check: vibe',
    ),
  });
  const errors = errorsOf(loadDodSet(dir), 'software-dev');
  const invalid = errors.filter((e) => e.code === 'invalid_value');
  assert.deepEqual(
    invalid.map((e) => e.line),
    [10, 13],
  );
  assert.match(invalid[0]!.message, /exactly one operator.*found equals, present/);
  assert.match(invalid[1]!.message, /check must be one of evidence, judgment, attestation/);
  const duplicate = only(errors, 'duplicate_id');
  assert.equal(duplicate.line, 11);
  assert.equal(duplicate.related?.line, 6);
});

test('YAML syntax errors and alias bombs are reported, not thrown', () => {
  const syntax = errorsOf(
    loadDodSet(tempDod({ 'software-dev.yaml': lines(...SOFTWARE_HEAD, 'criteria: [unclosed') })),
    'software-dev',
  );
  assert.ok(syntax.length > 0 && syntax.every((e) => e.code === 'yaml_syntax'));
  assert.equal(syntax[0]!.file, 'software-dev.yaml');

  const bomb = [
    'type: software-dev',
    'version: 1',
    'title: Bombe',
    'extends: base',
    'a: &a [x, x, x, x, x, x, x, x, x, x]',
    'b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'd: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c, *c]',
  ];
  const errors = errorsOf(
    loadDodSet(tempDod({ 'software-dev.yaml': lines(...bomb) })),
    'software-dev',
  );
  assert.equal(only(errors, 'yaml_syntax').line, 1);
});

test('type name must equal the file name, and the file name must fit the pattern', () => {
  const set = loadDodSet(
    tempDod({
      'einkauf.yaml': lines('type: beschaffung', 'version: 1', 'title: Einkauf', 'extends: base'),
      'Neuer_Typ.yaml': lines('type: Neuer_Typ', 'version: 1', 'title: Neu', 'extends: base'),
    }),
  );
  const mismatch = only(errorsOf(set, 'einkauf'), 'type_name_mismatch');
  assert.equal(mismatch.line, 1);
  assert.match(mismatch.message, /must be "einkauf"/);
  assert.equal(only(errorsOf(set, 'Neuer_Typ'), 'type_name_mismatch').file, 'Neuer_Typ.yaml');
});

test('types.yaml: a label for two types and a mapping without type file are invalid', () => {
  const set = loadDodSet(
    tempDod({
      'types.yaml': lines(
        'version: 2',
        'mappings:',
        '  software-dev: { ticket_types: [Story], labels: [code] }',
        '  dokument: { ticket_types: [Dokument], labels: [Code] }',
        '  einkauf: { ticket_types: [Bestellung] }',
      ),
    }),
  );
  const errors = set.mapping.errors;
  assert.equal(set.mapping.parsed, null);
  const twice = errors.find((e) => e.message.includes('"Code"'));
  assert.equal(twice?.line, 4);
  assert.equal(twice?.related?.line, 3);
  const unknown = errors.find((e) => e.message.includes('einkauf.yaml'));
  assert.equal(unknown?.line, 5);
  assert.ok(errors.every((e) => e.code === 'invalid_mapping'));
  // The type files themselves stay valid; only resolution by ticket data stops.
  assert.equal(effectiveDod(set, 'software-dev').ok, true);
});

test('a missing types.yaml is a mapping error, not a reason to stop', () => {
  const set = loadDodSet(tempDod({ 'types.yaml': null }));
  assert.equal(only(set.mapping.errors, 'invalid_mapping').file, 'types.yaml');
  assert.equal(effectiveDod(set, 'kundenanfrage').ok, true);
});

test('an invalid base makes every type invalid', () => {
  const set = loadDodSet(
    tempDod({ 'base.yaml': lines('type: base', 'version: 3', 'title: Basis', 'criteria: 7') }),
  );
  for (const type of set.types.keys()) {
    assert.equal(effectiveDod(set, type).ok, false, type);
    assert.ok(
      typeErrors(set, type).some((e) => e.file === 'base.yaml'),
      type,
    );
  }
});

test('a new type is a new file, without code changes', () => {
  const dir = tempDod({
    'einkauf.yaml': lines(
      '# FICTIONAL EXAMPLE',
      'type: einkauf',
      'version: 1',
      'title: Einkauf',
      'extends: base',
      'criteria:',
      '  - id: ANGEBOTE',
      '    text: Es liegen drei Angebote vor.',
      '    check: evidence',
      '    source: einkauf.angebote',
      '    expect: { field: offers, min: 3 }',
    ),
  });
  const set = loadDodSet(dir);
  assert.deepEqual(allErrors(set), []);
  const result = effectiveDod(set, 'einkauf');
  assert.ok(result.ok);
  assert.equal(result.dod.dod_version, 'einkauf@1+base@3');
  assert.deepEqual(
    result.dod.criteria.map((c) => c.id),
    ['ERGEBNIS-VERLINKT', 'FOLGEARBEIT', 'ZWEITE-PERSON', 'ANGEBOTE'],
  );
});

test('files over 100 KB are refused', () => {
  const dir = tempDod();
  writeFileSync(join(dir, 'dokument.yaml'), `# ${'x'.repeat(101 * 1024)}\n`);
  const error = only(errorsOf(loadDodSet(dir), 'dokument'), 'invalid_value');
  assert.match(error.message, /larger than 100 KB/);
});

test('a missing folder or base.yaml makes the DoD unavailable', () => {
  assert.throws(() => loadDodSet(join(EXAMPLE_DOD, 'does-not-exist')), DodUnavailableError);
  assert.throws(() => loadDodSet(tempDod({ 'base.yaml': null })), /no base\.yaml/);
});

test('dod-validate prints file:line:column and exits 0, 1 or 2', (t) => {
  const out: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => out.push(args.join(' ')));
  const err = t.mock.method(console, 'error', () => {});

  assert.equal(run([EXAMPLE_DOD]), 0);
  assert.ok(out.some((l) => l.endsWith('no errors')));

  out.length = 0;
  const dir = tempDod({
    'software-dev.yaml': lines(...SOFTWARE_HEAD, 'extends: base', 'remove: [FOLGEARBEIT]'),
  });
  assert.equal(run([dir]), 1);
  assert.ok(
    out.includes(
      'software-dev.yaml:5:1 base_criterion_removed: "remove" would remove base criteria. A type may only add to the base.',
    ),
    out.join('\n'),
  );
  assert.ok(out.some((l) => l.endsWith('1 error')));

  assert.equal(run([join(dir, 'missing')]), 2);
  assert.equal(err.mock.callCount(), 1);
});

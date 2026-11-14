/**
 * Type resolution (design section 7): exactly one candidate, no default type.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDodSet } from '../src/dod/load.ts';
import { resolveType } from '../src/dod/resolve.ts';
import { DomainError } from '../src/errors.ts';
import { EXAMPLE_DOD, tempDod } from './helpers.ts';

const set = loadDodSet(EXAMPLE_DOD);

function fails(input: Parameters<typeof resolveType>[1], code: string, hint?: RegExp): DomainError {
  try {
    resolveType(set, input);
  } catch (error) {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, code);
    if (hint) assert.match(error.hint, hint);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test('one ticket type gives one type; case and whitespace do not matter', () => {
  assert.deepEqual(resolveType(set, { ticket_type: ' story ' }), {
    type: 'software-dev',
    via: 'ticket_type',
    candidates: ['software-dev'],
    triggers: [{ via: 'ticket_type', value: 'story', type: 'software-dev' }],
  });
});

test('a label alone is enough; labels without mapping are ignored', () => {
  const r = resolveType(set, { ticket_type: 'Task', labels: ['frontend', 'doku'] });
  assert.equal(r.type, 'dokument');
  assert.equal(r.via, 'label');
});

test('unknown ticket data is unknown_type with the known names in the hint', () => {
  fails(
    { ticket_type: 'Epic' },
    'unknown_type',
    /Known ticket types: Story, Bug, Dokument, Anfrage\. Known labels: code, doku, kunde\./,
  );
});

test('two candidates are ambiguous_type, naming what triggered each', () => {
  const error = fails(
    { ticket_type: 'Story', labels: ['doku'] },
    'ambiguous_type',
    /software-dev, dokument/,
  );
  assert.match(error.message, /Story → software-dev, doku → dokument/);
});

test('an explicit type resolves an ambiguity when it is a candidate (F2)', () => {
  const r = resolveType(set, { type: 'dokument', ticket_type: 'Story', labels: ['doku'] });
  assert.deepEqual(
    [r.type, r.via, r.candidates],
    ['dokument', 'explicit', ['software-dev', 'dokument']],
  );
});

test('an explicit type that the ticket contradicts is type_conflict', () => {
  fails({ type: 'kundenanfrage', ticket_type: 'Story' }, 'type_conflict', /software-dev/);
});

test('an explicit type without file is unknown_type; nothing at all is type_missing', () => {
  fails({ type: 'einkauf' }, 'unknown_type', /Known types: dokument, kundenanfrage, software-dev/);
  fails({}, 'type_missing');
  fails({ ticket_type: '  ', labels: [] }, 'type_missing');
});

test('an invalid types.yaml stops resolution by ticket data, not an explicit type', () => {
  const broken = loadDodSet(tempDod({ 'types.yaml': 'version: 1\nmappings: 7\n' }));
  assert.throws(
    () => resolveType(broken, { ticket_type: 'Story' }),
    (e: unknown) => {
      return (
        e instanceof DomainError && e.code === 'invalid_dod' && /types\.yaml:2/.test(e.message)
      );
    },
  );
  assert.equal(
    resolveType(broken, { type: 'software-dev', ticket_type: 'Story' }).type,
    'software-dev',
  );
});

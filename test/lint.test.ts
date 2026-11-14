/**
 * lint_acceptance_criteria (design section 8.3): findings at known lines per type, clean
 * texts without findings, and the number rule's edge cases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDodSet } from '../src/dod/load.ts';
import { requireDod } from '../src/dod/view.ts';
import { parseScenarios } from '../src/lint/gherkin.ts';
import { lintAcceptance } from '../src/lint/lint.ts';
import { numbersWithoutUnit } from '../src/lint/numbers.ts';

const set = loadDodSet(fileURLToPath(new URL('../dod', import.meta.url)));

function lint(type: string, file: string) {
  const text = readFileSync(
    fileURLToPath(new URL(`../examples/acceptance/${file}.md`, import.meta.url)),
    'utf8',
  );
  return lintAcceptance(text, type, requireDod(set, type).rules);
}

function brief(result: ReturnType<typeof lint>): string[] {
  return result.findings.map((f) => `${f.line}:${f.column} ${f.rule} ${f.code}`);
}

test('software-dev: vague words, unobservable Then, incomplete scenarios, a number without unit', () => {
  const result = lint('software-dev', 'software-dev');
  assert.deepEqual(brief(result), [
    '4:30 AK-VAGE-SW vague_word',
    '5:18 AK-DANN unobservable_then',
    '7:1 AK-GWT incomplete_scenario',
    '9:32 AK-EINHEIT number_without_unit',
    '11:1 AK-GWT incomplete_scenario',
    '13:32 AK-VAGE vague_word',
  ]);
  assert.deepEqual(result.summary, { error: 2, warning: 4 });
  const incomplete = result.findings.find((f) => f.line === 7)!;
  assert.match(incomplete.message, /"Warenkorb mit vielen Artikeln" has no When \(Wenn\)/);
  assert.equal(incomplete.origin, 'software-dev');
  assert.equal(result.findings.at(-1)!.origin, 'base');
});

test('dokument: a missing field, a placeholder, vague words', () => {
  assert.deepEqual(brief(lint('dokument', 'dokument')), [
    '1:1 AK-FELDER field_missing',
    '2:1 AK-FELDER field_empty',
    '3:15 AK-VAGE-DOK vague_word',
    '3:32 AK-VAGE-DOK vague_word',
  ]);
});

test('kundenanfrage: the deadline is not a date or a duration', () => {
  const result = lint('kundenanfrage', 'kundenanfrage');
  assert.deepEqual(brief(result), ['3:1 AK-FELDER field_format', '3:8 AK-VAGE-KA vague_word']);
  assert.match(
    result.findings[0]!.message,
    /"zeitnah"; expected a date \(TT\.MM\.JJJJ\) or a duration/,
  );
});

test('the fixed texts have no findings', () => {
  for (const [type, file] of [
    ['software-dev', 'software-dev-fixed'],
    ['dokument', 'dokument-fixed'],
    ['kundenanfrage', 'kundenanfrage-fixed'],
  ] as const) {
    assert.deepEqual(brief(lint(type, file)), [], file);
  }
});

test('prose without steps is no_scenario; steps out of order are step_order', () => {
  const rules = requireDod(set, 'software-dev').rules;
  const prose = lintAcceptance('Der Warenkorb soll gut funktionieren.\n', 'software-dev', rules);
  assert.equal(prose.findings.find((f) => f.code === 'no_scenario')?.line, 1);
  const order = lintAcceptance(
    [
      'Szenario: Rückwärts',
      '  Wenn ich bezahle',
      '  Dann sehe ich die Quittung',
      '  Angenommen ich bin angemeldet',
    ].join('\n'),
    'software-dev',
    rules,
  );
  assert.deepEqual(
    order.findings.map((f) => `${f.line} ${f.code}`),
    ['4 step_order'],
  );
});

test('scenarios: English keywords, list markers, bold, And continues the previous step', () => {
  const scenarios = parseScenarios(
    [
      '- **Given** a cart',
      '- **When** I pay',
      '- **Then** I see a receipt',
      '- **And** an email arrives',
      '',
      'Gegeben sei X',
      'Wenn Y',
      'Dann Z',
    ].join('\n'),
  );
  assert.deepEqual(
    scenarios.map((s) => s.steps.map((st) => `${st.line}${st.kind[0]}`).join(' ')),
    ['1g 2w 3t 4t', '6g 7w 8t'],
  );
});

test('numbers: dates, times, versions, ids, lists, ranges, units and counted nouns', () => {
  const units = ['s', 'ms', '%', 'min'];
  const bare = (line: string) => numbersWithoutUnit(line, units).map((h) => h.number);
  assert.deepEqual(bare('am 14.11.2026 um 09:30 mit Version 1.2.3 für DEMO-42'), []);
  assert.deepEqual(bare('1. Schritt mit 3 Einträgen und 30% Rabatt in 200ms'), []);
  assert.deepEqual(bare('zwischen 2 bis 5 s, oder 2–5 min'), []);
  assert.deepEqual(bare('Dann lädt die Seite in unter 2'), ['2']);
  assert.deepEqual(bare('Antwortzeit 1,5. Danach 3 mal'), ['1,5', '3']);
  assert.deepEqual(
    bare('Code `retry 3` bleibt'.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))),
    [],
  );
});

test('lint ignores the content of inline code spans', () => {
  const rules = requireDod(set, 'software-dev').rules;
  const text = [
    'Szenario: Konfiguration',
    '  Angenommen `timeout: 30` ist gesetzt',
    '  Wenn der Dienst startet',
    '  Dann steht `retries=3 usw.` im Log',
  ].join('\n');
  assert.deepEqual(lintAcceptance(text, 'software-dev', rules).findings, []);
});

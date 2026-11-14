/**
 * Phase 3: the store, the sync before each request, earlier versions and diff_dod
 * (design sections 6, 8.4 and 9).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDeps, type ServerDeps } from '../src/deps.ts';
import { loadEdition, typeHistory } from '../src/dod/history.ts';
import { effectiveDod } from '../src/dod/merge.ts';
import { canonicalJson, contentHash } from '../src/dod/sync.ts';
import { typesOverview } from '../src/dod/view.ts';
import { DomainError } from '../src/errors.ts';
import { openStore, UnsupportedDatabaseError, type DodStore } from '../src/store/store.ts';
import { computeDiff } from '../src/tools.ts';
import { tempDod } from './helpers.ts';

/** A DoD folder, an in-memory store and a clock the test moves forward. */
function setup(store: DodStore = openStore('sqlite::memory:')) {
  const dir = tempDod();
  let clock = Date.parse('2026-11-01T08:00:00Z');
  const deps = createDeps(dir, store, () => new Date(clock));
  return {
    dir,
    store,
    deps,
    tick: (hours = 1) => (clock += hours * 3_600_000),
    edit: (file: string, change: (text: string) => string) => {
      const path = join(dir, file);
      writeFileSync(path, change(readFileSync(path, 'utf8')));
    },
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    return error.code;
  }
  assert.fail('expected a domain error');
}

const SECURITY_SCAN = [
  '  - id: SECURITY-SCAN',
  '    text: Der Security-Scan meldet keine kritischen Befunde.',
  '    check: evidence',
  '    source: ci.security',
  '    expect: { field: critical, max: 0 }',
  '',
].join('\n');

/** software-dev version 5: a new criterion, and BUILD evidence may be at most 12 h old. */
function bumpSoftwareDev(text: string): string {
  return text
    .replace('version: 4', 'version: 5')
    .replace(
      '    max_age_hours: 24\n    fetch_with: [ci:get_build]',
      '    max_age_hours: 12\n    fetch_with: [ci:get_build]',
    )
    .replace('acceptance:\n', `${SECURITY_SCAN}acceptance:\n`);
}

test('the first sync records every file and edition; repeating it records nothing', () => {
  const { store, deps, tick } = setup();
  const set = deps.loadSet();
  assert.deepEqual(set.history, { available: true, backend: 'sqlite:memory' });
  for (const file of [
    'base.yaml',
    'types.yaml',
    'software-dev.yaml',
    'dokument.yaml',
    'kundenanfrage.yaml',
  ]) {
    assert.equal(store.listVersions(file).length, 1, file);
  }
  assert.equal(store.firstEdition('software-dev', 4)?.base_version, 3);
  tick();
  deps.loadSet();
  assert.equal(store.listVersions('software-dev.yaml').length, 1);
  assert.equal(
    store.listVersions('software-dev.yaml')[0]!.first_seen_at,
    '2026-11-01T08:00:00.000Z',
  );
});

test('a change in comments or key order is not a new version', () => {
  const { deps, edit, store } = setup();
  deps.loadSet();
  edit(
    'software-dev.yaml',
    (t) =>
      `# reviewed in the retrospective\n${t.replace('title: Softwareentwicklung\nextends: base', 'extends: base\ntitle: Softwareentwicklung')}`,
  );
  const set = deps.loadSet();
  assert.equal(effectiveDod(set, 'software-dev').ok, true);
  assert.equal(store.listVersions('software-dev.yaml').length, 1);
  assert.equal(
    contentHash({ a: 1, b: [2, { c: 3, d: 4 }] }),
    contentHash({ b: [2, { d: 4, c: 3 }], a: 1 }),
  );
  assert.equal(canonicalJson({ b: 1, a: undefined }), '{"b":1}');
});

test('a content change without a new version makes the file invalid (F4)', () => {
  const { deps, edit } = setup();
  deps.loadSet();
  edit('software-dev.yaml', (t) => t.replace('max_age_hours: 168', 'max_age_hours: 72'));
  const set = deps.loadSet();
  const result = effectiveDod(set, 'software-dev');
  assert.ok(!result.ok);
  const error = result.errors.find((e) => e.code === 'version_not_bumped');
  assert.equal(error?.file, 'software-dev.yaml');
  assert.equal(error?.line, 5);
  assert.match(error?.message ?? '', /Raise the version to 5/);
  assert.equal(effectiveDod(set, 'dokument').ok, true);
});

test('the same for the base invalidates every type', () => {
  const { deps, edit } = setup();
  deps.loadSet();
  edit('base.yaml', (t) => t.replace('role: Teammitglied', 'role: Kollegin'));
  const set = deps.loadSet();
  for (const type of set.types.keys()) assert.equal(effectiveDod(set, type).ok, false, type);
  assert.equal(set.base.errors[0]?.code, 'version_not_bumped');
});

test('a version lower than one already in force is version_regressed, also for a revert', () => {
  const { deps, edit, tick } = setup();
  deps.loadSet();
  edit('software-dev.yaml', bumpSoftwareDev);
  tick();
  deps.loadSet();
  edit('software-dev.yaml', (t) => t.replace('version: 5', 'version: 4'));
  const result = effectiveDod(deps.loadSet(), 'software-dev');
  assert.ok(!result.ok);
  assert.equal(result.errors[0]?.code, 'version_regressed');
  assert.match(result.errors[0]?.message ?? '', /needs a version above 5/);
});

test('earlier versions stay readable with the base they were first served with', () => {
  const { deps, edit, tick, store } = setup();
  deps.loadSet();
  tick();
  edit('software-dev.yaml', bumpSoftwareDev);
  deps.loadSet();
  tick();
  edit('base.yaml', (t) =>
    t
      .replace('version: 3', 'version: 4')
      .replace(
        'acceptance:\n',
        `${SECURITY_SCAN.replace('SECURITY-SCAN', 'NACHVOLLZIEHBAR').replace('Der Security-Scan meldet keine kritischen Befunde.', 'Die Entscheidung ist im Ticket begründet.')}acceptance:\n`,
      ),
  );
  const set = deps.loadSet();
  assert.equal(effectiveDod(set, 'software-dev').ok, true);

  assert.deepEqual(
    typeHistory(store, 'software-dev').map((v) => `${v.version}+base@${v.base_version}`),
    ['4+base@3', '5+base@3'],
  );
  const v4 = loadEdition(store, 'software-dev', 4);
  assert.equal(v4?.dod.dod_version, 'software-dev@4+base@3');
  assert.equal(v4?.first_seen_at, '2026-11-01T08:00:00.000Z');
  assert.equal(loadEdition(store, 'software-dev', 5)?.dod.dod_version, 'software-dev@5+base@3');
  assert.equal(loadEdition(store, 'software-dev', 9), undefined);
  const overview = typesOverview(set, store) as { types: { type: string; versions: number[] }[] };
  assert.deepEqual(overview.types.find((t) => t.type === 'software-dev')?.versions, [4, 5]);
});

test('diff_dod: from the previous version to now, with origin, including base changes', () => {
  const { deps, edit, tick } = setup();
  deps.loadSet();
  tick();
  edit('software-dev.yaml', bumpSoftwareDev);
  deps.loadSet();
  tick();
  edit('base.yaml', (t) =>
    t
      .replace('version: 3', 'version: 4')
      .replace('words: [usw., etc.,', 'words: [usw., etc., eventuell,'),
  );

  const diff = computeDiff({ type: 'software-dev' }, deps);
  assert.equal(diff.from, 'software-dev@4+base@3');
  assert.equal(diff.to, 'software-dev@5+base@4');
  assert.deepEqual(
    diff.criteria.added.map((c) => `${String(c.origin)}:${String(c.id)}`),
    ['software-dev:SECURITY-SCAN'],
  );
  assert.deepEqual(diff.criteria.removed, []);
  assert.deepEqual(diff.criteria.changed, [
    { id: 'BUILD', origin: 'software-dev', fields: [{ key: 'max_age_hours', from: 24, to: 12 }] },
  ]);
  assert.equal(diff.rules.changed[0]?.id, 'AK-VAGE');
  assert.equal(diff.rules.changed[0]?.origin, 'base');
  assert.deepEqual(diff.summary, { added: 1, removed: 0, changed: 2 });

  const base = computeDiff({ type: 'base' }, deps);
  assert.deepEqual([base.from, base.to, base.summary.changed], ['base@3', 'base@4', 1]);

  const explicit = computeDiff({ type: 'software-dev', from: 4, to: 5 }, deps);
  assert.equal(explicit.to, 'software-dev@5+base@3');
  assert.deepEqual(explicit.rules.changed, []);
});

test('diff_dod: no history yet, unknown versions, unknown types', () => {
  const { deps } = setup();
  deps.loadSet();
  assert.equal(
    code(() => computeDiff({ type: 'software-dev' }, deps)),
    'no_history',
  );
  assert.equal(
    code(() => computeDiff({ type: 'base' }, deps)),
    'no_history',
  );
  assert.throws(
    () => computeDiff({ type: 'software-dev', from: 2, to: 4 }, deps),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === 'unknown_version' &&
      /Recorded versions: 4\./.test(error.hint),
  );
  assert.equal(
    code(() => computeDiff({ type: 'einkauf' }, deps)),
    'unknown_type',
  );
});

test('a failing store leaves the current DoD working and the history unavailable', () => {
  const broken: DodStore = {
    description: 'sqlite:broken',
    transaction: () => {
      throw new Error('disk I/O error');
    },
    recordFileVersion: () => false,
    recordEdition: () => false,
    latestVersion: () => undefined,
    listVersions: () => [],
    getFileVersion: () => undefined,
    firstEdition: () => undefined,
    close: () => {},
  };
  const { deps } = setup(broken);
  const set = deps.loadSet();
  assert.deepEqual(set.history, {
    available: false,
    backend: 'sqlite:broken',
    error: 'disk I/O error',
  });
  assert.equal(effectiveDod(set, 'software-dev').ok, true);
  assert.equal(
    code(() => computeDiff({ type: 'software-dev' }, deps)),
    'history_unavailable',
  );
  const without: ServerDeps = createDeps(deps.dodDir, undefined);
  assert.equal(without.loadSet().history, undefined);
  assert.equal(
    code(() => computeDiff({ type: 'base' }, without)),
    'history_unavailable',
  );
});

test('a SQLite file keeps the history across restarts', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dod-store-'));
  try {
    const url = `sqlite:${join(folder, 'nested', 'dod.sqlite')}`;
    const first = setup(openStore(url));
    first.deps.loadSet();
    first.store.close();
    const reopened = openStore(url);
    assert.equal(reopened.description, 'sqlite:dod.sqlite');
    assert.deepEqual(
      reopened.listVersions('base.yaml').map((v) => v.version),
      [3],
    );
    reopened.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('only sqlite: is supported; anything else stops the server at start', () => {
  assert.throws(() => openStore('postgres://db/dod'), UnsupportedDatabaseError);
  assert.throws(() => openStore('postgres://db/dod'), /supports only sqlite:/);
  assert.throws(() => openStore('dod.sqlite'), UnsupportedDatabaseError);
  assert.throws(() => openStore('sqlite:'), /needs a file path/);
});

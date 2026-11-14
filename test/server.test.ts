/**
 * Protocol test: starts the real server as a child process over stdio and talks to it
 * with the official MCP client. If anything other than JSON-RPC reached stdout, the
 * client could not parse the stream and these tests would fail.
 *
 * The server reads a temporary copy of dod/, so the test can add files while it runs:
 * a new type file must appear as new resources without a restart.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { lines, tempDod } from './helpers.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const dir = tempDod();
let client: Client;

before(async () => {
  client = new Client({ name: 'protocol-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MAIN],
      env: { PATH: process.env.PATH ?? '', DOD_DIR: dir, DOD_DATABASE: 'sqlite::memory:' },
      stderr: 'ignore',
    }),
  );
});

after(async () => {
  await client.close();
});

function text(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[] | undefined;
  return content?.map((c) => c.text ?? '').join('\n') ?? '';
}

async function resourceText(uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const first = result.contents[0] as { text?: string } | undefined;
  return first?.text ?? '';
}

test('four read-only tools with output schemas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'check_dod',
    'diff_dod',
    'get_dod',
    'lint_acceptance_criteria',
  ]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
    assert.ok(tool.outputSchema, `${tool.name} declares an output schema`);
  }
});

test('resources/list: the overview plus one DoD, template and rubric per type file', async () => {
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri).sort();
  assert.deepEqual(uris, [
    'dod://type/dokument',
    'dod://type/kundenanfrage',
    'dod://type/software-dev',
    'dod://types',
    'rubric://dod/dokument',
    'rubric://dod/kundenanfrage',
    'rubric://dod/software-dev',
    'template://dokument',
    'template://kundenanfrage',
    'template://software-dev',
  ]);
  const sw = resources.find((r) => r.uri === 'dod://type/software-dev');
  assert.equal(sw?.title, 'Softwareentwicklung: DoD (software-dev@4+base@3)');
});

test('dod://type/{type}: base and type merged, each criterion with origin, file and line', async () => {
  const view = JSON.parse(await resourceText('dod://type/kundenanfrage')) as {
    dod_version: string;
    criteria: { id: string; origin: string; file: string; line: number; check: string }[];
    mapping: { ticket_types: string[] };
  };
  assert.equal(view.dod_version, 'kundenanfrage@3+base@3');
  assert.deepEqual(
    view.criteria.map((c) => `${c.origin}/${c.id}@${c.file}:${c.line}`),
    [
      'base/ERGEBNIS-VERLINKT@base.yaml:8',
      'base/FOLGEARBEIT@base.yaml:14',
      'base/ZWEITE-PERSON@base.yaml:22',
      'kundenanfrage/FRIST@kundenanfrage.yaml:8',
      'kundenanfrage/VOLLSTAENDIG@kundenanfrage.yaml:14',
      'kundenanfrage/WISSENSBASIS@kundenanfrage.yaml:23',
      'kundenanfrage/ZUSAGE@kundenanfrage.yaml:31',
    ],
  );
  assert.deepEqual(view.mapping.ticket_types, ['Anfrage']);
});

test('template and rubric come from the same files', async () => {
  const template = await resourceText('template://kundenanfrage');
  assert.match(template, /Frist: <TT\.MM\.JJJJ oder Dauer/);
  assert.match(
    template,
    /AK-FELDER \(kundenanfrage, fields\): required fields: Fragen \(a list with at least 1 item\), Frist \(date or duration\)/,
  );
  assert.match(template, /AK-VAGE \(base, vague_words\)/);
  const rubric = await resourceText('rubric://dod/kundenanfrage');
  assert.match(rubric, /## VOLLSTAENDIG \(kundenanfrage\)/);
  assert.match(rubric, /Question: Welche Frage der Anfrage bleibt in der Antwort offen\?/);
  assert.match(rubric, /ZUSAGE \(kundenanfrage\): .* Confirmed by the role Vertrieb\./);
  assert.match(rubric, /Never call it plausible without a quote/);
});

test('a new type file appears as resources without a restart; an invalid one shows its errors', async () => {
  writeFileSync(
    join(dir, 'einkauf.yaml'),
    lines(
      '# FICTIONAL EXAMPLE',
      'type: einkauf',
      'version: 1',
      'title: Einkauf',
      'extends: base',
      'criteria: []',
    ),
  );
  writeFileSync(
    join(dir, 'kaputt.yaml'),
    lines('type: kaputt', 'version: 1', 'title: Kaputt', 'extends: base', 'remove: [FOLGEARBEIT]'),
  );
  const { resources } = await client.listResources();
  const uris = resources.map((r) => r.uri);
  for (const uri of [
    'dod://type/einkauf',
    'template://einkauf',
    'rubric://dod/einkauf',
    'dod://type/kaputt',
  ]) {
    assert.ok(uris.includes(uri), uri);
  }
  assert.equal(
    resources.find((r) => r.uri === 'dod://type/kaputt')?.title,
    'kaputt: DoD (invalid)',
  );
  const broken = JSON.parse(await resourceText('dod://type/kaputt')) as {
    valid: boolean;
    errors: { file: string; line: number; code: string }[];
  };
  assert.equal(broken.valid, false);
  assert.deepEqual(
    broken.errors.map((e) => `${e.file}:${e.line} ${e.code}`),
    ['kaputt.yaml:5 base_criterion_removed'],
  );
  assert.match(
    await resourceText('rubric://dod/kaputt'),
    /kaputt\.yaml:5:1 base_criterion_removed/,
  );
  const result = await client.callTool({ name: 'get_dod', arguments: { type: 'kaputt' } });
  assert.equal(result.isError, true);
  assert.match(text(result), /^invalid_dod: .*\n.*kaputt\.yaml:5:1 base_criterion_removed/);
});

test('an unknown type in a resource URI is a JSON-RPC error', async () => {
  await assert.rejects(client.readResource({ uri: 'dod://type/gibt-es-nicht' }));
});

test('get_dod: overview without input, merged DoD by ticket type', async () => {
  const overview = await client.callTool({ name: 'get_dod', arguments: {} });
  assert.equal(overview.isError, undefined);
  assert.match(text(overview), /DoD task types/);
  const result = await client.callTool({ name: 'get_dod', arguments: { ticket_type: 'Story' } });
  const data = result.structuredContent as {
    resolution: { via: string };
    dod: { criteria: unknown[]; dod_version: string };
  };
  assert.equal(data.resolution.via, 'ticket_type');
  assert.equal(data.dod.dod_version, 'software-dev@4+base@3');
  assert.equal(data.dod.criteria.length, 9);
  assert.match(
    text(result),
    /QUALITY-GATE \(software-dev, evidence\): .* \[fetch with sonarqube:get_project_quality_gate_status\]/,
  );
});

test('get_dod: an ambiguous type is isError with a hint, not a default', async () => {
  const result = await client.callTool({
    name: 'get_dod',
    arguments: { ticket_type: 'Story', labels: ['doku'] },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.match(
    text(result),
    /^ambiguous_type: .*Story → software-dev, doku → dokument[\s\S]*Hint: Fix the labels/,
  );
});

test('check_dod with the example evidence returns status per criterion', async () => {
  const input = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../examples/evidence/software-dev-gaps.json', import.meta.url)),
      'utf8',
    ),
  ) as Record<string, unknown>;
  delete input._comment;
  const result = await client.callTool({ name: 'check_dod', arguments: input });
  assert.equal(result.isError, undefined, text(result));
  const data = result.structuredContent as { summary: Record<string, number> };
  assert.deepEqual(data.summary, { criteria: 9, met: 4, not_met: 3, needs_judgment: 2 });
  assert.match(
    text(result),
    /\| QUALITY-GATE \| software-dev \| evidence \| not met \| evidence_other_ref \|/,
  );
  assert.match(text(result), /Whether DEMO-42 is done is the team's decision\./);
});

test('check_dod rejects an as_of without time zone through the input schema', async () => {
  const result = await client.callTool({
    name: 'check_dod',
    arguments: { item: { id: 'X', ticket_type: 'Story' }, as_of: '2026-11-14 10:00' },
  });
  assert.equal(result.isError, true);
});

test('lint_acceptance_criteria finds the deadline problem by label', async () => {
  const result = await client.callTool({
    name: 'lint_acceptance_criteria',
    arguments: { text: 'Fragen:\n1. Preis?\nFrist: zeitnah\n', labels: ['kunde'] },
  });
  const data = result.structuredContent as { findings: { line: number; code: string }[] };
  assert.deepEqual(
    data.findings.map((f) => `${f.line} ${f.code}`),
    ['3 field_format', '3 vague_word'],
  );
  const empty = await client.callTool({
    name: 'lint_acceptance_criteria',
    arguments: { text: '  ', type: 'dokument' },
  });
  assert.equal(empty.isError, true);
  assert.match(text(empty), /^empty_text:/);
});

test('the prompt done_check walks through the check and writes nothing', async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(
    prompts.map((p) => p.name),
    ['done_check'],
  );
  const prompt = await client.getPrompt({ name: 'done_check', arguments: { item: 'DEMO-42' } });
  const body = (prompt.messages[0]?.content as { text: string }).text;
  assert.match(body, /Check the item DEMO-42/);
  assert.match(body, /write nothing into the ticket/);
  assert.match(body, /Never confirm on anyone's behalf/);
});

test('an unknown tool is a protocol error', async () => {
  await assert.rejects(client.callTool({ name: 'mark_done', arguments: {} }));
});

test('history over the protocol: a new version, its predecessor as a resource, and diff_dod', async () => {
  const file = join(dir, 'kundenanfrage.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('version: 3', 'version: 4')
      .replace('role: Vertrieb', 'role: Vertriebsleitung'),
  );
  const current = JSON.parse(await resourceText('dod://type/kundenanfrage')) as {
    dod_version: string;
    history: { version: number; uri: string }[];
  };
  assert.equal(current.dod_version, 'kundenanfrage@4+base@3');
  assert.deepEqual(
    current.history.map((h) => h.uri),
    ['dod://type/kundenanfrage/version/3', 'dod://type/kundenanfrage/version/4'],
  );
  const v3 = JSON.parse(await resourceText('dod://type/kundenanfrage/version/3')) as {
    dod_version: string;
    current: boolean;
  };
  assert.deepEqual([v3.dod_version, v3.current], ['kundenanfrage@3+base@3', false]);
  await assert.rejects(client.readResource({ uri: 'dod://type/kundenanfrage/version/9' }));

  const diff = await client.callTool({ name: 'diff_dod', arguments: { type: 'kundenanfrage' } });
  assert.equal(diff.isError, undefined, text(diff));
  assert.match(
    text(diff),
    /kundenanfrage@3\+base@3 → kundenanfrage@4\+base@3: 0 added, 0 removed, 1 changed[\s\S]*~ criterion ZUSAGE \(kundenanfrage\): role "Vertrieb" → "Vertriebsleitung"/,
  );
  const none = await client.callTool({ name: 'diff_dod', arguments: { type: 'dokument' } });
  assert.equal(none.isError, true);
  assert.match(text(none), /^no_history:/);
});

/**
 * Container test (design section 15): builds the image, runs it read-only with the
 * example DoD, a volume and the three secrets, and talks to it over HTTPS with the
 * official MCP client. Then changes a mounted file, restarts the container and checks
 * that the history survived. Needs Docker; run with `npm run test:docker`.
 *
 * Not part of `npm test`: the file name does not end in .test.ts on purpose.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { makeCertificate, trustingFetch, type FetchLike } from '../https-helpers.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IMAGE = 'dod-mcp:test';
const suffix = `${process.pid}-${Date.now()}`;
const NAME = `dod-mcp-test-${suffix}`;
const VOLUME = `dod-mcp-test-data-${suffix}`;
const TOKEN = `container-test-${'x'.repeat(24)}-${suffix}`;

let folder: string;
let dodDir: string;
let base: string;
let fetch: FetchLike;

function docker(args: string[], timeout = 120_000): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout.trim();
}

/** Container output: the server logs to stderr, which docker logs passes on as stderr. */
function logs(): string {
  const result = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}

/** The host port Docker picked; it changes when the container restarts. */
function refreshBase(): void {
  const port = docker(['port', NAME, '8443/tcp']).split('\n')[0]!.split(':').pop();
  base = `https://127.0.0.1:${port}`;
}

async function waitHealthy(): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const status = docker(['inspect', '-f', '{{.State.Health.Status}}', NAME]);
    if (status === 'healthy') return;
    if (status === 'unhealthy' || Date.now() > deadline) {
      throw new Error(`container is ${status}:\n${logs()}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function connect(): Promise<Client> {
  const client = new Client({ name: 'container-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch,
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  return client;
}

before(async () => {
  docker(['build', '-q', '-t', IMAGE, ROOT], 600_000);
  folder = mkdtempSync(join(tmpdir(), 'dod-container-'));
  const { certFile, keyFile, cert } = makeCertificate(folder);
  const tokenFile = join(folder, 'tokens');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  for (const file of [certFile, keyFile, tokenFile]) chmodSync(file, 0o644);
  dodDir = join(folder, 'dod');
  cpSync(join(ROOT, 'dod'), dodDir, { recursive: true });
  docker(['volume', 'create', VOLUME]);
  docker([
    'run',
    '-d',
    '--name',
    NAME,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '-p',
    '127.0.0.1::8443',
    '-v',
    `${dodDir}:/dod:ro`,
    '-v',
    `${VOLUME}:/data`,
    '-v',
    `${certFile}:/run/secrets/tls_cert:ro`,
    '-v',
    `${keyFile}:/run/secrets/tls_key:ro`,
    '-v',
    `${tokenFile}:/run/secrets/dod_tokens:ro`,
    IMAGE,
  ]);
  await waitHealthy();
  refreshBase();
  fetch = trustingFetch(cert);
});

after(() => {
  spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  spawnSync('docker', ['volume', 'rm', '-f', VOLUME], { stdio: 'ignore' });
  if (folder) rmSync(folder, { recursive: true, force: true });
});

test('runs as a non-root user on a read-only file system', () => {
  assert.notEqual(docker(['exec', NAME, 'id', '-u']), '0');
  const write = spawnSync('docker', ['exec', NAME, 'sh', '-c', 'touch /app/probe'], {
    encoding: 'utf8',
  });
  assert.notEqual(write.status, 0, 'the root file system must be read-only');
  assert.match(
    logs(),
    /ready on https:\/\/0\.0\.0\.0:8443\/mcp; 3 type file\(s\).*history: sqlite:dod\.sqlite/,
  );
});

test('/healthz answers without a token; /mcp without a token is 401', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('one resource per type file, and check_dod on the example evidence', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  assert.deepEqual(
    resources
      .map((r) => r.uri)
      .filter((u) => u.startsWith('dod://type/'))
      .sort(),
    ['dod://type/dokument', 'dod://type/kundenanfrage', 'dod://type/software-dev'],
  );
  const input = JSON.parse(
    readFileSync(join(ROOT, 'examples/evidence/software-dev-gaps.json'), 'utf8'),
  ) as Record<string, unknown>;
  delete input._comment;
  const result = await client.callTool({ name: 'check_dod', arguments: input });
  assert.deepEqual((result.structuredContent as { summary: unknown }).summary, {
    criteria: 9,
    met: 4,
    not_met: 3,
    needs_judgment: 2,
  });
  await client.close();
});

test('a new version of a mounted file is recorded and survives a restart', async () => {
  const file = join(dodDir, 'software-dev.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('version: 4', 'version: 5')
      .replace('role: Betrieb', 'role: Plattform-Team'),
  );
  let client = await connect();
  const current = await client.callTool({ name: 'get_dod', arguments: { type: 'software-dev' } });
  assert.equal(
    (current.structuredContent as { dod: { dod_version: string } }).dod.dod_version,
    'software-dev@5+base@3',
  );
  await client.close();

  docker(['restart', NAME]);
  await waitHealthy();
  refreshBase();
  client = await connect();
  const diff = await client.callTool({ name: 'diff_dod', arguments: { type: 'software-dev' } });
  const data = diff.structuredContent as {
    from: string;
    to: string;
    criteria: { changed: { id: string }[] };
  };
  assert.deepEqual([data.from, data.to], ['software-dev@4+base@3', 'software-dev@5+base@3']);
  assert.deepEqual(
    data.criteria.changed.map((c) => c.id),
    ['RUNBOOK'],
  );
  await client.close();
});

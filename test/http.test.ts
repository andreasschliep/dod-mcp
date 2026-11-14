/**
 * HTTPS in process (design sections 11.1 and 15, test 8): TLS, Host and Origin checks,
 * bearer token, body limit, /healthz, and the official MCP client over Streamable HTTP.
 * Skipped with a message if openssl is not installed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDeps } from '../src/deps.ts';
import {
  HttpsConfigError,
  httpsConfigFromEnv,
  listeningPort,
  parseTokens,
  startHttps,
  type HttpsConfig,
} from '../src/http.ts';
import { openStore } from '../src/store/store.ts';
import { tempDod } from './helpers.ts';
import { HAS_OPENSSL, makeCertificate, trustingFetch, type FetchLike } from './https-helpers.ts';

const TOKEN = 'test-token-0123456789-abcdefghijklmnop';
const OTHER = 'other-token-0123456789-abcdefghijklmno';

describe('HTTPS transport', { skip: HAS_OPENSSL ? false : 'openssl is not installed' }, () => {
  let folder: string;
  let server: Server;
  let base: string;
  let fetch: FetchLike;
  let config: HttpsConfig;

  before(async () => {
    folder = mkdtempSync(join(tmpdir(), 'dod-https-'));
    const { certFile, keyFile, cert } = makeCertificate(folder);
    const tokenFile = join(folder, 'tokens');
    writeFileSync(tokenFile, `# rotation: the new token first\n${OTHER}\n${TOKEN}\n`);
    config = {
      port: 0,
      host: '127.0.0.1',
      certFile,
      keyFile,
      tokenFile,
      allowedHosts: ['localhost', '127.0.0.1'],
      allowedOrigins: [],
    };
    const deps = createDeps(tempDod(), openStore('sqlite::memory:'));
    server = await startHttps(deps, config);
    base = `https://127.0.0.1:${listeningPort(server)}`;
    fetch = trustingFetch(cert);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  });

  const post = (headers: Record<string, string> = {}, body = '{}') =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });

  test('/healthz answers without a token and without data', async () => {
    const ok = await fetch(`${base}/healthz`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'ok\n');
    assert.equal((await fetch(`${base}/healthz`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/anything`)).status, 404);
  });

  test('no token or a wrong token is 401 with a Bearer challenge', async () => {
    const none = await post();
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
    assert.equal(
      (await post({ authorization: 'Bearer wrong-token-0123456789-abcdefghijklm' })).status,
      401,
    );
    assert.equal((await post({ authorization: `Basic ${TOKEN}` })).status, 401);
  });

  test('a foreign Host or any Origin is rejected before the token is looked at', async () => {
    const host = await post({ authorization: `Bearer ${TOKEN}`, host: 'evil.example' });
    assert.equal(host.status, 403);
    const origin = await post({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' });
    assert.equal(origin.status, 403);
  });

  test('a body over 1 MB is refused', async () => {
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      pad: 'x'.repeat(1_100_000),
    });
    assert.equal((await post({ authorization: `Bearer ${TOKEN}` }, big)).status, 413);
  });

  test('with a token, the official client works over Streamable HTTP; both tokens are accepted', async () => {
    for (const token of [TOKEN, OTHER]) {
      const client = new Client({ name: 'https-test', version: '0.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          fetch,
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [
        'check_dod',
        'diff_dod',
        'get_dod',
        'lint_acceptance_criteria',
      ]);
      const { resources } = await client.listResources();
      assert.ok(resources.some((r) => r.uri === 'dod://type/software-dev'));
      const result = await client.callTool({
        name: 'get_dod',
        arguments: { ticket_type: 'Story' },
      });
      assert.equal(
        (result.structuredContent as { dod: { dod_version: string } }).dod.dod_version,
        'software-dev@4+base@3',
      );
      await client.close();
    }
  });

  test('the server refuses to start without a usable token file or certificate', async () => {
    const deps = createDeps(tempDod(), undefined);
    const shortFile = join(folder, 'short');
    writeFileSync(shortFile, 'too-short\n');
    await assert.rejects(startHttps(deps, { ...config, tokenFile: shortFile }), HttpsConfigError);
    await assert.rejects(
      startHttps(deps, { ...config, tokenFile: join(folder, 'missing') }),
      /DOD_TOKEN_FILE/,
    );
    await assert.rejects(
      startHttps(deps, { ...config, certFile: join(folder, 'missing') }),
      /DOD_TLS_CERT_FILE/,
    );
  });
});

test('tokens: one per line, comments ignored, at least 32 characters, none means no start', () => {
  assert.deepEqual(parseTokens(`# a\n\n${TOKEN}\n  ${OTHER}  \n`), [TOKEN, OTHER]);
  assert.throws(() => parseTokens('# nothing\n'), /holds no token/);
  assert.throws(() => parseTokens(`${TOKEN}\nshort\n`), /Token 2 .* shorter than 32/);
});

test('HTTPS configuration from the environment', () => {
  const config = httpsConfigFromEnv({
    DOD_ALLOWED_HOSTS: 'dod.example.org, localhost',
    DOD_PORT: '9443',
  });
  assert.equal(config.port, 9443);
  assert.deepEqual(config.allowedHosts, ['dod.example.org', 'localhost']);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.tokenFile, '/run/secrets/dod_tokens');
  assert.throws(() => httpsConfigFromEnv({ DOD_PORT: 'abc' }), HttpsConfigError);
});

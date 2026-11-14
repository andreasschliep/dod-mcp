/**
 * HTTPS test helpers: a self-signed certificate made with openssl at test time (no key
 * in the repository), and a fetch that trusts exactly that certificate. Node's built-in
 * fetch reads extra CAs only at process start, so the tests use node:https directly.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';

export const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;

/** Writes cert.pem and key.pem for localhost and 127.0.0.1 into dir; returns the certificate. */
export function makeCertificate(dir: string): { certFile: string; keyFile: string; cert: string } {
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) throw new Error('openssl could not create a test certificate');
  return { certFile, keyFile, cert: readFileSync(certFile, 'utf8') };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** fetch over node:https that trusts only `ca`. Enough for the MCP client and plain checks. */
export function trustingFetch(ca: string): FetchLike {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      const req = request(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: init.method ?? (input instanceof Request ? input.method : 'GET'),
          headers: Object.fromEntries(headers),
          ca,
          // Verify the certificate against the address we connect to, not against a
          // Host header a test sets on purpose.
          checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
        },
        (res) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined)
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = res.statusCode ?? 0;
          const empty = status === 204 || status === 304;
          if (empty) res.resume();
          resolve(
            new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
              status,
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on('error', reject);
      init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
      const body = init.body;
      if (typeof body === 'string') req.write(body);
      else if (body instanceof Uint8Array) req.write(body);
      req.end();
    });
}

/**
 * HTTPS transport (design section 11.1). One endpoint, POST /mcp, served by the SDK's
 * createMcpHandler (stateless per request). GET /healthz answers without authentication
 * and without data, for the Docker health check.
 *
 * Order of checks for /mcp: TLS (the server) → Host → Origin → bearer token → body size
 * → MCP. There is no plain-HTTP mode: without certificate, key or token file the server
 * refuses to start.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { ServerDeps } from './deps.ts';
import { logError } from './logger.ts';
import { createServer as createMcpServer } from './server.ts';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MIN_TOKEN_LENGTH = 32;

export interface HttpsConfig {
  port: number;
  /** Bind address; 0.0.0.0 in the container. */
  host: string;
  certFile: string;
  keyFile: string;
  tokenFile: string;
  allowedHosts: string[];
  allowedOrigins: string[];
}

/** The HTTPS configuration is incomplete or invalid; the server does not start. */
export class HttpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpsConfigError';
  }
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function httpsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpsConfig {
  const port = Number(env.DOD_PORT ?? '8443');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new HttpsConfigError(`DOD_PORT "${env.DOD_PORT}" is not a port number.`);
  }
  return {
    port,
    host: env.DOD_HOST?.trim() || '0.0.0.0',
    certFile: env.DOD_TLS_CERT_FILE?.trim() || '/run/secrets/tls_cert',
    keyFile: env.DOD_TLS_KEY_FILE?.trim() || '/run/secrets/tls_key',
    tokenFile: env.DOD_TOKEN_FILE?.trim() || '/run/secrets/dod_tokens',
    allowedHosts: list(env.DOD_ALLOWED_HOSTS, ['localhost', '127.0.0.1']),
    allowedOrigins: list(env.DOD_ALLOWED_ORIGINS, []),
  };
}

function readRequired(file: string, what: string, variable: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new HttpsConfigError(`The ${what} cannot be read; set ${variable} to a readable file.`);
  }
}

/** One token per line; blank lines and lines starting with # are ignored. */
export function parseTokens(text: string): string[] {
  const tokens = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (tokens.length === 0) throw new HttpsConfigError('The token file holds no token.');
  const short = tokens.findIndex((t) => t.length < MIN_TOKEN_LENGTH || /\s/.test(t));
  if (short >= 0) {
    throw new HttpsConfigError(
      `Token ${short + 1} in the token file is shorter than ${MIN_TOKEN_LENGTH} characters or contains whitespace.`,
    );
  }
  return tokens;
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * A verifier for static tokens. Both sides are hashed, so the comparison takes the same
 * time for every token; the token itself never leaves this function.
 */
export function staticTokenVerifier(tokens: string[]): OAuthTokenVerifier {
  const known = tokens.map(digest);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const given = digest(token);
      let match = -1;
      known.forEach((d, i) => {
        if (timingSafeEqual(d, given) && match < 0) match = i;
      });
      if (match < 0) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Unknown token');
      // Static tokens do not expire; the SDK requires an expiry, so each check grants a
      // short one. Rotation happens by editing the token file and restarting.
      return {
        token: 'redacted',
        clientId: `token-${match + 1}`,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };
    },
  };
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** What a request asked for, for the log: JSON-RPC method and tool or resource, never arguments. */
async function describeCall(request: Request): Promise<string> {
  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: Record<string, unknown>;
    };
    const method = typeof body.method === 'string' ? body.method : '?';
    const target = body.params?.name ?? body.params?.uri;
    return typeof target === 'string' ? `${method} ${target.slice(0, 80)}` : method;
  } catch {
    return '?';
  }
}

export function createWebHandler(
  deps: ServerDeps,
  config: Pick<HttpsConfig, 'allowedHosts' | 'allowedOrigins'>,
  tokens: string[],
): (request: Request) => Promise<Response> {
  const mcp = createMcpHandler(() => createMcpServer(deps), {
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => logError('MCP handler', error),
  });
  const gate = requireBearerAuth({ verifier: staticTokenVerifier(tokens) });

  return async (request: Request): Promise<Response> => {
    const started = Date.now();
    const path = new URL(request.url).pathname;
    let call = '';
    let response: Response;
    if (path === '/healthz') {
      response = request.method === 'GET' ? plain(200, 'ok\n') : plain(405, 'method not allowed\n');
    } else if (path !== '/mcp') {
      response = plain(404, 'not found\n');
    } else {
      const rejected =
        hostHeaderValidationResponse(request, config.allowedHosts) ??
        originValidationResponse(request, config.allowedOrigins);
      if (rejected) {
        response = rejected;
      } else {
        const auth = await gate(request);
        if (auth instanceof Response) {
          response = auth;
        } else {
          call = request.method === 'POST' ? await describeCall(request) : '';
          response = await mcp.fetch(request, { authInfo: auth });
        }
      }
    }
    console.error(
      JSON.stringify({
        time: new Date(started).toISOString(),
        method: request.method,
        path,
        call: call || undefined,
        status: response.status,
        ms: Date.now() - started,
      }),
    );
    return response;
  };
}

/** Starts the HTTPS server; resolves once it listens. */
export async function startHttps(deps: ServerDeps, config: HttpsConfig): Promise<Server> {
  const cert = readRequired(config.certFile, 'TLS certificate', 'DOD_TLS_CERT_FILE');
  const key = readRequired(config.keyFile, 'TLS key', 'DOD_TLS_KEY_FILE');
  const tokens = parseTokens(readRequired(config.tokenFile, 'token file', 'DOD_TOKEN_FILE'));
  if (config.allowedHosts.length === 0) {
    throw new HttpsConfigError('DOD_ALLOWED_HOSTS is empty; name at least one host.');
  }
  const handler = createWebHandler(deps, config, tokens);
  const node = toNodeHandler(
    { fetch: (request: Request) => handler(request) },
    { maxRequestBodySize: MAX_BODY_BYTES, onerror: (error) => logError('HTTP adapter', error) },
  );
  const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (req, res) => {
    void node(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export function listeningPort(server: Server): number {
  return (server.address() as AddressInfo).port;
}

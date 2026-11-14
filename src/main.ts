#!/usr/bin/env node
/**
 * Entry point. DOD_TRANSPORT selects the transport (design section 11.3):
 *   stdio  (default) for local use in Claude Code or Claude Desktop
 *   https  for the container: TLS, Host/Origin checks, bearer token
 * Logs go to stderr; over stdio, stdout carries JSON-RPC messages only.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultDeps, type ServerDeps } from './deps.ts';
import { DodUnavailableError } from './dod/load.ts';
import { httpsConfigFromEnv, listeningPort, startHttps } from './http.ts';
import { logError, logInfo } from './logger.ts';
import { createServer, VERSION } from './server.ts';

function describeFolder(deps: ServerDeps): string {
  try {
    const set = deps.loadSet();
    const history = set.history?.available ? set.history.backend : 'unavailable';
    return `${set.types.size} type file(s) in the DoD folder; history: ${history}`;
  } catch (error) {
    if (!(error instanceof DodUnavailableError)) throw error;
    return `the DoD folder is not usable yet: ${error.message}`;
  }
}

async function main(): Promise<void> {
  const transport = process.env.DOD_TRANSPORT?.trim() || 'stdio';
  const deps = defaultDeps();
  if (transport === 'stdio') {
    await createServer(deps).connect(new StdioServerTransport());
    logInfo(`v${VERSION} ready on stdio; ${describeFolder(deps)}`);
    return;
  }
  if (transport !== 'https') {
    throw new Error(`DOD_TRANSPORT=${transport} is not supported; use stdio or https.`);
  }
  const config = httpsConfigFromEnv();
  const server = await startHttps(deps, config);
  logInfo(
    `v${VERSION} ready on https://${config.host}:${listeningPort(server)}/mcp; ${describeFolder(deps)}`,
  );
  const stop = (signal: string): void => {
    logInfo(`${signal}: shutting down`);
    server.close(() => {
      deps.store?.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    logError('failed to start', error);
    process.exit(1);
  });
}

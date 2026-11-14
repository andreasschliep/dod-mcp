#!/usr/bin/env node
/**
 * Entry point. DOD_TRANSPORT selects the transport (design section 11.3); this version
 * serves stdio. stdout carries JSON-RPC messages only, everything else goes to stderr.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { defaultDeps } from './deps.ts';
import { DodUnavailableError } from './dod/load.ts';
import { logError, logInfo } from './logger.ts';
import { createServer, VERSION } from './server.ts';

async function main(): Promise<void> {
  const transport = process.env.DOD_TRANSPORT?.trim() || 'stdio';
  if (transport !== 'stdio') {
    throw new Error(`DOD_TRANSPORT=${transport} is not supported; use stdio.`);
  }
  const deps = defaultDeps();
  await createServer(deps).connect(new StdioServerTransport());
  try {
    const set = deps.loadSet();
    logInfo(
      `v${VERSION} ready on stdio; ${set.types.size} type file(s) in the DoD folder; history: ${
        set.history?.available ? set.history.backend : 'unavailable'
      }`,
    );
  } catch (error) {
    if (!(error instanceof DodUnavailableError)) throw error;
    logInfo(`v${VERSION} ready on stdio; the DoD folder is not usable yet: ${error.message}`);
  }
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

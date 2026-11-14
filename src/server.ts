/**
 * createServer(): tools, resources and the prompt, independent of the transport.
 * src/main.ts connects it to stdio (and, from phase 4, to HTTPS).
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';
import { defaultDeps, type ServerDeps } from './deps.ts';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { registerTools } from './tools.ts';

export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string })
  .version;

const INSTRUCTIONS =
  "Serves a team's Definition of Done: a base and one file per task type. Order: get_dod with the " +
  "ticket's ticket_type and labels; fetch each evidence criterion's value with the tools it names and " +
  'pass it unchanged to check_dod; answer needs_judgment criteria with rubric://dod/{type}, quoting the ' +
  'material. The server reports met / not_met / needs_judgment per criterion; your assessment is ' +
  "plausible / doubtful; whether an item is done is the team's decision, never yours. Never invent " +
  'evidence and never confirm an attestation yourself. lint_acceptance_criteria checks acceptance ' +
  'criteria against template://{type}. diff_dod compares versions of a type or the base for DoD ' +
  'reviews. The prompt done_check runs the whole check. All tools are read-only.';

export function createServer(deps: ServerDeps = defaultDeps()): McpServer {
  const server = new McpServer(
    { name: 'dod-mcp', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  return server;
}

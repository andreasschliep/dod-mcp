/**
 * Prompt template done_check (design section 17, F3b): the workflow the model follows to
 * check an item against its DoD. A prompt, not a tool, because collecting evidence and
 * answering judgment questions need the model and the user's other servers. In Claude
 * Code it appears as /dod:done_check.
 */
import { completable, type McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from './deps.ts';

export function doneCheckPrompt(args: { item: string; type?: string | undefined }): string {
  const typeLine = args.type
    ? `The user named the task type "${args.type}"; pass it as type.`
    : 'Pass ticket_type and labels exactly as the ticket shows them; do not guess a type.';
  return [
    `Check the item ${args.item} against its Definition of Done. Read and report only: write nothing into the ticket, the pull request or any other system.`,
    '',
    'Steps:',
    `1. Read the item with the ticket tool you have (ticket type, labels, linked pull request and its current commit, acceptance criteria, comments with confirmations). If you cannot read it, ask the user for these facts.`,
    `2. Call get_dod. ${typeLine} If the result is ambiguous_type, unknown_type or type_conflict, show the hint to the user and ask which type applies; never pick one yourself.`,
    '3. For every evidence criterion, fetch the value with a tool named in fetch_with (or one that clearly delivers the same source). Record source, tool, arguments, retrieved_at (now, ISO 8601 with time zone), the raw value exactly as returned, and for same_ref criteria the commit as ref. Do not retype, round or invent values. If you cannot fetch a value, leave it out; the server reports it as evidence_missing.',
    "4. For every attestation criterion, look for a confirmation in the ticket (comment, approval) and pass it as raw { role, by } with the time it was given. Never confirm on anyone's behalf.",
    '5. Call check_dod with item (id, ticket_type, labels, ref) and the evidence.',
    '6. Read rubric://dod/{type}. For every criterion with status needs_judgment, answer its question from the material with a short quote and location, and assess it as plausible or doubtful. For unexpected_source findings, say whether the source looks equivalent and why.',
    '7. If the ticket has acceptance criteria, call lint_acceptance_criteria with them.',
    "8. Report in the user's language:",
    '   - a table: criterion · origin · server status · your assessment (judgment only) · evidence or finding · who decides;',
    '   - what is missing and how to get it (the hints from check_dod);',
    '   - the lint findings, if any;',
    '   - the DoD version (dod_version) you checked against.',
    '',
    "End with: whether the item is done is the team's decision. Do not call it done yourself.",
  ].join('\n');
}

export function registerPrompts(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    'done_check',
    {
      title: 'Done check',
      description:
        'Check an item against its Definition of Done: determine the type, collect evidence with your ' +
        'other servers, run check_dod, answer the judgment questions with the rubric, and report per ' +
        'criterion. Writes nothing; the team decides whether the item is done.',
      argsSchema: z.object({
        item: z.string().describe('Ticket id or link, e.g. DEMO-42'),
        type: completable(
          z.string().optional().describe('Task type, only if the ticket does not show it'),
          (value) => {
            try {
              return [...deps.loadSet().types.keys()].filter((t) => t.startsWith(value ?? ''));
            } catch {
              return [];
            }
          },
        ),
      }),
    },
    (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: doneCheckPrompt(args) } }],
    }),
  );
}

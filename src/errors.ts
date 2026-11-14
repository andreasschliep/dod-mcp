/**
 * Tool results (design section 10). Two kinds, deliberately different:
 *
 * - success: the tool did its job. A short text for people, the JSON for clients that
 *   only read text, and structuredContent for programs.
 * - domain error: the tool understood the request but cannot do the job with this
 *   input. isError: true with a stable code and a hint, so the model can correct itself.
 *
 * Protocol errors (unknown tool, malformed request) never get here; the SDK answers them
 * as JSON-RPC errors. A domain error carries no structuredContent, because some clients
 * validate it against the outputSchema even when isError is true.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { logError } from './logger.ts';

export type DomainErrorCode =
  | 'type_missing'
  | 'unknown_type'
  | 'ambiguous_type'
  | 'type_conflict'
  | 'invalid_dod'
  | 'dod_unavailable'
  | 'empty_text'
  | 'unknown_version'
  | 'no_history'
  | 'history_unavailable';

/** Thrown inside the server; turned into an isError result at the tool boundary. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly hint: string;
  constructor(code: DomainErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.hint = hint;
  }
}

export function success(summary: string, data: Record<string, unknown>): CallToolResult {
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(data) },
    ],
    structuredContent: data,
  };
}

export function domainError(error: DomainError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${error.message}\nHint: ${error.hint}` }],
  };
}

/**
 * Runs a tool body. Domain errors become isError results with code and hint. Anything
 * else is a bug: the stack goes to stderr, the client gets no internals.
 */
export async function guarded(
  tool: string,
  body: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof DomainError) return domainError(error);
    logError(`${tool} failed`, error);
    return {
      isError: true,
      content: [
        { type: 'text', text: `internal_error: ${tool} failed unexpectedly. See the server log.` },
      ],
    };
  }
}

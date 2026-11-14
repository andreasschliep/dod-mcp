/**
 * Logging to stderr only. Over stdio, stdout carries the JSON-RPC messages and any
 * other byte there breaks the protocol (design section 11.1).
 */
export function logInfo(message: string): void {
  console.error(`[dod-mcp] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : error;
  console.error(`[dod-mcp] ERROR ${message}${detail === undefined ? '' : `\n${String(detail)}`}`);
}

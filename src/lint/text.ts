/**
 * Text helpers for the lint (design section 8.3): lines, excerpts and literal phrase
 * matching at Unicode word boundaries. Phrases from YAML are escaped, never used as
 * patterns (T7).
 */

export const EXCERPT_CHARS = 120;

export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

export function excerpt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS - 1)}…` : trimmed;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A matcher for one phrase: case-insensitive, at word boundaries, spaces inside the
 * phrase match any run of whitespace.
 */
export function phraseMatcher(phrase: string): RegExp {
  const body = phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'giu');
}

/** Every match of every phrase in a line: 1-based column and the matched text. */
export function findPhrases(
  line: string,
  phrases: readonly string[],
): { column: number; found: string; phrase: string }[] {
  const hits: { column: number; found: string; phrase: string }[] = [];
  for (const phrase of phrases) {
    for (const match of line.matchAll(phraseMatcher(phrase))) {
      hits.push({ column: (match.index ?? 0) + 1, found: match[0], phrase });
    }
  }
  return hits.sort((a, b) => a.column - b.column);
}

/** Replaces inline code spans with spaces, so their content is not linted but columns stay. */
export function blankCodeSpans(line: string): string {
  return line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
}

/** A list item: "- x", "* x", "+ x", "1. x", "1) x". */
export const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/;

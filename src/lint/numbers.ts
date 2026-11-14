/**
 * numbers_need_units (design section 8.3): a number in an acceptance criterion needs a
 * unit or the noun it counts. Deterministic token rules:
 *
 * - Only tokens that are a number as a whole count ("2", "0,5", "1.5"); dates, times,
 *   versions, ids ("14.11.2026", "09:30", "1.2.3", "DEMO-42") do not.
 * - A unit attached to the number ("30%", "200ms") is fine, as is any other attached
 *   suffix ("2x", "3D"): only bare numbers are reported.
 * - A bare number is fine if the next token is a unit from the list, or a capitalised
 *   word (a German noun: "3 Einträge"). Ranges ("2 bis 5 Sekunden", "2–5 s") take the
 *   unit at the end.
 * - A list number at the start of a line ("1." or "1)") is not a quantity.
 */

const NUMBER = /^\d+(?:[.,]\d+)?$/;
const RANGE = /^\d+(?:[.,]\d+)?[-–]\d+(?:[.,]\d+)?$/;
const LIST_MARKER = /^\d{1,3}[.)]$/;
const LEADING = /^[("„“'‚«»[]+/;
const TRAILING = /[)"“”'‘’»«\]]*[.,;:!?]*[)"“”'‘’»«\]]*$/;
const RANGE_WORDS = new Set(['bis', 'und', 'oder', 'to', 'and', 'or', '-', '–']);

interface Token {
  raw: string;
  core: string;
  column: number;
  /** The raw token ended in punctuation, so the next token cannot be its unit. */
  closed: boolean;
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  for (const match of line.matchAll(/\S+/g)) {
    const raw = match[0];
    const lead = LEADING.exec(raw)?.[0].length ?? 0;
    const withoutLead = raw.slice(lead);
    const trail = TRAILING.exec(withoutLead)?.[0] ?? '';
    const core = withoutLead.slice(0, withoutLead.length - trail.length);
    tokens.push({
      raw,
      core,
      column: (match.index ?? 0) + lead + 1,
      closed: /[.,;:!?]/.test(trail),
    });
  }
  return tokens;
}

export function numbersWithoutUnit(
  line: string,
  units: readonly string[],
): { column: number; number: string }[] {
  const unitSet = new Set(units.map((u) => u.toLowerCase()));
  const tokens = tokenize(line);
  const isUnit = (t: Token | undefined): boolean =>
    t !== undefined && (unitSet.has(t.core.toLowerCase()) || /^\p{Lu}/u.test(t.core));
  const hits: { column: number; number: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (i === 0 && LIST_MARKER.test(t.raw)) continue;
    const isNumber = NUMBER.test(t.core);
    const isRange = RANGE.test(t.core);
    // "30%", "200ms", "2x", dates, ids: only bare numbers and ranges count.
    if (!isNumber && !isRange) continue;
    if (t.closed) {
      hits.push({ column: t.column, number: t.core });
      continue;
    }
    const next = tokens[i + 1];
    if (isUnit(next)) continue;
    // "2 bis 5 Sekunden": the unit after the second number counts for both.
    if (
      isNumber &&
      next &&
      RANGE_WORDS.has(next.core.toLowerCase()) &&
      !next.closed &&
      tokens[i + 2] &&
      NUMBER.test(tokens[i + 2]!.core)
    ) {
      const second = tokens[i + 2]!;
      if (!second.closed && isUnit(tokens[i + 3])) {
        i += 2;
        continue;
      }
    }
    hits.push({ column: t.column, number: t.core });
  }
  return hits;
}

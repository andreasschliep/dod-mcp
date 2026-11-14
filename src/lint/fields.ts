/**
 * fields (design section 8.3): required fields such as "Zweck:" or "Frist:", list
 * fields with a minimum number of items, and formats for dates and durations.
 */
import type { FieldFormat, FieldSpec } from '../dod/model.ts';
import { LIST_ITEM } from './text.ts';

export type FieldProblem =
  | { code: 'field_missing'; line: 1; message: string }
  | { code: 'field_empty' | 'list_too_short' | 'field_format'; line: number; message: string };

/** A line that starts a field: "Name:", also as a list item or in bold. */
const ANY_FIELD = /^\s*(?:[-*+]\s+)?(?:\*\*)?\p{L}[\p{L}\p{N} -]{0,39}(?:\*\*)?\s*:/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A Markdown heading "## Name" (optionally bold, optionally with a colon) starts a field too. */
const ANY_HEADING = /^\s{0,3}#{1,6}\s/;

function headingLine(name: string): RegExp {
  return new RegExp(
    `^\\s{0,3}#{1,6}\\s+(?:\\*\\*)?${escapeRegExp(name)}(?:\\*\\*)?\\s*:?\\s*$`,
    'iu',
  );
}

function fieldLine(name: string): RegExp {
  return new RegExp(
    `^\\s*(?:[-*+]\\s+)?(?:\\*\\*)?${escapeRegExp(name)}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.*)$`,
    'iu',
  );
}

const PLACEHOLDER = /^<[^>]*>$/;
const DATE_DE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DURATION =
  /^\d+(?:[.,]\d+)?\s*(?:Arbeitstage?n?|Werktage?n?|Tage?n?|Stunden?|Std\.?|h|Wochen?|Minuten?|min|working days?|business days?|days?|hours?|weeks?)$/iu;

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isDate(value: string): boolean {
  const de = DATE_DE.exec(value);
  if (de) return validDate(Number(de[3]), Number(de[2]), Number(de[1]));
  const iso = DATE_ISO.exec(value);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return false;
}

function matchesFormat(value: string, format: FieldFormat): boolean {
  if (format === 'date') return isDate(value);
  if (format === 'duration') return DURATION.test(value);
  return isDate(value) || DURATION.test(value);
}

const FORMAT_LABEL: Record<FieldFormat, string> = {
  date: 'a date (TT.MM.JJJJ or YYYY-MM-DD)',
  duration: 'a duration such as "2 Arbeitstage"',
  date_or_duration: 'a date (TT.MM.JJJJ) or a duration such as "2 Arbeitstage"',
};

export function checkFields(lines: string[], fields: readonly FieldSpec[]): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const spec of fields) {
    const pattern = fieldLine(spec.name);
    const heading = headingLine(spec.name);
    const index = lines.findIndex((l) => pattern.test(l) || heading.test(l));
    if (index < 0) {
      problems.push({
        code: 'field_missing',
        line: 1,
        message: `Field "${spec.name}:" is missing.`,
      });
      continue;
    }
    const lineNo = index + 1;
    const isHeading = heading.test(lines[index]!);
    const inline = isHeading
      ? ''
      : (pattern.exec(lines[index]!)?.[1] ?? '').replace(/\*\*$/, '').trim();

    // A "Name:" field runs to the next blank line or field; a "## Name" section runs to
    // the next heading, blank lines included.
    const following: string[] = [];
    for (let i = index + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (isHeading) {
        if (ANY_HEADING.test(l)) break;
        if (l.trim() !== '') following.push(l);
        continue;
      }
      if (l.trim() === '') break;
      if (!LIST_ITEM.test(l) && ANY_FIELD.test(l)) break;
      following.push(l);
    }

    if (spec.list) {
      const items = following.filter((l) => LIST_ITEM.test(l) && !isPlaceholderItem(l)).length;
      const count = items + (inline !== '' && !PLACEHOLDER.test(inline) ? 1 : 0);
      const min = spec.min_items ?? 1;
      if (count < min) {
        problems.push({
          code: 'list_too_short',
          line: lineNo,
          message: `Field "${spec.name}:" lists ${count} item${count === 1 ? '' : 's'}; at least ${min} required.`,
        });
      }
      continue;
    }

    const value = (inline !== '' ? inline : (following[0]?.trim() ?? '')).replace(/[.;]$/, '');
    if (value === '' || PLACEHOLDER.test(value)) {
      problems.push({
        code: 'field_empty',
        line: lineNo,
        message:
          value === ''
            ? `Field "${spec.name}:" is empty.`
            : `Field "${spec.name}:" still holds the template placeholder.`,
      });
      continue;
    }
    if (spec.format && !matchesFormat(value, spec.format)) {
      problems.push({
        code: 'field_format',
        line: lineNo,
        message: `Field "${spec.name}:" is "${value}"; expected ${FORMAT_LABEL[spec.format]}.`,
      });
    }
  }
  return problems;
}

function isPlaceholderItem(line: string): boolean {
  const content = line.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '').trim();
  return PLACEHOLDER.test(content);
}

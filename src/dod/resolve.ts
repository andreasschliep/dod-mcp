/**
 * Type resolution (design section 7): ticket type and labels must give exactly one task
 * type. There is no default type. An explicit `type` may choose among the candidates.
 */
import { DomainError } from '../errors.ts';
import type { DodSet, ValidationError } from './model.ts';
import { normaliseName } from './validate.ts';

export interface ResolutionInput {
  type?: string | undefined;
  ticket_type?: string | undefined;
  labels?: string[] | undefined;
}

export interface Trigger {
  via: 'ticket_type' | 'label';
  value: string;
  type: string;
}

export interface Resolution {
  type: string;
  via: 'explicit' | 'ticket_type' | 'label';
  candidates: string[];
  triggers: Trigger[];
}

export function resolveType(set: DodSet, input: ResolutionInput): Resolution {
  const explicit = input.type?.trim() || undefined;
  const ticketType = input.ticket_type?.trim() || undefined;
  const labels = (input.labels ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  const hasTicketData = ticketType !== undefined || labels.length > 0;

  if (!explicit && !hasTicketData) {
    throw new DomainError(
      'type_missing',
      'Neither type nor ticket_type nor labels given.',
      `Pass ticket_type and labels as they are in the ticket. ${known(set)}`,
    );
  }

  if (explicit && !set.types.has(explicit)) {
    throw new DomainError(
      'unknown_type',
      `There is no type file ${explicit}.yaml.`,
      `Known types: ${[...set.types.keys()].join(', ') || 'none'}.`,
    );
  }

  let triggers: Trigger[] = [];
  if (hasTicketData) {
    const mapping = set.mapping.parsed;
    if (!mapping) {
      if (explicit) return { type: explicit, via: 'explicit', candidates: [], triggers: [] };
      throw invalidDod(set.mapping.errors, 'types.yaml');
    }
    triggers = collectTriggers(mapping.entries, ticketType, labels);
  }
  const candidates = unique(triggers.map((t) => t.type));

  if (explicit) {
    if (candidates.length > 0 && !candidates.includes(explicit)) {
      throw new DomainError(
        'type_conflict',
        `type "${explicit}" does not fit the ticket: ${describe(triggers)}.`,
        `Use one of the candidates (${candidates.join(', ')}) or fix the ticket type and labels.`,
      );
    }
    return { type: explicit, via: 'explicit', candidates, triggers };
  }

  if (candidates.length === 0) {
    throw new DomainError(
      'unknown_type',
      `No task type for ${describeInput(ticketType, labels)}.`,
      `${known(set)} Or pass type explicitly.`,
    );
  }
  if (candidates.length > 1) {
    throw new DomainError(
      'ambiguous_type',
      `The ticket fits several task types: ${describe(triggers)}.`,
      `Fix the labels in the ticket or pass type with one of: ${candidates.join(', ')}.`,
    );
  }
  const first = triggers[0]!;
  return { type: first.type, via: first.via, candidates, triggers };
}

function collectTriggers(
  entries: { type: string; ticket_types: string[]; labels: string[] }[],
  ticketType: string | undefined,
  labels: string[],
): Trigger[] {
  const triggers: Trigger[] = [];
  if (ticketType !== undefined) {
    const key = normaliseName(ticketType);
    for (const entry of entries) {
      if (entry.ticket_types.some((t) => normaliseName(t) === key)) {
        triggers.push({ via: 'ticket_type', value: ticketType, type: entry.type });
      }
    }
  }
  for (const label of labels) {
    const key = normaliseName(label);
    for (const entry of entries) {
      if (entry.labels.some((l) => normaliseName(l) === key)) {
        triggers.push({ via: 'label', value: label, type: entry.type });
      }
    }
  }
  return triggers;
}

function describe(triggers: Trigger[]): string {
  return triggers.map((t) => `${t.value} → ${t.type}`).join(', ');
}

function describeInput(ticketType: string | undefined, labels: string[]): string {
  const parts: string[] = [];
  if (ticketType !== undefined) parts.push(`ticket type "${ticketType}"`);
  if (labels.length > 0) parts.push(`labels ${labels.map((l) => `"${l}"`).join(', ')}`);
  return parts.join(' and ');
}

function known(set: DodSet): string {
  const entries = set.mapping.parsed?.entries ?? [];
  const ticketTypes = entries.flatMap((e) => e.ticket_types);
  const labels = entries.flatMap((e) => e.labels);
  return (
    `Known ticket types: ${ticketTypes.join(', ') || 'none'}. ` +
    `Known labels: ${labels.join(', ') || 'none'}. ` +
    `Types: ${[...set.types.keys()].join(', ') || 'none'}.`
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function formatErrors(errors: ValidationError[]): string {
  return errors
    .map(
      (e) =>
        `  ${e.file}:${e.line}:${e.column} ${e.code}: ${e.message}` +
        (e.related ? ` (see ${e.related.file}:${e.related.line})` : ''),
    )
    .join('\n');
}

export function invalidDod(errors: ValidationError[], what: string): DomainError {
  return new DomainError(
    'invalid_dod',
    `The DoD for ${what} is invalid (${errors.length} error${errors.length === 1 ? '' : 's'}).\n${formatErrors(errors)}`,
    'Fix the file by pull request; the server rereads the folder on every request.',
  );
}

/**
 * The tools (design section 8). All read-only: they read the DoD folder and the input,
 * and return findings. None of them writes to a ticket, a pull request or a file.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { checkDod, type CheckInput, type CheckResult } from './check/checkDod.ts';
import { loadForTool, storeForHistory, type ServerDeps } from './deps.ts';
import { diffSides, type Comparable, type DiffResult, type Side } from './diff/diffDod.ts';
import { loadBaseVersion, loadEdition } from './dod/history.ts';
import type { MergedDod } from './dod/merge.ts';
import { resolveType, type Resolution, type ResolutionInput } from './dod/resolve.ts';
import { dodView, requireDod, typesOverview } from './dod/view.ts';
import { DomainError, guarded, success } from './errors.ts';
import { lintAcceptance } from './lint/lint.ts';
import {
  diffInput,
  diffOutput,
  checkDodInput,
  checkDodOutput,
  getDodInput,
  getDodOutput,
  lintInput,
  lintOutput,
} from './schemas.ts';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function resolutionText(r: Resolution): string {
  if (r.via === 'explicit') {
    return r.candidates.length > 1
      ? `chosen explicitly among ${r.candidates.join(', ')}`
      : 'chosen explicitly';
  }
  const trigger = r.triggers[0];
  return trigger ? `via ${r.via} "${trigger.value}"` : `via ${r.via}`;
}

export function runGetDod(args: ResolutionInput, deps: ServerDeps): CallToolResult {
  const set = loadForTool(deps);
  const asked = Boolean(args.type?.trim() || args.ticket_type?.trim() || args.labels?.length);
  if (!asked) {
    const overview = typesOverview(set, deps.store);
    const types = overview.types as { type: string; valid: boolean; dod_version: string | null }[];
    const lines = [
      `DoD task types (${types.length}):`,
      ...types.map(
        (t) => `- ${t.type}: ${t.valid ? t.dod_version : 'invalid, read dod://type/' + t.type}`,
      ),
      'Call get_dod with ticket_type and labels from the ticket to get the criteria of one type.',
    ];
    return success(lines.join('\n'), { overview });
  }
  const resolution = resolveType(set, args);
  const dod = requireDod(set, resolution.type);
  const count = (k: string) => dod.criteria.filter((c) => c.check === k).length;
  const lines = [
    `${dod.type} (${dod.dod_version}, ${resolutionText(resolution)}): ${dod.criteria.length} criteria, ` +
      `${count('evidence')} evidence, ${count('judgment')} judgment, ${count('attestation')} attestation.`,
    ...dod.criteria.map((c) => {
      const extra =
        c.check === 'evidence'
          ? ` [fetch with ${(c.fetch_with ?? []).join(' or ') || c.source}]`
          : c.check === 'attestation'
            ? ` [confirmed by ${c.role}]`
            : '';
      return `- ${c.id} (${c.origin}, ${c.check}): ${c.text}${extra}`;
    }),
    `Rubric: rubric://dod/${dod.type}. Template: template://${dod.type}.`,
  ];
  return success(lines.join('\n'), { resolution, dod: dodView(set, dod) });
}

const STATUS_LABEL = { met: 'met', not_met: 'not met', needs_judgment: 'needs judgment' } as const;

export function checkSummary(result: CheckResult): string {
  const rows = result.criteria.map((c) => {
    const finding = c.findings
      .filter((f) => f.code !== 'multiple_evidence')
      .map((f) => f.code)
      .join(', ');
    return `| ${c.id} | ${c.origin} | ${c.check} | ${STATUS_LABEL[c.status]} | ${finding || '–'} | ${c.hint ?? c.question ?? ''} |`;
  });
  const s = result.summary;
  return [
    `check_dod ${result.item.id}: ${result.dod_version}, as of ${result.as_of}.`,
    '',
    '| Criterion | Origin | Check | Status | Finding | Hint or question |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `${s.met} met, ${s.not_met} not met, ${s.needs_judgment} need judgment` +
      (result.unused_evidence.length
        ? `; ${result.unused_evidence.length} piece(s) of evidence for unknown criteria.`
        : '.'),
    `Answer the judgment questions with rubric://dod/${result.type}. Whether ${result.item.id} is done is the team's decision.`,
  ].join('\n');
}

export function runCheckDod(
  args: z.output<typeof checkDodInput>,
  deps: ServerDeps,
): CallToolResult {
  const set = loadForTool(deps);
  const resolution = resolveType(set, args.item);
  const dod = requireDod(set, resolution.type);
  const input: CheckInput = { item: args.item, evidence: args.evidence, as_of: args.as_of };
  const result = checkDod(dod, resolution, input, deps.now());
  return success(checkSummary(result), result as unknown as Record<string, unknown>);
}

export function runLint(args: z.output<typeof lintInput>, deps: ServerDeps): CallToolResult {
  if (args.text.trim() === '') {
    throw new DomainError(
      'empty_text',
      'The text is empty.',
      'Pass the acceptance criteria from the ticket as text.',
    );
  }
  const set = loadForTool(deps);
  const resolution = resolveType(set, args);
  const dod = requireDod(set, resolution.type);
  const result = lintAcceptance(args.text, dod.type, dod.rules);
  const lines = [
    `lint_acceptance_criteria (${dod.dod_version}): ${result.summary.error} error(s), ${result.summary.warning} warning(s).`,
    ...result.findings.map(
      (f) =>
        `- line ${f.line}:${f.column} [${f.severity}] ${f.code} (${f.rule}): ${f.message} ${f.hint}`,
    ),
  ];
  if (result.findings.length === 0) lines.push(`No findings. Template: template://${dod.type}.`);
  if (result.truncated) lines.push(`Only the first ${result.findings.length} findings are shown.`);
  return success(lines.join('\n'), {
    type: dod.type,
    dod_version: dod.dod_version,
    resolution,
    ...result,
  });
}

function sideOf(dod: MergedDod, firstSeen: string | null): Side {
  return {
    label: dod.dod_version,
    first_seen_at: firstSeen,
    criteria: dod.criteria as unknown as Comparable[],
    rules: dod.rules as unknown as Comparable[],
    template: dod.template,
  };
}

function unknownVersion(file: string, version: number, recorded: number[]): DomainError {
  return new DomainError(
    'unknown_version',
    `Version ${version} of ${file} is not in the history.`,
    `Recorded versions: ${recorded.join(', ') || 'none'}. The history starts with the first sync.`,
  );
}

function noHistory(file: string, recorded: number[]): DomainError {
  return new DomainError(
    'no_history',
    `There is no earlier version of ${file} to compare with (recorded: ${recorded.join(', ') || 'none'}).`,
    'The history starts with the first sync; versions before that are only in Git.',
  );
}

function previous(recorded: number[], before: number): number | undefined {
  return recorded.filter((v) => v < before).at(-1);
}

export function computeDiff(args: z.output<typeof diffInput>, deps: ServerDeps): DiffResult {
  const set = loadForTool(deps);
  const store = storeForHistory(deps, set);
  if (args.type === 'base') {
    const recorded = store.listVersions('base.yaml').map((v) => v.version);
    const toVersion = args.to ?? recorded.at(-1);
    if (toVersion === undefined) throw noHistory('base.yaml', recorded);
    const fromVersion = args.from ?? previous(recorded, toVersion);
    if (fromVersion === undefined) throw noHistory('base.yaml', recorded);
    const side = (version: number): Side => {
      const base = loadBaseVersion(store, version);
      if (!base) throw unknownVersion('base.yaml', version, recorded);
      const info = store.listVersions('base.yaml').find((v) => v.version === version);
      return {
        label: `base@${version}`,
        first_seen_at: info?.first_seen_at ?? null,
        criteria: base.criteria.map((c) => ({ ...c, origin: 'base' })) as unknown as Comparable[],
        rules: base.rules.map((r) => ({ ...r, origin: 'base' })) as unknown as Comparable[],
      };
    };
    return diffSides('base', side(fromVersion), side(toVersion));
  }

  const file = `${args.type}.yaml`;
  const recorded = store.listVersions(file).map((v) => v.version);
  if (!set.types.has(args.type) && recorded.length === 0) {
    throw new DomainError(
      'unknown_type',
      `There is no type file ${file} and no history for it.`,
      `Known types: ${[...set.types.keys()].join(', ') || 'none'}, or "base".`,
    );
  }
  const stored = (version: number): Side => {
    const edition = loadEdition(store, args.type, version);
    if (!edition) throw unknownVersion(file, version, recorded);
    return sideOf(edition.dod, edition.first_seen_at);
  };
  let to: Side;
  let toVersion: number;
  if (args.to === undefined) {
    const current = requireDod(set, args.type);
    toVersion = current.versions.type;
    to = sideOf(current, store.firstEdition(args.type, toVersion)?.first_seen_at ?? null);
  } else {
    toVersion = args.to;
    to = stored(args.to);
  }
  const fromVersion = args.from ?? previous(recorded, toVersion);
  if (fromVersion === undefined) throw noHistory(file, recorded);
  return diffSides(args.type, stored(fromVersion), to);
}

export function runDiffDod(args: z.output<typeof diffInput>, deps: ServerDeps): CallToolResult {
  const diff = computeDiff(args, deps);
  const show = (v: unknown) => {
    const text = JSON.stringify(v) ?? 'null';
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };
  const lines = [
    `diff_dod ${diff.type}: ${diff.from} → ${diff.to}: ${diff.summary.added} added, ${diff.summary.removed} removed, ${diff.summary.changed} changed${diff.template_changed ? ', template changed' : ''}.`,
  ];
  for (const [what, list] of [
    ['criterion', diff.criteria],
    ['rule', diff.rules],
  ] as const) {
    for (const a of list.added)
      lines.push(
        `+ ${what} ${String(a.id)} (${String(a.origin)})${a.text ? `: ${String(a.text)}` : ''}`,
      );
    for (const r of list.removed)
      lines.push(
        `- ${what} ${String(r.id)} (${String(r.origin)})${r.text ? `: ${String(r.text)}` : ''}`,
      );
    for (const c of list.changed) {
      lines.push(
        `~ ${what} ${c.id} (${c.origin}): ${c.fields.map((f) => `${f.key} ${show(f.from)} → ${show(f.to)}`).join('; ')}`,
      );
    }
  }
  if (
    diff.summary.added + diff.summary.removed + diff.summary.changed === 0 &&
    !diff.template_changed
  ) {
    lines.push('No differences.');
  }
  return success(lines.join('\n'), diff as unknown as Record<string, unknown>);
}

export function registerTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_dod',
    {
      title: 'Get the Definition of Done',
      description:
        'The Definition of Done for a ticket: pass ticket_type and labels as they are in the ticket ' +
        '(or type explicitly). Returns every criterion of base and type with its origin and check kind: ' +
        'evidence (which source and tool deliver it, what value is expected, how old it may be), ' +
        'judgment (a question you answer with rubric://dod/{type}) or attestation (a role confirms). ' +
        'Without arguments: the list of task types. An ambiguous or unknown type is an error with a hint, ' +
        'never a default. Read-only.',
      inputSchema: getDodInput,
      outputSchema: getDodOutput,
      annotations: READ_ONLY,
    },
    (args) => guarded('get_dod', () => runGetDod(args, deps)),
  );

  server.registerTool(
    'check_dod',
    {
      title: 'Check an item against its Definition of Done',
      description:
        'Check the evidence you collected for an item against its DoD. For every evidence criterion, ' +
        'fetch the value with the tool named in get_dod and pass it unchanged: criterion, source, tool, ' +
        'arguments, retrieved_at (ISO 8601 with time zone), raw and, for commits, ref. Never invent or ' +
        'retype values; leave out what you could not fetch. Returns met / not_met / needs_judgment per ' +
        'criterion with findings (evidence_missing, evidence_stale, evidence_other_ref …) and a hint on ' +
        'how to get missing evidence. There is no overall status: the team decides whether the item is ' +
        'done. Read-only; writes nothing to the ticket.',
      inputSchema: checkDodInput,
      outputSchema: checkDodOutput,
      annotations: READ_ONLY,
    },
    (args) => guarded('check_dod', () => runCheckDod(args, deps)),
  );

  server.registerTool(
    'lint_acceptance_criteria',
    {
      title: 'Lint acceptance criteria',
      description:
        'Check acceptance criteria against the rules of their task type: Given/When/Then complete and ' +
        'in order, observable Then steps, vague words, numbers without units, required fields and ' +
        'formats. Pass the text as it is in the ticket plus ticket_type and labels (or type). Every ' +
        'finding has line, column, rule and a hint; template://{type} shows the expected form. ' +
        'Deterministic and read-only; it does not rewrite the text.',
      inputSchema: lintInput,
      outputSchema: lintOutput,
      annotations: READ_ONLY,
    },
    (args) => guarded('lint_acceptance_criteria', () => runLint(args, deps)),
  );

  server.registerTool(
    'diff_dod',
    {
      title: 'Compare two versions of a DoD',
      description:
        'What changed in the Definition of Done of a task type between two versions of its file, ' +
        'each merged with its base, or between two versions of the base (type: "base"). Every added, ' +
        'removed or changed criterion and rule names its origin. Defaults: from the previous recorded ' +
        'version to the DoD in force now. For DoD reviews and retrospectives. Read-only.',
      inputSchema: diffInput,
      outputSchema: diffOutput,
      annotations: READ_ONLY,
    },
    (args) => guarded('diff_dod', () => runDiffDod(args, deps)),
  );
}

/**
 * Rubric and template as Markdown (design section 9). Both are generated from the same
 * files the server checks against, so what the model reads and what the server computes
 * cannot drift apart.
 */
import type { MergedDod, MergedRule } from './dod/merge.ts';
import type { ValidationError } from './dod/model.ts';
import { formatErrors } from './dod/resolve.ts';

export function renderRubric(dod: MergedDod): string {
  const judgments = dod.criteria.filter((c) => c.check === 'judgment');
  const attestations = dod.criteria.filter((c) => c.check === 'attestation');
  const out: string[] = [
    `# Rubric: judgment criteria for ${dod.type}`,
    '',
    `DoD version ${dod.dod_version}, generated from ${dod.files.base} and ${dod.files.type}.`,
    '',
    '## How to judge',
    '',
    '- For each criterion below, answer the question from the material (diff, document, answer, ticket), with a short quote and its location.',
    '- Then assess the criterion as **plausible** or **doubtful**. Never call it plausible without a quote.',
    '- Say when the material is not enough to judge.',
    "- Your assessment is an input for the team. Whether the item is done is the team's decision.",
    '',
  ];
  if (judgments.length === 0) out.push('This type has no judgment criteria.', '');
  for (const c of judgments) {
    if (c.check !== 'judgment') continue;
    out.push(
      `## ${c.id} (${c.origin})`,
      '',
      `Criterion: ${c.text}`,
      '',
      `Question: ${c.question}`,
      '',
    );
    if (c.plausible_if?.length)
      out.push('Plausible if:', ...c.plausible_if.map((s) => `- ${s}`), '');
    if (c.doubtful_if?.length) out.push('Doubtful if:', ...c.doubtful_if.map((s) => `- ${s}`), '');
  }
  if (attestations.length > 0) {
    out.push('## Not for you to decide', '');
    for (const c of attestations) {
      if (c.check !== 'attestation') continue;
      out.push(`- ${c.id} (${c.origin}): ${c.text} Confirmed by the role ${c.role}.`);
    }
    out.push('');
  }
  return out.join('\n');
}

function describeRule(rule: MergedRule): string {
  switch (rule.kind) {
    case 'gherkin':
      return 'every scenario has Given, When and Then (Angenommen/Gegeben, Wenn, Dann), in this order';
    case 'observable_then':
      return `Then steps must not contain: ${rule.phrases.join(', ')}`;
    case 'vague_words':
      return `vague words: ${rule.words.join(', ')}`;
    case 'numbers_need_units':
      return `numbers need a unit (${rule.units.join(', ')}) or a counted noun; a capitalised word after the number counts as the noun`;
    case 'fields':
      return `required fields: ${rule.fields
        .map((f) =>
          f.list
            ? `${f.name} (a list with at least ${f.min_items ?? 1} item${(f.min_items ?? 1) === 1 ? '' : 's'})`
            : f.format
              ? `${f.name} (${f.format.replaceAll('_', ' ')})`
              : f.name,
        )
        .join(', ')}`;
  }
}

export function renderTemplate(dod: MergedDod): string {
  const out: string[] = [
    `# Template for acceptance criteria: ${dod.type}`,
    '',
    `DoD version ${dod.dod_version}.`,
    '',
  ];
  if (dod.template) out.push('```text', dod.template.trimEnd(), '```', '');
  else out.push('This type has no template.', '');
  out.push('## What lint_acceptance_criteria checks for this type', '');
  for (const rule of dod.rules)
    out.push(`- ${rule.id} (${rule.origin}, ${rule.kind}): ${describeRule(rule)}.`);
  out.push('');
  return out.join('\n');
}

export function renderInvalid(type: string, errors: ValidationError[]): string {
  return [
    `# ${type}: invalid`,
    '',
    `The DoD for ${type} is invalid. Fix these lines by pull request; the server rereads the folder on every request.`,
    '',
    '```text',
    formatErrors(errors),
    '```',
    '',
  ].join('\n');
}

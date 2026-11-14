/**
 * lint_acceptance_criteria (design section 8.3): applies the rules of base and type to
 * a text and reports each finding with line, column, excerpt, rule and origin.
 * Deterministic; the lint is an aid for refinement, not a verdict.
 */
import type { MergedRule } from '../dod/merge.ts';
import { checkFields } from './fields.ts';
import { parseScenarios, type StepKind } from './gherkin.ts';
import { numbersWithoutUnit } from './numbers.ts';
import { blankCodeSpans, excerpt, findPhrases, splitLines } from './text.ts';

export type LintCode =
  | 'no_scenario'
  | 'incomplete_scenario'
  | 'step_order'
  | 'unobservable_then'
  | 'vague_word'
  | 'number_without_unit'
  | 'field_missing'
  | 'field_empty'
  | 'list_too_short'
  | 'field_format';

export type Severity = 'error' | 'warning';

export interface LintFinding {
  rule: string;
  origin: string;
  code: LintCode;
  severity: Severity;
  line: number;
  column: number;
  excerpt: string;
  message: string;
  hint: string;
}

export interface LintResult {
  rules_applied: { id: string; kind: MergedRule['kind']; origin: string }[];
  summary: { error: number; warning: number };
  findings: LintFinding[];
  truncated: boolean;
  limits: string[];
}

export const MAX_FINDINGS = 100;

const SEVERITY: Record<LintCode, Severity> = {
  no_scenario: 'error',
  incomplete_scenario: 'error',
  step_order: 'warning',
  unobservable_then: 'warning',
  vague_word: 'warning',
  number_without_unit: 'warning',
  field_missing: 'error',
  field_empty: 'error',
  list_too_short: 'error',
  field_format: 'error',
};

const STEP_LABEL: Record<StepKind, string> = {
  given: 'Given (Angenommen/Gegeben)',
  when: 'When (Wenn)',
  then: 'Then (Dann)',
};
const ORDER: Record<StepKind, number> = { given: 0, when: 1, then: 2 };

export const LINT_LIMITS = [
  'Words and phrases are matched literally; paraphrases are not found.',
  'The number rule takes a capitalised word after a number as the counted noun (German nouns).',
];

export function lintAcceptance(
  text: string,
  type: string,
  rules: readonly MergedRule[],
): LintResult {
  const lines = splitLines(text);
  const scanned = lines.map(blankCodeSpans);
  const findings: LintFinding[] = [];
  const add = (
    rule: MergedRule,
    code: LintCode,
    line: number,
    column: number,
    message: string,
    hint: string,
  ): void => {
    findings.push({
      rule: rule.id,
      origin: rule.origin,
      code,
      severity: SEVERITY[code],
      line,
      column,
      excerpt: excerpt(lines[line - 1] ?? ''),
      message,
      hint,
    });
  };

  let scenarios: ReturnType<typeof parseScenarios> | undefined;
  const getScenarios = () => (scenarios ??= parseScenarios(scanned.join('\n')));

  for (const rule of rules) {
    switch (rule.kind) {
      case 'vague_words':
        scanned.forEach((line, i) => {
          for (const hit of findPhrases(line, rule.words)) {
            add(
              rule,
              'vague_word',
              i + 1,
              hit.column,
              `Vague word "${hit.found}".`,
              'Say what can be observed or measured instead, e.g. a number with a unit.',
            );
          }
        });
        break;

      case 'observable_then':
        for (const scenario of getScenarios()) {
          for (const step of scenario.steps.filter((s) => s.kind === 'then')) {
            const line = scanned[step.line - 1] ?? '';
            for (const hit of findPhrases(line, rule.phrases)) {
              if (hit.column < step.textColumn) continue;
              add(
                rule,
                'unobservable_then',
                step.line,
                hit.column,
                `"${hit.found}" cannot be observed from outside.`,
                'Describe what a tester sees: a message, a value, a state change.',
              );
            }
          }
        }
        break;

      case 'numbers_need_units':
        scanned.forEach((line, i) => {
          for (const hit of numbersWithoutUnit(line, rule.units)) {
            add(
              rule,
              'number_without_unit',
              i + 1,
              hit.column,
              `Number "${hit.number}" has no unit or counted noun.`,
              `Add a unit (${rule.units.slice(0, 5).join(', ')} …) or name what is counted.`,
            );
          }
        });
        break;

      case 'gherkin': {
        const found = getScenarios();
        if (found.length === 0) {
          add(
            rule,
            'no_scenario',
            1,
            1,
            'No scenario with Given/When/Then (Angenommen/Wenn/Dann) found.',
            `Write each criterion as a scenario, see template://${type}.`,
          );
          break;
        }
        for (const scenario of found) {
          const name = scenario.title ? `"${scenario.title}"` : `in line ${scenario.line}`;
          const missing = (['given', 'when', 'then'] as const).filter(
            (k) => !scenario.steps.some((s) => s.kind === k),
          );
          if (missing.length > 0) {
            add(
              rule,
              'incomplete_scenario',
              scenario.line,
              1,
              `Scenario ${name} has no ${missing.map((k) => STEP_LABEL[k]).join(', ')}.`,
              'Complete the scenario: starting situation, action, observable result.',
            );
          }
          let highest = -1;
          for (const step of scenario.steps) {
            if (ORDER[step.kind] < highest) {
              add(
                rule,
                'step_order',
                step.line,
                1,
                `"${step.keyword}" comes after a later step in scenario ${name}.`,
                'Order the steps Given, When, Then; split the scenario if it tests two actions.',
              );
              break;
            }
            highest = Math.max(highest, ORDER[step.kind]);
          }
        }
        break;
      }

      case 'fields':
        for (const problem of checkFields(lines, rule.fields)) {
          add(
            rule,
            problem.code,
            problem.line,
            1,
            problem.message,
            problem.code === 'field_missing'
              ? `Add the field as in template://${type}.`
              : problem.code === 'field_format'
                ? 'Use the format the template shows.'
                : 'Fill in the field with the content the template asks for.',
          );
        }
        break;
    }
  }

  // The same finding from two rules (e.g. a word in two lists) is reported once.
  const seen = new Set<string>();
  const unique = findings
    .sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule))
    .filter((f) => {
      const key = `${f.code}:${f.line}:${f.column}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const shown = unique.slice(0, MAX_FINDINGS);
  return {
    rules_applied: rules.map((r) => ({ id: r.id, kind: r.kind, origin: r.origin })),
    summary: {
      error: unique.filter((f) => f.severity === 'error').length,
      warning: unique.filter((f) => f.severity === 'warning').length,
    },
    findings: shown,
    truncated: unique.length > shown.length,
    limits: LINT_LIMITS,
  };
}

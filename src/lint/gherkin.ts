/**
 * Scenarios and steps in acceptance criteria (design section 8.3), German and English
 * keywords. Recognition is by keyword at the start of a line, after an optional list
 * marker or bold markup; nothing is guessed from prose.
 */
import { splitLines } from './text.ts';

export type StepKind = 'given' | 'when' | 'then';

export interface Step {
  kind: StepKind;
  line: number;
  keyword: string;
  /** Column (1-based) where the step text after the keyword starts. */
  textColumn: number;
  text: string;
}

export interface Scenario {
  line: number;
  title: string | undefined;
  steps: Step[];
}

const SCENARIO =
  /^\s*(?:#{1,6}\s*)?(?:\*\*)?(Szenario|Scenario|Beispiel|Example)(?:\*\*)?\s*:(.*)$/;
const STEP =
  /^(\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)?(?:\*\*)?)(Angenommen|Gegeben sei|Gegeben|Given|Wenn|When|Dann|Then|Und|Aber|And|But)(?:\*\*)?(?=[\s,:]|$)/;

const KIND: Record<string, StepKind | 'and'> = {
  Angenommen: 'given',
  'Gegeben sei': 'given',
  Gegeben: 'given',
  Given: 'given',
  Wenn: 'when',
  When: 'when',
  Dann: 'then',
  Then: 'then',
  Und: 'and',
  Aber: 'and',
  And: 'and',
  But: 'and',
};

interface RawStep {
  line: number;
  keyword: string;
  kind: StepKind | 'and';
  textColumn: number;
  text: string;
}

function parseStep(line: string, lineNo: number): RawStep | undefined {
  const match = STEP.exec(line);
  if (!match) return undefined;
  const keyword = match[2]!;
  const start = match[0].length;
  const rest = line.slice(start);
  const lead = rest.length - rest.trimStart().length;
  return {
    line: lineNo,
    keyword,
    kind: KIND[keyword]!,
    textColumn: start + lead + 1,
    text: rest.trim(),
  };
}

/** And/But continue the previous step; without one before them they are dropped. */
function resolveSteps(raw: RawStep[]): Step[] {
  const steps: Step[] = [];
  let previous: StepKind | undefined;
  for (const r of raw) {
    const kind = r.kind === 'and' ? previous : r.kind;
    if (!kind) continue;
    previous = kind;
    steps.push({ kind, line: r.line, keyword: r.keyword, textColumn: r.textColumn, text: r.text });
  }
  return steps;
}

export function parseScenarios(text: string): Scenario[] {
  const lines = splitLines(text);
  const headers = lines
    .map((l, i) => ({ match: SCENARIO.exec(l), line: i + 1 }))
    .filter((h) => h.match !== null);

  if (headers.length > 0) {
    const scenarios: Scenario[] = [];
    // Steps before the first header form a scenario of their own.
    const before = collect(lines, 1, headers[0]!.line - 1);
    if (before.length > 0)
      scenarios.push({ line: before[0]!.line, title: undefined, steps: resolveSteps(before) });
    headers.forEach((h, i) => {
      const end = i + 1 < headers.length ? headers[i + 1]!.line - 1 : lines.length;
      scenarios.push({
        line: h.line,
        title: h.match![2]!.trim() || undefined,
        steps: resolveSteps(collect(lines, h.line + 1, end)),
      });
    });
    return scenarios;
  }

  // Without headers: blocks separated by blank lines, each with at least one step.
  const scenarios: Scenario[] = [];
  let block: RawStep[] = [];
  let blockStart = 0;
  const flush = (): void => {
    if (block.length > 0)
      scenarios.push({ line: blockStart, title: undefined, steps: resolveSteps(block) });
    block = [];
    blockStart = 0;
  };
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      flush();
      return;
    }
    if (blockStart === 0) blockStart = i + 1;
    const step = parseStep(line, i + 1);
    if (step) block.push(step);
  });
  flush();
  return scenarios;
}

function collect(lines: string[], from: number, to: number): RawStep[] {
  const steps: RawStep[] = [];
  for (let n = from; n <= to; n++) {
    const step = parseStep(lines[n - 1] ?? '', n);
    if (step) steps.push(step);
  }
  return steps;
}

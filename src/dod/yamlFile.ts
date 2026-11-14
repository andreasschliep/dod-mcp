/**
 * YAML with positions (design D6). The `yaml` package keeps a range for every node, so
 * a validation error found on the parsed data can be traced back to file, line and
 * column.
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { LIMITS } from '../config.ts';
import type { Location, ValidationError } from './model.ts';

export type YamlPath = readonly (string | number)[];

export class YamlSource {
  readonly file: string;
  readonly text: string;
  readonly data: unknown;
  private readonly doc: Document.Parsed;
  private readonly lines: LineCounter;

  constructor(file: string, text: string, doc: Document.Parsed, lines: LineCounter, data: unknown) {
    this.file = file;
    this.text = text;
    this.doc = doc;
    this.lines = lines;
    this.data = data;
  }

  /**
   * The location of the node at `path`, or of its key. If the path does not exist (a
   * missing key), the location of the deepest node that does.
   */
  location(path: YamlPath, target: 'node' | 'key' = 'node'): Location {
    let node: unknown = this.doc.contents;
    let offset = rangeStart(node) ?? 0;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      const last = i === path.length - 1;
      if (isMap(node)) {
        const pair = node.items.find(
          (p) => isScalar(p.key) && String(p.key.value) === String(segment),
        );
        if (!pair) break;
        if (last && target === 'key') {
          offset = rangeStart(pair.key) ?? offset;
          break;
        }
        node = pair.value;
        offset = rangeStart(pair.value) ?? rangeStart(pair.key) ?? offset;
      } else if (isSeq(node) && typeof segment === 'number') {
        const item = node.items[segment];
        if (item === undefined) break;
        node = item;
        offset = rangeStart(item) ?? offset;
      } else {
        break;
      }
    }
    const { line, col } = this.lines.linePos(offset);
    return { file: this.file, line, column: col };
  }
}

function rangeStart(node: unknown): number | undefined {
  if (node && typeof node === 'object' && 'range' in node) {
    const range = (node as { range?: unknown }).range;
    if (Array.isArray(range) && typeof range[0] === 'number') return range[0];
  }
  return undefined;
}

/** Parses with the core schema, no custom tags, unique keys and an alias limit (T6). */
export function parseYaml(
  file: string,
  text: string,
): { source: YamlSource; errors: [] } | { source: null; errors: ValidationError[] } {
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
    schema: 'core',
    customTags: [],
    uniqueKeys: true,
  });
  if (doc.errors.length > 0) {
    return {
      source: null,
      errors: doc.errors.map((e) => {
        const pos = e.linePos?.[0] ?? lines.linePos(e.pos[0]);
        return {
          file,
          line: pos.line,
          column: pos.col,
          code: 'yaml_syntax',
          message: firstLine(e.message),
        };
      }),
    };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: LIMITS.yamlAliases });
  } catch (error) {
    return {
      source: null,
      errors: [
        {
          file,
          line: 1,
          column: 1,
          code: 'yaml_syntax',
          message: error instanceof Error ? firstLine(error.message) : 'unreadable YAML',
        },
      ],
    };
  }
  return { source: new YamlSource(file, text, doc, lines, data), errors: [] };
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `path` exists in plain data (to tell a missing key from a wrong value). */
export function existsIn(data: unknown, path: YamlPath): boolean {
  let current: unknown = data;
  for (const segment of path) {
    if (Array.isArray(current) && typeof segment === 'number') {
      if (segment >= current.length) return false;
      current = current[segment];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, String(segment))) return false;
      current = current[String(segment)];
    } else {
      return false;
    }
  }
  return true;
}

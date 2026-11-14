/**
 * Resources (design section 9):
 *
 *   dod://types            overview of base, mapping and every type file
 *   dod://type/{type}      one resource per type file: base and type merged, with origin
 *   template://{type}      template for acceptance criteria and the lint rules
 *   rubric://dod/{type}    judgment criteria with question and standards
 *
 * The three templates have a list callback that enumerates the type files in the folder,
 * so a new file becomes a new resource without code changes. Invalid type files are
 * listed too and show their errors when read. A type without a file is a JSON-RPC error
 * (ResourceNotFoundError); resources have no isError channel.
 */
import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { ServerDeps } from './deps.ts';
import { DodUnavailableError } from './dod/load.ts';
import { effectiveDod } from './dod/merge.ts';
import type { DodSet } from './dod/model.ts';
import { rubricUri, templateUri, typeUri, typesOverview, typeView } from './dod/view.ts';
import { logError } from './logger.ts';
import { renderInvalid, renderRubric, renderTemplate } from './render.ts';

function tryLoad(deps: ServerDeps): DodSet | undefined {
  try {
    return deps.loadSet();
  } catch (error) {
    if (!(error instanceof DodUnavailableError)) logError('loading the DoD folder failed', error);
    return undefined;
  }
}

function listOf(
  deps: ServerDeps,
  uri: (type: string) => string,
  what: string,
  mimeType: string,
): { resources: { uri: string; name: string; title: string; mimeType: string }[] } {
  const set = tryLoad(deps);
  if (!set) return { resources: [] };
  return {
    resources: [...set.types.keys()].map((type) => {
      const result = effectiveDod(set, type);
      return {
        uri: uri(type),
        name: `${what} ${type}`,
        title: result.ok
          ? `${result.dod.title}: ${what} (${result.dod.dod_version})`
          : `${type}: ${what} (invalid)`,
        mimeType,
      };
    }),
  };
}

function completeType(deps: ServerDeps) {
  return (value: string | undefined): string[] => {
    const set = tryLoad(deps);
    return set ? [...set.types.keys()].filter((t) => t.startsWith(value ?? '')) : [];
  };
}

function typeVariable(variables: Record<string, string | string[]>): string {
  const value = variables.type;
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function markdownFor(
  deps: ServerDeps,
  href: string,
  type: string,
  render: typeof renderRubric,
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const set = tryLoad(deps);
  if (!set || !set.types.has(type)) throw new ResourceNotFoundError(href);
  const result = effectiveDod(set, type);
  const text = result.ok ? render(result.dod) : renderInvalid(type, result.errors);
  return { contents: [{ uri: href, mimeType: 'text/markdown', text }] };
}

export function registerResources(server: McpServer, deps: ServerDeps): void {
  server.registerResource(
    'dod-types',
    'dod://types',
    {
      title: 'DoD task types',
      description:
        'Overview of the Definition of Done: the base, the ticket type and label mapping, and every ' +
        'task type with its version label, number of criteria, validity and errors with file and line.',
      mimeType: 'application/json',
    },
    (uri) => {
      let body: Record<string, unknown>;
      try {
        body = typesOverview(deps.loadSet());
      } catch (error) {
        if (!(error instanceof DodUnavailableError)) throw error;
        body = { error: 'dod_unavailable', message: error.message };
      }
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'dod-type',
    new ResourceTemplate('dod://type/{type}', {
      list: () => listOf(deps, typeUri, 'DoD', 'application/json'),
      complete: { type: completeType(deps) },
    }),
    {
      title: 'DoD of a task type',
      description:
        'The Definition of Done of one task type: base and type merged, every criterion with origin ' +
        '(base or the type), file, line and check kind (evidence, judgment, attestation); the rules ' +
        'for acceptance criteria. An invalid type file shows its errors instead.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const type = typeVariable(variables);
      const set = tryLoad(deps);
      const view = set ? typeView(set, type) : undefined;
      if (!view) throw new ResourceNotFoundError(uri.href);
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'acceptance-template',
    new ResourceTemplate('template://{type}', {
      list: () => listOf(deps, templateUri, 'template', 'text/markdown'),
      complete: { type: completeType(deps) },
    }),
    {
      title: 'Template for acceptance criteria',
      description:
        'How acceptance criteria for this task type are written, and which rules ' +
        'lint_acceptance_criteria applies to them.',
      mimeType: 'text/markdown',
    },
    (uri, variables) => markdownFor(deps, uri.href, typeVariable(variables), renderTemplate),
  );

  server.registerResource(
    'dod-rubric',
    new ResourceTemplate('rubric://dod/{type}', {
      list: () => listOf(deps, rubricUri, 'rubric', 'text/markdown'),
      complete: { type: completeType(deps) },
    }),
    {
      title: 'Rubric for judgment criteria',
      description:
        'The judgment criteria of a task type with their questions and the standards for plausible ' +
        'and doubtful; which criteria a named role confirms instead.',
      mimeType: 'text/markdown',
    },
    (uri, variables) => markdownFor(deps, uri.href, typeVariable(variables), renderRubric),
  );
}

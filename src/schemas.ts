/**
 * Input and output schemas of the tools (design section 8), zod v4. The SDK turns them
 * into JSON Schema for tools/list and validates every call against the input schema.
 */
import { z } from 'zod';

const TypeName = z.string().trim().min(1).max(40);
const TicketType = z.string().max(100);
const Labels = z.array(z.string().max(100)).max(50);

export const resolutionFields = {
  type: TypeName.optional().describe(
    'Task type (file name in dod/ without .yaml); usually leave it out and pass ticket_type and labels',
  ),
  ticket_type: TicketType.optional().describe(
    'Ticket or work item type as in the ticket, e.g. "Story"',
  ),
  labels: Labels.optional().describe('Labels of the ticket, as they are'),
};

const Resolution = z.object({
  type: z.string(),
  via: z.enum(['explicit', 'ticket_type', 'label']),
  candidates: z.array(z.string()),
  triggers: z.array(
    z.object({ via: z.enum(['ticket_type', 'label']), value: z.string(), type: z.string() }),
  ),
});

const Item = z.looseObject({ id: z.string() });

export const getDodInput = z.object(resolutionFields);

export const getDodOutput = z.object({
  overview: z
    .looseObject({ types: z.array(z.looseObject({ type: z.string(), valid: z.boolean() })) })
    .optional(),
  resolution: Resolution.optional(),
  dod: z
    .looseObject({
      type: z.string(),
      valid: z.literal(true),
      dod_version: z.string(),
      criteria: z.array(Item),
      rules: z.array(Item),
    })
    .optional(),
});

export const evidenceInput = z.object({
  criterion: z.string().min(1).max(40).describe('Criterion id from get_dod'),
  source: z.string().min(1).max(200).describe('System the value comes from, e.g. "sonarqube"'),
  tool: z
    .string()
    .min(1)
    .max(200)
    .describe('The MCP tool that returned the value, e.g. "get_project_quality_gate_status"'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('The arguments of that tool call'),
  retrieved_at: z.string().max(40).describe('When the value was fetched: ISO 8601 with time zone'),
  raw: z
    .unknown()
    .describe('The value exactly as the tool returned it; for attestations { role, by }'),
  ref: z.string().max(100).optional().describe('The revision the value belongs to (commit)'),
  link: z.string().max(500).optional(),
});

export const checkDodInput = z.object({
  item: z.object({
    id: z.string().min(1).max(100),
    ...resolutionFields,
    ref: z
      .string()
      .max(100)
      .optional()
      .describe('The commit the item is at, for criteria with same_ref'),
  }),
  evidence: z.array(evidenceInput).max(100).default([]),
  as_of: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Reference time for the age of evidence (ISO 8601); default: now'),
});

const Finding = z.object({ code: z.string(), message: z.string() });
const EvidenceView = z.object({
  index: z.number(),
  source: z.string(),
  tool: z.string(),
  retrieved_at: z.string(),
  age_hours: z.number().optional(),
  raw: z.string(),
  ref: z.string().optional(),
  link: z.string().optional(),
});

export const checkDodOutput = z.object({
  item: z.object({ id: z.string(), ref: z.string().optional() }),
  type: z.string(),
  dod_version: z.string(),
  resolution: z.object({ via: z.string(), candidates: z.array(z.string()) }),
  as_of: z.string(),
  summary: z.object({
    criteria: z.number(),
    met: z.number(),
    not_met: z.number(),
    needs_judgment: z.number(),
  }),
  criteria: z.array(
    z.object({
      id: z.string(),
      origin: z.string(),
      check: z.enum(['evidence', 'judgment', 'attestation']),
      text: z.string(),
      status: z.enum(['met', 'not_met', 'needs_judgment']),
      findings: z.array(Finding),
      evidence: EvidenceView.optional(),
      material: z.array(EvidenceView).optional(),
      hint: z.string().optional(),
      question: z.string().optional(),
      rubric: z.string().optional(),
      role: z.string().optional(),
      who_decides: z.enum(['server', 'model_then_team', 'role']),
    }),
  ),
  unused_evidence: z.array(
    z.object({ index: z.number(), criterion: z.string(), reason: z.string() }),
  ),
  decision: z.string(),
  limits: z.array(z.string()),
});

export const lintInput = z.object({
  text: z.string().max(50_000).describe('The acceptance criteria as they are in the ticket'),
  ...resolutionFields,
});

export const lintOutput = z.object({
  type: z.string(),
  dod_version: z.string(),
  resolution: Resolution,
  rules_applied: z.array(z.object({ id: z.string(), kind: z.string(), origin: z.string() })),
  summary: z.object({ error: z.number(), warning: z.number() }),
  findings: z.array(
    z.object({
      rule: z.string(),
      origin: z.string(),
      code: z.string(),
      severity: z.enum(['error', 'warning']),
      line: z.number(),
      column: z.number(),
      excerpt: z.string(),
      message: z.string(),
      hint: z.string(),
    }),
  ),
  truncated: z.boolean(),
  limits: z.array(z.string()),
});

export const diffInput = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe('A task type, or "base" to compare versions of the base'),
  from: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Earlier version of the file; default: the version before `to`'),
  to: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Later version of the file; default: the DoD in force now'),
});

const ListDiff = z.object({
  added: z.array(z.looseObject({ id: z.string() })),
  removed: z.array(z.looseObject({ id: z.string() })),
  changed: z.array(
    z.object({
      id: z.string(),
      origin: z.string(),
      fields: z.array(z.object({ key: z.string(), from: z.unknown(), to: z.unknown() })),
    }),
  ),
});

export const diffOutput = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  criteria: ListDiff,
  rules: ListDiff,
  template_changed: z.boolean(),
  first_seen: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  summary: z.object({ added: z.number(), removed: z.number(), changed: z.number() }),
});

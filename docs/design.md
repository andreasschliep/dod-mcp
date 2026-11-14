# dod-mcp: design

Status: approved 14 November 2026 (answers in section 18), second version. Basis: the concept sketch "Team-MCP-Server Definition of Done" of 14 November 2026, sections 3 and 4. Design and decisions: Andreas Schliep. Drafted with Claude Code. **All data in this repository is fictional.**

Changes from the first draft (answers in section 18): the specification is in English, and so are status and finding codes; a configurable database (SQLite first) keeps every version of the DoD files; the server runs in a Docker container and is reached over HTTPS with a bearer token; the container is defined and tested in this repository. With the version history in place, `diff_dod` and `dod://type/{type}/version/{n}` move from open points into scope.

**In two sentences:** The server reads a team's Definition of Done from versioned YAML files (a shared base and one file per task type), keeps every version in a database, and offers each type as its own resource. It checks evidence that the agent collected through the official servers, and acceptance criteria, deterministically; it reports `met`, `not_met` or `needs_judgment` per criterion with a location, and never declares an item done.

Explainability comes before features. Every part of this design should be explainable in two sentences.

## 1. Goal and non-goals

**Goal.** An agent (Claude Code, Claude Desktop, any MCP client) can ask: "Which DoD applies to this item, what do I have to prove, and what is met with this evidence?" It gets a status per criterion, the evidence or a finding with a hint on how to get it, and for judgment criteria the question with its standard. People and agents read the same files.

**Non-goals.**

- **No "done".** The server has no overall status and no tool that writes to tickets, pull requests or files. The team decides.
- **No fetching of evidence.** The server calls no external API and holds no credentials for other systems (variant B of the sketch, D1).
- **No model call.** The model in the client answers judgment questions (D2).
- **No editing of the DoD through the server.** The YAML files in the team repository are the source of truth and change by pull request. The database records what the server has seen; it is not a second place to edit.
- **No real data.** Only fictional teams, tickets and evidence.

## 2. Context

| Item                    | Checked on 14 Nov 2026                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP specification       | 2026-07-28: stateless; Sampling, Roots and Logging deprecated; Streamable HTTP; servers must validate the `Origin` header                              |
| TypeScript SDK          | `@modelcontextprotocol/server` 2.4.0: `McpServer`, `createMcpHandler` (web-standard, stateless per request), `requireBearerAuth`, `hostHeaderValidationResponse`, `originValidationResponse`. `toNodeHandler` comes from `@modelcontextprotocol/node` 2.1.2 (peer `@modelcontextprotocol/server` ^2.4.0; brings `hono` and `@hono/node-server`) |
| Database                | `node:sqlite` (built into Node.js, SQLite 3.53.4 locally, no warning on Node 26)                                                                      |
| YAML parser             | `yaml` 2.9.1 (positions for every node; `js-yaml` has them only for syntax errors, D6)                                                               |
| Runtime                 | Node.js 26 (LTS since October 2026), locally 26.7.0; Docker Desktop 29.6.2 locally                                                                   |
| Models for this design  | `course-standards-mcp` (findings with line numbers, rubric as a resource, `needs_judgment`), `miro-board-mcp` (domain errors with hints, confirmation before writing) |

## 3. Architecture

```
 Team ── pull request ──> team repository: dod/*.yaml
                                   │ mounted read-only into the container as /dod
                                   ▼
 ┌──────────────────────── Docker container (one per team) ────────────────────────┐
 │ dod-mcp                                                                          │
 │  HTTPS :8443  /mcp     TLS (mounted cert) → Host/Origin check → bearer token    │
 │               /healthz no auth, no data                                          │
 │  per request: sync     read /dod, validate (file + line), record new versions    │
 │  resources            dod://types, dod://type/{type}, …/version/{n},             │
 │                       template://{type}, rubric://dod/{type}                     │
 │  tools (read-only)    get_dod, check_dod, lint_acceptance_criteria, diff_dod     │
 │  store                DodStore interface → SQLite in /data (volume)              │
 └──────────────────────────────────────────────────────────────────────────────────┘
                                   ▲  HTTPS + Authorization: Bearer …
 Person ── reads, decides "done"   │
    │                              │
 Client (Claude Code / Desktop) ───┘   the model collects evidence through the official
                                       servers (SonarQube, Azure DevOps, GitHub, Jira)
                                       and passes it to check_dod
```

The same server also runs over **stdio** for local work and the fast tests (`DOD_TRANSPORT=stdio`); tools, resources and the store are identical (D13).

The server keeps no state in memory between requests. Before each request it reads the DoD folder (a few small files), validates it, and records any new file version in the store. A changed or new file therefore takes effect without a restart, and the history grows on its own.

## 4. Who decides what

Three vocabularies, so you can see who made the call (sketch, section 4):

| Who                  | Words                                   | For what                                                                                  |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Server               | `met` / `not_met` / `needs_judgment`    | each criterion, from evidence and rules, reproducible                                     |
| Model in the client  | `plausible` / `doubtful`                | each judgment criterion, with a quote and a location, by `rubric://dod/{type}`            |
| Team (or a role)     | "done"                                  | the item; a named role confirms attestation criteria                                      |

The concept sketch uses the German words _erfüllt_, _nicht erfüllt_ and _braucht Urteil_ for the server status; they map one to one to `met`, `not_met` and `needs_judgment`.

Each criterion has a check kind (`check`), which decides what the server can do:

| `check`       | The server establishes                                                     | Result without defects | `who_decides`      |
| ------------- | -------------------------------------------------------------------------- | ---------------------- | ------------------ |
| `evidence`    | form, age, revision (commit) and value of the evidence against `expect`     | `met`                  | `server`           |
| `judgment`    | nothing about the substance; passes on question, standard and material      | `needs_judgment`       | `model_then_team`  |
| `attestation` | whether a confirmation by the right role is present, with time and source   | `met`                  | `role`             |

## 5. Data format

### 5.1 Folder and discovery

```text
dod/
  base.yaml            # applies to every type
  types.yaml           # ticket type / label → task type
  software-dev.yaml    # one file per task type
  dokument.yaml
  kundenanfrage.yaml
```

- Every other `*.yaml` in the folder is a type file. **The type name is the file name** without extension (`^[a-z][a-z0-9-]{0,39}$`), and the file's `type` key must equal it. A new type is exactly one new file.
- The folder comes from `DOD_DIR`. Results show file names only, never absolute paths.
- Every file carries `version` (an integer, raised with every change of content) and a header comment; fictional files say so in their first line.
- The effective DoD of a type is called, for example, `kundenanfrage@3+base@3`. This label appears in every result, so a report states which version it checked against.
- Keys are English (as in the sketch's example); criterion texts, questions and templates are in the team's language, German in the fictional data.

### 5.2 Base and type files

```yaml
# FICTIONAL EXAMPLE: dod/kundenanfrage.yaml
type: kundenanfrage
version: 3
title: Kundenanfrage
extends: base                 # required; a type always inherits the base
criteria:
  - id: FRIST
    text: Die erste Antwort ging innerhalb der vereinbarten Frist raus.
    check: evidence
    source: helpdesk.first_response
    expect: { field: first_response_at, not_after: due_at }
    fetch_with: [helpdesk:get_ticket]
  - id: VOLLSTAENDIG
    text: Die Antwort geht auf jede Frage der Anfrage ein.
    check: judgment
    question: Welche Frage der Anfrage bleibt in der Antwort offen?
    plausible_if: [Jede nummerierte Frage hat einen Absatz in der Antwort, der sie beantwortet.]
    doubtful_if: [Eine Frage wird nur mit einem Verweis auf später beantwortet.]
  - id: ZUSAGE
    text: Zusagen zu Preis oder Termin sind freigegeben.
    check: attestation
    role: Vertrieb
acceptance:
  template: |
    Fragen:
    1. …
    Frist: TT.MM.JJJJ oder "2 Arbeitstage"
  rules:
    - id: AK-FELDER
      kind: fields
      fields:
        - { name: Fragen, list: true, min_items: 1 }
        - { name: Frist, format: date_or_duration }
```

**Criterion keys:**

| Key                           | `evidence` | `judgment` | `attestation` | Meaning                                                                          |
| ----------------------------- | ---------- | ---------- | ------------- | -------------------------------------------------------------------------------- |
| `id`                          | required   | required   | required      | `^[A-Z][A-Z0-9-]{1,39}$`, unique across base and type                            |
| `text`                        | required   | required   | required      | the criterion as the team states it                                              |
| `source`                      | required   | –          | –             | where the evidence comes from in business terms, e.g. `sonarqube.quality_gate`   |
| `expect`                      | required   | –          | –             | when the raw value meets the criterion (5.3)                                     |
| `max_age_hours`               | optional   | –          | optional      | older evidence is `evidence_stale`; without it, no age check                     |
| `same_ref`                    | optional   | –          | –             | evidence must belong to the item's revision (commit), else `evidence_other_ref`   |
| `fetch_with`                  | optional   | optional   | optional      | tools that deliver the evidence (`server:tool`); used in hints and checked (8.2) |
| `question`                    | –          | required   | –             | the judgment question, phrased to look for gaps                                  |
| `plausible_if`, `doubtful_if` | –          | optional   | –             | standards for the rubric                                                         |
| `role`                        | –          | –          | required      | the role that confirms                                                           |

A key that does not fit the check kind (say `role` on `evidence`) is an error, not silently ignored.

The tool names in the example data are placeholders (`tickets:`, `ci:`, `scm:`, `helpdesk:`, `docs:`). Only `sonarqube:get_project_quality_gate_status` (SonarQube MCP Server, sketch [S2]) and `course-standards:check_terms` (own server) are real.

### 5.3 What evidence must show (`expect`)

A fixed, small set of operators, exactly one per criterion. `field` optionally picks a key from a raw value that is an object.

| Operator        | Met when                                                                | Example                                                       |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| `equals`        | the value is equal (string, number or boolean)                          | `{ field: status, equals: OK }`                               |
| `one_of`        | the value is one of the listed values                                   | `{ field: result, one_of: [succeeded, partiallySucceeded] }`  |
| `min`, `max`    | number ≥ or ≤ the bound; for lists, their length                        | `{ field: failed, max: 0 }`                                   |
| `present: true` | the value is not empty, not `null`, not an empty list                   | `{ present: true }`                                           |
| `not_after`     | the timestamp in `field` is not later than the timestamp in the named field | `{ field: first_response_at, not_after: due_at }`         |

No regular expressions from YAML (D7). A raw value the operator cannot apply to (missing field, text instead of a number) gives `evidence_invalid`.

### 5.4 Template and rules for acceptance criteria (`acceptance`)

- `template` (type files only): a Markdown skeleton, served as `template://{type}`.
- `rules` (base and type): rules with `id` (`^AK-[A-Z0-9-]+$`), `kind` and parameters. Base rules apply to every type; a type adds its own.

| `kind`               | Parameters                                    | Checks                                                                                           |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `gherkin`            | –                                             | every scenario has Given, When and Then (German and English keywords), in that order             |
| `observable_then`    | `phrases`                                     | Then steps contain nothing unobservable ("versteht", "ist zufrieden", "funktioniert korrekt")     |
| `vague_words`        | `words`                                       | vague words in any line ("schnell", "usw.")                                                      |
| `numbers_need_units` | `units`                                       | numbers without a unit or a counted noun ("unter 2" instead of "unter 2 s")                      |
| `fields`             | `fields: [{name, list?, min_items?, format?}]` | required fields such as `Zweck:`, `Zielgruppe:`; list length; format `date`, `duration`, `date_or_duration` |

A new rule kind is a code change; a new type that uses existing rule kinds is not (D7).

### 5.5 Mapping (`types.yaml`)

```yaml
# FICTIONAL EXAMPLE
version: 1
mappings:
  software-dev: { ticket_types: [Story, Bug], labels: [code] }
  dokument: { ticket_types: [Dokument], labels: [doku] }
  kundenanfrage: { ticket_types: [Anfrage], labels: [kunde] }
```

- Matching ignores case and surrounding whitespace.
- A ticket type or label may map to one task type only; otherwise `types.yaml` is invalid (with line).
- A key without a matching type file is an error. A type file without a mapping is allowed; it is then reachable only with an explicit `type` and marked `mapped: false` in `dod://types`.

### 5.6 Inheritance: add only

A type inherits every criterion and rule of the base and may only add. Three things enforce it:

1. **Strict schema.** There is no key to remove or change anything, and every unknown key is an error. Keys that look like removal or override (`remove`, `exclude`, `omit`, `without`, `override`, `replace`, also plural) get their own, clear error code.
2. **Id collision.** A criterion or rule with an id from the base counts as an override, even with identical content.
3. **`extends: base` is required.** Without it, or with another value, the type would have dropped the base.

**Validation errors.** Each error has file, line, column, code and message; collisions also name the location in the base. The line comes from the YAML node (for a missing key: the node of the parent object).

| Code                         | When                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `yaml_syntax`                | the file is not valid YAML                                                               |
| `missing_key`                | a required key is missing (also per check kind: `question`, `role`, `expect`)            |
| `unknown_key`                | a key is not in the schema or does not fit the check kind                                |
| `invalid_value`              | wrong type, unknown check kind, more than one operator in `expect`                        |
| `base_criterion_overridden`  | a base criterion or rule id in a type file; `override` or `replace`                      |
| `base_criterion_removed`     | `remove`, `exclude`, `omit`, `without`; `extends` missing or not `base`                   |
| `duplicate_id`               | the same id twice in one file                                                            |
| `type_name_mismatch`         | `type` differs from the file name, or the file name breaks the pattern                   |
| `invalid_mapping`            | `types.yaml`: unknown type, ticket type or label assigned twice                          |
| `version_not_bumped`         | the content changed, but `version` is one the store already holds with other content (6.2) |
| `version_regressed`          | `version` is lower than the highest version the store holds for this file                |

Example (tool result, text):

```text
invalid_dod: The DoD for software-dev is invalid (1 error).
  software-dev.yaml:31:7 base_criterion_overridden: Criterion ZWEITE-PERSON is already defined in base.yaml:24. A type may only add to the base.
Hint: If the criterion applies in addition, give it its own id. To change the base, change base.yaml by pull request.
```

**Effect of an error.** An invalid type file disables only that type. It stays visible as a resource and shows its errors there (D5); the tools report `invalid_dod` for that type. An invalid `base.yaml` makes every type invalid. An invalid `types.yaml` stops resolution by ticket type and labels, but an explicit `type` still works.

## 6. Database

### 6.1 What it stores

The YAML files stay the source of truth. The store records **every version of every file the server has seen**, so earlier versions can be read and compared after the files have moved on.

| Table               | Columns                                                                                    | Content                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `dod_file_versions` | `file`, `kind` (`base`/`type`/`mapping`), `version`, `content_sha256`, `content`, `first_seen_at`; key (`file`, `version`) | the full YAML text of each version, and a hash of its normalised content |
| `dod_editions`      | `type`, `type_version`, `base_version`, `first_seen_at`; key (`type`, `type_version`, `base_version`) | which combinations of type and base the server has served                  |

- It stores the **file text, not a parsed model**: an older version is read back through the same loader as a current file. A change of the internal model needs no data migration.
- The hash covers the parsed, normalised content, so a change in comments or formatting alone is not a new version.
- No evidence, no check results, no acceptance criteria, no request data. The store holds only what is already in the team repository (answer 1, section 18).
- Schema migrations are numbered in code and tracked with `PRAGMA user_version`.

### 6.2 Sync before each request

1. Read and validate the folder (section 5).
2. For each valid file: if (`file`, `version`) is new, insert it. If it exists with the same hash, do nothing. If it exists with another hash, the file is invalid (`version_not_bumped`, line of `version:`). If `version` is lower than the highest stored one, the file is invalid (`version_regressed`).
3. For each valid type: record the edition (`type_version`, current `base_version`) if new.

Only valid files are recorded, so the history contains agreements that were actually in force. Inserts use `INSERT OR IGNORE` and run in one transaction; repeating the sync changes nothing (idempotent). The sync writes only to the server's own store, never to the files or another system, so the tools keep `readOnlyHint: true` (D10).

**When the store fails** (disk full, read-only volume): the server keeps serving the current files, logs the error, marks `history: unavailable` in `dod://types`, and only `diff_dod` and the version resource fail with `history_unavailable`.

### 6.3 Versions of a type

`dod://type/{type}/version/{n}` means: **the type file at version n, together with the base version that was in force when the server first saw version n.** The result names the exact combination (`software-dev@3+base@1`). A base change while a type stayed at version n shows up in `diff_dod` with `origin: base`, and in `diff_dod` for `type: base`.

The history starts with the first sync. Versions older than that are only in Git; importing them is an open point (section 16).

### 6.4 Configurable backend

```
DOD_DATABASE=sqlite:/data/dod.sqlite     # container default
DOD_DATABASE=sqlite:local/dod.sqlite     # stdio default (local/ is git-ignored)
DOD_DATABASE=sqlite::memory:             # tests
```

The server uses the store only through a narrow interface (`DodStore`: `recordFileVersion`, `recordEdition`, `latestVersion`, `listVersions`, `getFileVersion`, `firstEdition`, plus `transaction` and `close`). Version 1 implements `sqlite:` with `node:sqlite` (no native addon, no extra dependency). Another backend, for example `postgres:`, is a new implementation of the same interface; any other scheme stops the server at start with a clear message. SQLite in WAL mode serves one container; several replicas on one database would need such a server-based backend.

## 7. Type resolution

The input is the same for `get_dod`, `check_dod` and `lint_acceptance_criteria`: `type`, `ticket_type`, `labels`.

1. Collect candidates for `ticket_type` and for every label from `types.yaml`.
2. **Without `type`:** exactly one candidate → that type (`resolution.via: ticket_type` or `label`). No candidate → `unknown_type`. Several → `ambiguous_type`.
3. **With `type`:** it must be a type file (valid or not), otherwise `unknown_type`. If ticket type and labels give candidates, `type` must be one of them, otherwise `type_conflict`. So an explicit `type` resolves an ambiguity, visibly, as `resolution.via: explicit` with all candidates (question F2).
4. Nothing given → `type_missing`.

There is no default type. Examples with the fictional data: `ticket_type: Story` → `software-dev`; `ticket_type: Epic` → `unknown_type` (the hint lists known ticket types and labels); `ticket_type: Story, labels: [doku]` → `ambiguous_type` (hint: "Story → software-dev, doku → dokument. Fix the labels in the ticket or pass `type` with one of the candidates.").

## 8. Tools

All four are read-only (`readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`). Each returns a short Markdown summary, the JSON as text, and `structuredContent` that matches an `outputSchema` (zod v4). Domain errors come as `isError` with `code`, message and `hint`, without `structuredContent` (lesson from `miro-board-mcp`: the Inspector validates it against the schema otherwise).

### 8.1 `get_dod`

```ts
input = z.object({
  type: z.string().optional(),
  ticket_type: z.string().max(100).optional(),
  labels: z.array(z.string().max(100)).max(50).optional(),
});
```

- With input: the merged DoD of the resolved type, the same shape as `dod://type/{type}`, plus `resolution`. Every evidence criterion carries `source`, `expect`, `max_age_hours`, `same_ref` and `fetch_with`, so the agent knows what to collect.
- Without input: the overview, like `dod://types`. This helps clients that do not read resources on their own.
- Domain errors: `unknown_type`, `ambiguous_type`, `type_conflict`, `invalid_dod`, `dod_unavailable`.

### 8.2 `check_dod`

```ts
const Evidence = z.object({
  criterion: z.string(),                  // criterion id
  source: z.string().max(200),            // system, e.g. "sonarqube"
  tool: z.string().max(200),              // MCP tool that delivered the value
  arguments: z.record(z.string(), z.unknown()).optional(), // to retrace the call
  retrieved_at: z.string(),               // ISO 8601 with time zone
  raw: z.unknown(),                       // raw value as the tool returned it (≤ 10 KB serialised)
  ref: z.string().max(100).optional(),    // revision the value belongs to (commit)
  link: z.string().url().max(500).optional(),
});
input = z.object({
  item: z.object({
    id: z.string().min(1).max(100),
    type: z.string().optional(),
    ticket_type: z.string().optional(),
    labels: z.array(z.string()).max(50).optional(),
    ref: z.string().max(100).optional(),  // the item's current commit
  }),
  evidence: z.array(Evidence).max(100).default([]),
  as_of: z.string().optional(),           // reference time for age; default: now
});
```

The server checks timestamps itself, not in the schema, so a broken piece of evidence affects only its criterion and not the whole call.

**Per criterion.** If there are several pieces of evidence, the most recent one with a readable timestamp decides; the finding `multiple_evidence` names the others.

| Check kind                | Situation                                                                                   | Status           | Finding                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------- |
| `evidence`, `attestation` | no evidence                                                                                 | `not_met`        | `evidence_missing` / `attestation_missing` (F1) |
| `evidence`, `attestation` | timestamp unreadable, without time zone, or after `as_of`; raw value does not fit `expect`  | `not_met`        | `evidence_invalid`                            |
| `evidence`, `attestation` | older than `max_age_hours`                                                                  | `not_met`        | `evidence_stale`                              |
| `evidence`                | `same_ref`, but item or evidence has no `ref`                                               | `not_met`        | `ref_missing`                                 |
| `evidence`                | `same_ref` and the refs differ (equal also when one is a prefix of the other, from 7 characters) | `not_met`   | `evidence_other_ref`                          |
| `evidence`                | the value does not meet `expect`                                                            | `not_met`        | `expectation_not_met`                         |
| `attestation`             | `raw.role` is not the required role, or `raw.by` is empty                                    | `not_met`        | `role_mismatch`                               |
| `evidence`, `attestation` | otherwise sound, but `tool` is not in `fetch_with`                                          | `needs_judgment` | `unexpected_source`                           |
| `evidence`, `attestation` | sound                                                                                       | `met`            | –                                             |
| `judgment`                | always; evidence passed for it appears as material                                          | `needs_judgment` | –                                             |

- **Tool matching** compares only the tool name after the last `:` or `__`. `mcp__sonarqube__get_project_quality_gate_status`, `sonarqube:get_project_quality_gate_status` and `get_project_quality_gate_status` all match; every client names its servers itself.
- **Hint per finding.** For `evidence_missing`, `evidence_stale`, `evidence_other_ref` and `ref_missing`, the `hint` says which tool to use and for which revision, e.g. "Fetch with get_project_quality_gate_status for commit 9f2c1ab." For `attestation_missing`: "Ask the role Betrieb to confirm; the agent does not confirm on its own."
- **Reproducible.** `as_of` is part of the result. The same input with the same `as_of` gives the same output.
- **Evidence for unknown criteria** is not an error; it is listed under `unused_evidence`.
- **No overall status.** The summary only counts. The text ends with "Whether DEMO-42 is done is the team's decision."

Output (shortened, fictional):

```jsonc
{
  "item": { "id": "DEMO-42", "ref": "9f2c1ab" },
  "type": "software-dev",
  "dod_version": "software-dev@4+base@3",
  "resolution": { "via": "ticket_type", "candidates": ["software-dev"] },
  "as_of": "2026-11-14T10:00:00Z",
  "summary": { "criteria": 9, "met": 4, "not_met": 3, "needs_judgment": 2 },
  "criteria": [
    {
      "id": "QUALITY-GATE", "origin": "software-dev", "check": "evidence",
      "text": "Das Quality Gate ist für den geprüften Commit grün.",
      "status": "not_met",
      "evidence": { "source": "sonarqube", "tool": "get_project_quality_gate_status",
                    "retrieved_at": "2026-11-14T09:40:00Z", "age_hours": 0.3,
                    "raw": "{\"status\":\"OK\"}", "ref": "71be0d4" },
      "findings": [{ "code": "evidence_other_ref",
                     "message": "The evidence belongs to 71be0d4; the item is at 9f2c1ab." }],
      "hint": "Fetch with get_project_quality_gate_status for commit 9f2c1ab.",
      "who_decides": "server"
    },
    {
      "id": "FOLGEARBEIT", "origin": "base", "check": "judgment",
      "status": "needs_judgment",
      "question": "Welche offene Folgearbeit aus dem Ergebnis ist noch nicht als eigenes Item erfasst?",
      "rubric": "rubric://dod/software-dev",
      "who_decides": "model_then_team"
    }
  ],
  "unused_evidence": [],
  "limits": ["Evidence comes from the agent; the server checks its form, age, revision and value, not its authenticity."]
}
```

Raw values are cut to 200 characters in the output.

### 8.3 `lint_acceptance_criteria`

```ts
input = z.object({
  text: z.string().max(50_000),
  type: z.string().optional(),
  ticket_type: z.string().optional(),
  labels: z.array(z.string()).max(50).optional(),
});
```

Text only, no file path: acceptance criteria live in the ticket, and the agent passes them (D14). The server applies the rules of base and type and reports each finding with line (1-based, relative to `text`), column, excerpt (≤ 120 characters), rule id, origin, message and hint. A field that is missing entirely points to line 1.

| Rule kind            | Finding                                                        | Severity  |
| -------------------- | -------------------------------------------------------------- | --------- |
| `gherkin`            | `no_scenario`, `incomplete_scenario`                           | `error`   |
| `gherkin`            | `step_order` (Given after When, When after Then)               | `warning` |
| `observable_then`    | `unobservable_then`                                            | `warning` |
| `vague_words`        | `vague_word`                                                   | `warning` |
| `numbers_need_units` | `number_without_unit`                                          | `warning` |
| `fields`             | `field_missing`, `field_empty`, `list_too_short`, `field_format` | `error` |

**Deterministic recognition:**

- **Scenarios.** A line `Szenario:` or `Scenario:` starts a scenario. Without such lines, every block separated by blank lines that contains at least one step is a scenario. Steps are recognised at the start of a line (after a list marker): `Angenommen`, `Gegeben (sei)`, `Given`; `Wenn`, `When`; `Dann`, `Then`; `Und`, `Aber`, `And`, `But` continue the previous step.
- **Words and phrases.** Case-insensitive, at Unicode word boundaries, literal, never as a regular expression.
- **Numbers.** Only tokens that consist entirely of a number (`2`, `0,5`, `30%`). Dates, times, versions, ids and list numbers at the start of a line do not count. A number is fine if a unit is attached, or if a unit from `units` or a capitalised word follows (a German noun: "3 Einträge"). For ranges ("2 bis 5 Sekunden", "2–5 s") the unit at the end counts.
- **Fields.** A line `Name:` (also as a list item or in bold). A list is the list lines up to the next blank line or the next field.

Output: `{ type, dod_version, resolution, rules_applied: [{id, kind, origin}], summary: {error, warning}, findings: [...], truncated }`, at most 100 findings.

### 8.4 `diff_dod`

```ts
input = z.object({
  type: z.string(),                       // a type name, or "base"
  from: z.number().int().positive().optional(), // default: the version before `to`
  to: z.number().int().positive().optional(),   // default: the current version
});
```

- For a type, it compares two versions as described in 6.3, each merged with its base. Without `to`, the later side is the DoD in force now, with the current base, so base changes since `from` show up too. For `base`, it compares two base versions.
- Output: `{ type, from: "software-dev@3+base@1", to: "software-dev@4+base@3", criteria: { added, removed, changed: [{ id, origin, fields: [{ key, from, to }] }] }, rules: { added, removed, changed }, template_changed, first_seen: { from, to } }`. Every entry names its `origin`, so a review sees whether a change came from the base or the type.
- Removing a type's own criterion between two versions is allowed (the team decided it by pull request); the diff shows it. Only removing a base criterion inside a type file is an error (5.6).
- Domain errors: `unknown_type`, `unknown_version` (the hint lists the recorded versions), `no_history` (only one version recorded), `history_unavailable`.

## 9. Resources

| URI                              | Type               | Content                                                                                                                       |
| -------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `dod://types`                    | `application/json` | base (file, version, number of criteria); per type: title, versions, effective label, URI, mapping, valid or not; errors; recorded versions; `history` status |
| `dod://type/{type}`              | `application/json` | **one resource per type file**: base and type merged, each criterion with `origin` (`base` or the type), file and line; rules with origin; links to template, rubric and versions |
| `dod://type/{type}/version/{n}`  | `application/json` | the same shape for an earlier version (6.3), read from the store                                                               |
| `template://{type}`              | `text/markdown`    | the template for acceptance criteria and the rules that `lint_acceptance_criteria` applies for this type                       |
| `rubric://dod/{type}`            | `text/markdown`    | judgment criteria of base and type: question, standards for `plausible` and `doubtful`, instructions (a quote is required); attestations as "not for the model to decide: role X" |

- `dod://type/{type}`, `template://{type}` and `rubric://dod/{type}` are resource templates with a `list` callback: `resources/list` enumerates every type file in the folder, with no code change for new types. `complete` fills in `{type}`. The version template is not listed (it would grow with every version); `dod://type/{type}` links its versions.
- An invalid type file is listed too (its title says "invalid"). Reading it returns `{ type, valid: false, errors: [...] }` or a Markdown list of errors, so the reader sees which line to change (D5).
- A type without a file, or a version that is not recorded, gives `ResourceNotFoundError` (JSON-RPC −32602), as in `course-standards-mcp`.
- Rubric and template are generated from the same file the server checks against; what the model reads and what the server computes cannot drift apart.

## 10. Domain errors and protocol errors

As in the two model servers: a **domain error** means the tool understood the request but cannot do the job with this input. It comes back as a tool result with `isError: true`, a stable `code`, a message and a `hint`, so the agent can correct itself. A **protocol error** (unknown tool, malformed request, unknown resource) comes back as a JSON-RPC error. The server catches unexpected exceptions, logs the stack to stderr and returns only "internal_error, see server log".

| Code                  | When                                                                       | Hint                                                                        |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `type_missing`        | none of `type`, `ticket_type`, `labels`                                    | pass ticket type and labels from the ticket                                 |
| `unknown_type`        | no candidate, or `type` without a file                                     | lists types, ticket types and labels from `types.yaml`                      |
| `ambiguous_type`      | several candidates and no `type`                                           | names what triggered each candidate; fix the labels or choose `type`        |
| `type_conflict`       | `type` is not among the candidates                                         | lists the candidates                                                        |
| `invalid_dod`         | base, type file or (for ticket resolution) `types.yaml` invalid            | errors with file:line:column; fix the file, the server rereads it on every request |
| `dod_unavailable`     | folder or `base.yaml` missing                                              | names `DOD_DIR`                                                             |
| `empty_text`          | `lint_acceptance_criteria` with empty text                                 | –                                                                           |
| `unknown_version`     | `diff_dod` with a version the store does not hold                          | lists the recorded versions                                                 |
| `no_history`          | `diff_dod` with only one recorded version                                  | the history starts with the first sync (6.3)                                |
| `history_unavailable` | the store cannot be read                                                   | names the backend; the current DoD still works                              |

Text over 50,000 characters and too much evidence are rejected by the input schema; the SDK reports that as `isError` too.

## 11. Transport, container and security

### 11.1 HTTPS

- **One endpoint:** `POST /mcp` through the SDK's `createMcpHandler` (stateless per request, 2026-07-28, with the SDK's stateless fallback for 2025-era clients). `GET /healthz` answers `200 ok` without authentication and without data, for the Docker health check. Everything else is `404`.
- **TLS in the container.** Node's `https` server with certificate and key from mounted files (Docker secrets). TLS 1.2 or higher. There is **no plain-HTTP mode**: without certificate, key or token file, the server refuses to start in `https` mode (D11).
- **Order of checks per request:** TLS → `Host` against `DOD_ALLOWED_HOSTS` (SDK `hostHeaderValidationResponse`, against DNS rebinding) → `Origin`: a request that carries an `Origin` header must match `DOD_ALLOWED_ORIGINS`, which is empty by default (MCP clients send none, browsers do; SDK `originValidationResponse`) → bearer token → body size (1 MB) → MCP.
- **Bearer token.** SDK `requireBearerAuth` with a small verifier for static tokens: tokens come from a file (`DOD_TOKEN_FILE`, one token per line, so a new token can be added before the old one is removed), each at least 32 characters. The comparison hashes both sides with SHA-256 and uses `timingSafeEqual`. A missing or wrong token gives `401` with `WWW-Authenticate: Bearer`. Tokens never come from an environment variable, so they do not show up in `docker inspect`. OAuth 2.1 as in the MCP authorization specification is the later step (answer 2, section 18).
- **Logging** to stderr as JSON lines: time, method, tool or resource, status, duration. Never the token, never raw evidence values or acceptance texts.

### 11.2 Container

- **Dockerfile**, multi-stage: build stage (`npm ci`, `tsc`), runtime stage `node:26-slim`, pinned by digest once built, with `npm ci --omit=dev`, `dist/` and the fictional `dod/` as default content.
- Runs as the non-root user `node`, works with `--read-only` (only `/data` is writable), `EXPOSE 8443`, `HEALTHCHECK` through a small Node script against `https://localhost:8443/healthz`.
- **Mounts:** `/dod` (the team's DoD folder, read-only), `/data` (volume for SQLite), `/run/secrets/tls_cert`, `/run/secrets/tls_key`, `/run/secrets/dod_tokens`.
- **`compose.yaml`** for a local run: secrets from `local/secrets/` (git-ignored), the example `dod/` mounted read-only, a named volume for `/data`, port `8443`.
- **`scripts/dev-cert.sh`** creates a self-signed certificate for `localhost` and a random token in `local/secrets/` with `openssl`. Claude Code then connects with `claude mcp add --transport http dod https://localhost:8443/mcp --header "Authorization: Bearer …"` and `NODE_EXTRA_CA_CERTS` pointing to the certificate.
- **One team per container** (answer 3, section 18): one DoD folder, one database, one set of tokens. Several teams run several containers.

### 11.3 Configuration (environment only)

| Variable              | Default (stdio / container)                          | Purpose                                                    |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `DOD_TRANSPORT`       | `stdio` / `https`                                    | transport                                                  |
| `DOD_DIR`             | `<repo>/dod` / `/dod`                                | DoD folder                                                 |
| `DOD_DATABASE`        | `sqlite:local/dod.sqlite` / `sqlite:/data/dod.sqlite` | store (6.4)                                               |
| `DOD_PORT`            | – / `8443`                                           | HTTPS port                                                 |
| `DOD_TLS_CERT_FILE`   | – / `/run/secrets/tls_cert`                          | certificate (PEM)                                          |
| `DOD_TLS_KEY_FILE`    | – / `/run/secrets/tls_key`                           | private key (PEM)                                          |
| `DOD_TOKEN_FILE`      | – / `/run/secrets/dod_tokens`                        | bearer tokens, one per line                                |
| `DOD_ALLOWED_HOSTS`   | – / `localhost,127.0.0.1`                            | accepted `Host` values (without port)                      |
| `DOD_ALLOWED_ORIGINS` | – / empty                                            | accepted `Origin` values; empty rejects every `Origin`     |

### 11.4 Threats and limits

| #   | Threat                                                         | Limitation                                                                                                     |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| T1  | The agent invents or miscopies evidence                        | structured evidence with tool, arguments, time and raw value; check against `fetch_with`, age and revision; the person sees every tool call in the transcript; for expensive criteria the same check in CI later (open) |
| T2  | An agent report is read as "done"                              | no overall status, no writing tool, `who_decides` per criterion, closing sentence in the text                  |
| T3  | Prompt injection in raw values or acceptance criteria          | the server treats them as data, executes nothing, cuts raw values; the model in the client remains the risk     |
| T4  | A type quietly weakens the base                                | strict schema, id collision, required `extends: base` (5.6)                                                    |
| T5  | A file changes without a new version                           | normalised hash per version in the store → `version_not_bumped` (6.2)                                          |
| T6  | YAML abuse (alias bomb, huge file)                             | `yaml` with the core schema, no custom tags, `maxAliasCount: 100`, files ≤ 100 KB, ≤ 50 type files, ≤ 200 criteria per file |
| T7  | ReDoS through patterns from team files                         | no regular expressions from YAML; word lists are escaped                                                       |
| T8  | Unauthenticated or cross-site access to the HTTPS endpoint     | TLS only, bearer token, Host and Origin checks, no plain-HTTP mode, `/healthz` without data                    |
| T9  | Token leaks                                                    | tokens only from a mounted file, hashed comparison, never logged, never in results                             |
| T10 | Container breakout or tampering                                | non-root user, read-only root file system, read-only `/dod`, writable only `/data`                             |
| T11 | Customer data in the model context (Kundenanfrage)             | evidence needs only timestamps and numbers; the store holds no evidence; what the model reads for judgments is the client's matter (sketch, question 7) |
| T12 | Request floods                                                 | body limit 1 MB, input limits per tool; no rate limit in version 1 (open, or at the reverse proxy)             |

## 12. Limits of the heuristics

| Limit                                                         | How the server shows it                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Evidence comes from the agent (variant B)                     | `limits` in the result; `unexpected_source` → `needs_judgment`                 |
| The server does not verify who gave a confirmation            | `by` only has to be set; `limits`                                              |
| The number rule relies on German nouns being capitalised      | named in the template and in the lint result's `limits`                        |
| Word lists miss paraphrases                                   | the lint is an aid, not a verdict; the rubric asks about substance             |
| Scenarios without keywords (prose)                            | `no_scenario` instead of guessing                                              |
| The history starts at the first sync                          | `first_seen_at` in every version; Git import open (section 16)                 |

## 13. Fictional example data

One invented team with three task types, following the table in the sketch (3.1):

| File                 | Version | Evidence (`evidence`)                                                    | Judgment (`judgment`)              | Attestation                        | Acceptance rules                               |
| -------------------- | ------- | ------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `base.yaml`          | 3       | `ERGEBNIS-VERLINKT`                                                      | `FOLGEARBEIT`                      | `ZWEITE-PERSON` (Teammitglied)     | `AK-VAGE`                                      |
| `software-dev.yaml`  | 4       | `QUALITY-GATE`, `BUILD`, `TESTS` (all `same_ref`, 24 h), `TESTAENDERUNG-AUSGEWIESEN` | `KRITERIEN-GETESTET`   | `RUNBOOK` (Betrieb)                | `AK-GWT`, `AK-DANN`, `AK-EINHEIT`, `AK-VAGE-SW` |
| `dokument.yaml`      | 2       | `PFLICHTABSCHNITTE`, `LINKS` (72 h), `BEGRIFFE`                          | `ZWECK-ZIELGRUPPE`, `SYSTEMSTAND`  | `FACHFREIGABE` (Fachverantwortung) | `AK-FELDER` (Zweck, Zielgruppe, Umfang), `AK-VAGE-DOK` |
| `kundenanfrage.yaml` | 3       | `FRIST`                                                                  | `VOLLSTAENDIG`, `WISSENSBASIS`     | `ZUSAGE` (Vertrieb)                | `AK-FELDER` (Fragen as a list, Frist), `AK-VAGE-KA` |

Plus `examples/` with fictional evidence (JSON) per type, once with gaps and once complete, and acceptance criteria per type with deliberate findings. Tests and the demo use the same files. Invalid DoDs for the tests, and an older version of `software-dev.yaml` for the history tests, live in `test/fixtures/`.

## 14. Design decisions

**D1 The agent collects evidence (variant B).** Decision: the agent fetches evidence through the official servers and passes it in a structured form; the server checks form, age, revision and value. Alternative: the server fetches it through APIs (A). Reason: no credentials for other systems, the person's own permissions, no API clients to maintain, testable with fixed data (sketch 3.3). A remains for CI.

**D2 Judgment in the client model.** Decision: for judgment criteria the server provides question and standard; the model assesses. Alternative: a model call in the server, or sampling. Reason: reproducible, testable, no key; sampling is deprecated. The rubric comes from the same file.

**D3 No overall status.** Decision: status per criterion and counts only. Alternative: `done: true/false` or a traffic light. Reason: the team decides "done"; an overall value would be read as that decision.

**D4 One file per type, type name = file name.** Decision: discovery from the folder content, one resource per file through a `list` callback. Alternative: all types in one file, or a list of types in code. Reason: a new type needs no code change; every change is a small diff of one file.

**D5 Invalid types stay visible.** Decision: an invalid type file is listed and shows its errors when read; only its tools report `invalid_dod`, other types keep working. Alternative: the server does not start, or the file silently disappears. Reason: whoever reads the resource sees file and line at once; a typo in one type does not stop the whole team.

**D6 Parser `yaml` instead of `js-yaml`.** Decision: `yaml` with `LineCounter`; zod issue paths are mapped to nodes and lines. Alternative: `js-yaml` as in `course-standards-mcp`. Reason: errors with file and line are required, and `js-yaml` gives positions only for syntax errors.

**D7 Fixed operators and rule kinds.** Decision: five `expect` operators and five rule kinds in code, only parameterised in YAML. Alternative: regular expressions or expressions in YAML. Reason: explainable, testable, no ReDoS; new types need no code, new kinds of check deliberately do.

**D8 Type resolution without a default.** Decision: exactly one candidate from ticket type and labels; an explicit `type` only as a choice among the candidates, or without ticket data. Alternative: ticket type before label, or a default type. Reason: a wrongly assigned item would be checked against the wrong DoD and still look green.

**D9 Missing evidence is `not_met`.** Decision: `evidence_missing` gives `not_met`. Alternative: `needs_judgment`. Reason: `needs_judgment` means someone can decide with the material at hand; without material the criterion is not shown (question F1).

**D10 Files lead, the database remembers.** Decision: YAML in the team repository is the source of truth; the server records every valid version it sees in its own store, before each request, idempotently. Alternative: the database as the source with YAML import and export, or no database and history from Git. Reason: changes stay pull requests with review; the container needs no Git access and no repository credentials; history and `diff_dod` work anyway (answer 1). The sync writes only to the server's own store, so the tools are still read-only towards everything else.

**D11 HTTPS only, with a bearer token.** Decision: TLS in the container, static tokens from a mounted file, no plain-HTTP mode. Alternative: OAuth 2.1 now, or no authentication. Reason: enough for one team per container and simple to explain and test; OAuth 2.1 needs an identity provider and follows when a DoD is shared across teams (answer 2).

**D12 Configurable store behind a narrow interface.** Decision: `DodStore` with a handful of methods, `sqlite:` via `node:sqlite` first. Alternative: an ORM or a query builder for several databases at once. Reason: the store holds two tables; an ORM would be more code than the store. `node:sqlite` needs no native build in the image. A server-based backend is a second implementation of the same interface.

**D13 stdio stays.** Decision: the same server runs over stdio or HTTPS, chosen by `DOD_TRANSPORT`. Alternative: HTTPS only. Reason: local work in Claude Code needs no certificate, and the fast tests run without Docker.

**D14 Lint on text only.** Decision: `lint_acceptance_criteria` takes only `text`. Alternative: `path` as in `course-standards-mcp`. Reason: acceptance criteria live in the ticket; and a server in a container should not read paths at all.

**D15 Unexpected source is `needs_judgment`.** Decision: evidence from a tool that is not in `fetch_with` is not discarded but put in front of a person. Alternative: `not_met`. Reason: teams use different systems; the server cannot know whether the value is equivalent, a person can.

**D16 Four tools.** Decision: `get_dod`, `check_dod`, `lint_acceptance_criteria`, `diff_dod`; `get_dod` without input replaces a `list_types`. Alternative: one tool per type, or a separate list tool. Reason: few tools, fewer wrong choices by the model; types are data, not tools.

**D17 English codes.** Decision: specification, status values, finding and error codes, messages and resources in English; criterion texts, questions and templates in the team's language. Alternative: the German words of the concept sketch. Reason: consistent with the other two servers and the code; the mapping to the sketch's words is in section 4 (answer 4).

**D18 SDK and tooling as in the model servers.** `@modelcontextprotocol/server` 2.4.0 (plus `@modelcontextprotocol/node` 2.1.2 for `toNodeHandler`), TypeScript strict (`NodeNext`), zod v4, `node --test`, ESLint, Prettier; `@modelcontextprotocol/client` 2.4.0 for the protocol tests.

**D19 Output budget.** Raw values ≤ 200 characters, excerpts ≤ 120, ≤ 100 lint findings. Target: under 8,000 tokens for a DoD with 20 criteria.

## 15. Project layout, tooling and test plan

```
dod-mcp/
  dod/                         fictional DoD (section 13)
  examples/                    fictional evidence (JSON) and acceptance criteria (Markdown)
  src/server.ts                createServer(): tools, resources
  src/main.ts                  entry point: DOD_TRANSPORT → stdio or https
  src/http.ts                  HTTPS server, Host/Origin/token checks, /healthz
  src/healthcheck.ts           used by the Docker HEALTHCHECK
  src/config.ts  src/logger.ts  src/errors.ts
  src/dod/                     yamlFile.ts, schema.ts, load.ts, merge.ts, resolve.ts, sync.ts
  src/store/                   store.ts (DodStore), sqlite.ts, migrations.ts
  src/check/                   expect.ts, checkDod.ts
  src/lint/                    rule kinds and lint run
  src/diff/                    diffDod.ts
  src/render/                  rubric and template as Markdown
  src/resources.ts  src/tools/
  test/                        node:test; test/fixtures/ with invalid DoDs and older versions
  test/docker/                 container test (npm run test:docker)
  Dockerfile  .dockerignore  compose.yaml  scripts/dev-cert.sh
  docs/design.md
```

**Tests (`npm test`, no Docker, no network):**

1. **Loading:** the example data is valid; for each invalid fixture, the expected code with file and line (base criterion overridden, `remove`, `extends` missing, unknown key, `judgment` without `question`, duplicate id, YAML syntax, type ≠ file name, label assigned twice in `types.yaml`).
2. **New type without code:** copy the example folder to a temporary directory, add `einkauf.yaml`; `dod://types`, `resources/list`, `get_dod`, template and rubric know the type.
3. **Resolution:** unique, unknown, ambiguous, explicit among candidates, conflict, nothing given.
4. **`check_dod`:** every finding from 8.2 on its own; counts; `unused_evidence`; same output for the same `as_of`; example evidence with gaps and complete.
5. **Lint:** per type one text with findings at known lines and one clean text; numbers with dates, times and ranges.
6. **Store and history:** sync on `sqlite::memory:` and on a temporary file; recording is idempotent; `version_not_bumped` and `version_regressed`; a comment-only change is not a version; `dod://type/{type}/version/{n}`; `diff_dod` (added, removed, changed, base change); `no_history`, `unknown_version`; a failing store keeps the current DoD working.
7. **Protocol over stdio:** the server as a child process with the official client; four tools, all `readOnlyHint`; `resources/list` contains `dod://types` and, per type file, `dod://type/…`, `template://…`, `rubric://dod/…`; unknown tool → JSON-RPC error; ambiguous type → `isError` with `hint`.
8. **HTTPS in process:** a self-signed certificate created at test time with `openssl` (the test is skipped with a message if `openssl` is missing); no token → `401`; wrong token → `401`; foreign `Host` → rejected; an `Origin` header → rejected; `/healthz` → `200` without data; with the token, the official client over Streamable HTTP lists tools and resources and calls `check_dod`; the server refuses to start without certificate or token file.
9. **Budget:** `check_dod` on `software-dev` under 8,000 tokens (characters / 4).

**Container test (`npm run test:docker`, needs Docker):**

1. Build the image; create certificate and token in a temporary folder.
2. Start the container with `--read-only`, the example `dod/` mounted read-only, a temporary volume for `/data` and the secrets; wait until the health check reports `healthy`.
3. Check that the process runs as a non-root user and that `/healthz` answers without a token.
4. Over HTTPS with the official client: `401` without a token; with the token, `resources/list` shows one `dod://type/…` per type file, `get_dod` and `check_dod` work on the example evidence.
5. Change the mounted `software-dev.yaml` (higher version), call again, restart the container with the same volume: both versions are still in the history, and `diff_dod` shows the change.
6. Remove container, volume and temporary files, also when a step fails.

**Before every commit:** the portfolio denylist with zero hits, printing file names only.

**Phases, each with a review before the next:** 1 scaffold, example data, loader and validation; 2 resolution, resources, `get_dod`, `check_dod`, lint; 3 store, sync, versions, `diff_dod`; 4 HTTPS, Dockerfile, compose, container test; 5 README and a short verification report.

## 16. Open points

- **Import of the Git history** into the store (versions before the first sync), as a CLI that reads `git log` of the DoD folder.
- **`procedure://done-check`, `…/refinement`, `…/dod-review`** and the prompts **`refine_item`** and **`dod_review`** from the sketch.
- **Check in CI (variant A):** the same `check_dod` logic as a CLI with a read token for quality gate and build.
- **Organisation DoD as a minimum** (sketch, question 1): another layer above `base.yaml` with the same add-only rule; several teams per server.
- **OAuth 2.1** with the company identity provider; scopes per team.
- **Rate limit** per token, or at a reverse proxy.
- **Second store backend** (for example PostgreSQL) for several replicas.

## 17. Questions for approval

| #   | Question                                                                                                                                                                                                                                       | Proposal                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| F1  | Missing evidence or a missing attestation: `not_met` (D9)?                                                                                                                                                                                     | yes                                                                                       |
| F2  | May an explicit `type` resolve an ambiguity when it is one of the candidates (D8)?                                                                                                                                                             | yes, visible as `resolution.via: explicit`                                                |
| F3  | Two small additions now? (a) a CLI `dod-validate` for pull requests on `dod/`, using the same loader and printing errors with file and line in the CI log; (b) the prompt template `done_check(item)`                                           | (a) yes, about 40 lines; (b) yes, no new logic, makes the demo run end to end             |
| F4  | A content change without a version bump makes the file invalid (`version_not_bumped`, 6.2). Strict enough, or too strict for daily work?                                                                                                      | keep it strict: the version number is what a report cites                                 |

## 18. Answered questions (14 November 2026)

1. **Role of the database:** it records the versions of the YAML files; the files in the team repository stay the source of truth and change by pull request. `check_dod` stores nothing.
2. **Access over HTTPS:** TLS in the container with a mounted certificate and a bearer token from a Docker secret. OAuth 2.1 is a later step.
3. **Tenancy:** one team per container.
4. **Language:** the specification and all status, finding and error codes are in English.
5. **First draft, other changes requested:** the server runs in a Docker container, defined and tested in this repository.
6. **F1 to F4 (section 17):** approved as proposed. Missing evidence is `not_met`; an explicit `type` may resolve an ambiguity; the CLI `dod-validate` and the prompt `done_check` are built now; a content change without a version bump makes the file invalid.

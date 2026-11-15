# dod-mcp

An MCP server that serves a team's Definition of Done from versioned YAML files, one file per task type, and checks the evidence an agent collected against it, criterion by criterion. It never declares an item done.

_Prototype, November 2026, built with Claude Code as co-developer. All data in this repository is fictional._

## Problem

The Definition of Done usually lives on a wiki page or in a pull request template. The pipeline checks part of it (build, tests, quality gate); people check the rest from memory in the review. Coding agents make this worse: they deliver more changes in less time, they report "done" when the tests are green, and they cannot see criteria that are written down nowhere they look (documentation, sign-offs, operations).

This server keeps the DoD in the team repository, as a shared base plus one file per task type (software development, documents, customer requests …). Agent and people read the same files. The server checks an item against them and reports, per criterion, a status and the evidence or what is missing. Whether the item is done stays the team's decision.

## What it does

| Tool                       | What it does                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_dod`                  | The DoD for a ticket: pass its ticket type and labels. Every criterion of base and type with its origin and check kind, and for evidence criteria which tool delivers the value and what it must show. Without arguments: the list of task types.                                               |
| `check_dod`                | The evidence the agent collected (source, tool, arguments, time, raw value, commit) against the DoD: `met` / `not_met` / `needs_judgment` per criterion, findings such as `evidence_missing`, `evidence_stale`, `evidence_other_ref`, and a hint how to get what is missing. No overall status. |
| `lint_acceptance_criteria` | Acceptance criteria against the rules of their type: Given/When/Then complete and in order, observable Then steps, vague words, numbers without units, required fields and formats. Every finding with line and column.                                                                         |
| `diff_dod`                 | What changed between two versions of a type (each with its base) or of the base, every entry with its origin. For DoD reviews and retrospectives.                                                                                                                                               |

| Resource                        | Content                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `dod://types`                   | base, mapping and every task type with version label, validity, errors and recorded versions |
| `dod://type/{type}`             | one resource per type file: base and type merged, every criterion with origin, file and line |
| `dod://type/{type}/version/{n}` | an earlier version, with the base it was first served with                                   |
| `template://{type}`             | the template for acceptance criteria and the rules the lint applies                          |
| `rubric://dod/{type}`           | the judgment criteria with question and standards for _plausible_ and _doubtful_             |

| Prompt             | Does                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done_check(item)` | determines the type, collects evidence with your other servers, runs `check_dod`, answers the judgment questions with the rubric and reports per criterion. Writes nothing. |

All tools are read-only. The server calls no model and holds no credentials for other systems.

## Who decides what

| Who                  | Words                                | For what                                              |
| -------------------- | ------------------------------------ | ----------------------------------------------------- |
| Server               | `met` / `not_met` / `needs_judgment` | each criterion, from evidence and rules, reproducible |
| Model in the client  | _plausible_ / _doubtful_             | each judgment criterion, with a quote, by the rubric  |
| Team or a named role | "done"                               | the item; a role confirms attestation criteria        |

Each criterion says how it is checked: `evidence` (a value a tool can fetch, such as the quality gate of this commit), `judgment` (a question, such as "which acceptance criterion has no test?") or `attestation` (a role confirms, such as operations for the runbook). The agent fetches evidence through the official servers (SonarQube, Azure DevOps, GitHub, Jira …) and passes it on unchanged; the server checks its form, age, commit and value. The reasoning is in [docs/design.md](docs/design.md).

## Quick start

Requires Node.js 26; Docker for the container.

```bash
npm install
npm run build
npm test
```

### Local, over stdio

```bash
claude mcp add --transport stdio --scope local dod --env DOD_DIR=/absolute/path/to/your/dod -- node /absolute/path/to/dod-mcp/dist/main.js
```

Then ask Claude Code "Check DEMO-42 against our Definition of Done", or run the prompt as `/mcp__dod__done_check DEMO-42` (Claude Code names MCP prompts `/mcp__<server>__<prompt>`). Without `DOD_DIR` the server serves the fictional example in `dod/`.

### In a container, over HTTPS

```bash
scripts/dev-cert.sh            # self-signed certificate and a token in local/secrets/ (git-ignored)
docker compose up -d --build   # https://localhost:8443/mcp, the example DoD mounted read-only
claude mcp add --transport http dod https://localhost:8443/mcp --header "Authorization: Bearer $(cat local/secrets/tokens)"
```

Start Claude Code with `NODE_EXTRA_CA_CERTS` pointing to `local/secrets/cert.pem`, so it trusts the certificate. One container serves one team: one DoD folder, one database, one set of tokens.

## Your team's DoD

```text
dod/
  base.yaml            # applies to every type
  types.yaml           # ticket type / label → task type
  software-dev.yaml    # one file per task type; the file name is the type
```

```yaml
# FICTIONAL EXAMPLE: dod/kundenanfrage.yaml
type: kundenanfrage
version: 3
title: Kundenanfrage
extends: base
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
  - id: ZUSAGE
    text: Zusagen zu Preis oder Termin sind freigegeben.
    check: attestation
    role: Vertrieb
```

- **A type may only add to the base.** A type file that reuses a base id, uses a key such as `remove` or `override`, or lacks `extends: base` is invalid, with file, line and column. Other types keep working.
- **A new type is a new file.** It appears as resources without a restart and without code changes.
- **Every change of content raises `version`.** The server records every version it sees in its database; a changed file with an old version number is invalid (`version_not_bumped`). The YAML files stay the source of truth and change by pull request.
- **`expect`** has six operators: `equals`, `one_of`, `min`, `max`, `present`, `not_after`; `field` reads nested values with a dotted path.
- **Acceptance rules** come in five kinds: `gherkin`, `observable_then`, `vague_words`, `numbers_need_units`, `fields` (lines `Name:` or headings `## Name`).

Check the folder in CI with the same loader:

```bash
node dist/cli/validate.js dod     # prints file:line:column code: message; exit 0, 1 or 2
```

## Example (fictional)

`check_dod` on [examples/evidence/software-dev-gaps.json](examples/evidence/software-dev-gaps.json), a story whose quality gate was fetched for another commit, whose test results are 30 hours old, and that no second person has looked at:

| Criterion                 | Origin       | Check       | Status         | Finding             | Hint or question                                                                    |
| ------------------------- | ------------ | ----------- | -------------- | ------------------- | ----------------------------------------------------------------------------------- |
| ERGEBNIS-VERLINKT         | base         | evidence    | met            | –                   |                                                                                     |
| FOLGEARBEIT               | base         | judgment    | needs judgment | –                   | Welche offene Folgearbeit aus dem Ergebnis ist noch nicht als eigenes Item erfasst? |
| ZWEITE-PERSON             | base         | attestation | not met        | attestation_missing | Ask the role Teammitglied to confirm; the agent does not confirm on its own.        |
| QUALITY-GATE              | software-dev | evidence    | not met        | evidence_other_ref  | Fetch with get_project_quality_gate_status for commit 9f2c1ab.                      |
| BUILD                     | software-dev | evidence    | met            | –                   |                                                                                     |
| TESTS                     | software-dev | evidence    | not met        | evidence_stale      | Fetch with get_test_results for commit 9f2c1ab.                                     |
| TESTAENDERUNG-AUSGEWIESEN | software-dev | evidence    | met            | –                   |                                                                                     |
| KRITERIEN-GETESTET        | software-dev | judgment    | needs judgment | –                   | Zu welchem Akzeptanzkriterium fehlt ein Test, der genau dieses Verhalten prüft?     |
| RUNBOOK                   | software-dev | attestation | met            | –                   |                                                                                     |

4 met, 3 not met, 2 need judgment, about 1,000 tokens of output. `lint_acceptance_criteria` on [examples/acceptance/software-dev.md](examples/acceptance/software-dev.md) finds two incomplete scenarios, an unobservable Then ("ist zufrieden"), a number without unit ("in unter 2") and two vague words; the fixed version is clean. The run is in [docs/verification.md](docs/verification.md).

## Configuration

Environment variables only.

| Variable                                | Default (stdio / container)                                  | Purpose                                                       |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `DOD_TRANSPORT`                         | `stdio` / `https`                                            | transport                                                     |
| `DOD_DIR`                               | `<repo>/dod` / `/dod`                                        | DoD folder                                                    |
| `DOD_DATABASE`                          | `sqlite:<repo>/local/dod.sqlite` / `sqlite:/data/dod.sqlite` | version history; `sqlite::memory:` for tests                  |
| `DOD_PORT`                              | – / `8443`                                                   | HTTPS port                                                    |
| `DOD_TLS_CERT_FILE`, `DOD_TLS_KEY_FILE` | – / `/run/secrets/tls_cert`, `/run/secrets/tls_key`          | certificate and key (PEM)                                     |
| `DOD_TOKEN_FILE`                        | – / `/run/secrets/dod_tokens`                                | bearer tokens, one per line, at least 32 characters           |
| `DOD_ALLOWED_HOSTS`                     | – / `localhost,127.0.0.1`                                    | accepted `Host` values                                        |
| `DOD_ALLOWED_ORIGINS`                   | – / empty                                                    | accepted `Origin` values; empty rejects every browser request |

## Security

- HTTPS only; no plain-HTTP mode. Host and Origin are checked before the token, the token before anything else. Tokens come from a mounted file, never from an environment variable, and are never logged.
- The container runs as a non-root user on a read-only file system; only `/data` is writable. The DoD folder is mounted read-only.
- No regular expressions from YAML, an alias limit for YAML, size limits for files, evidence and request bodies.
- The database holds DoD file versions only: no evidence, no acceptance texts, no request data.
- Evidence comes from the agent. The server checks form, age, commit and value, not authenticity; for criteria where a forged value would be expensive, run the same check in CI (an open point).

## Limits

The server cannot tell whether evidence is genuine or who gave a confirmation; word lists miss paraphrases; the number rule relies on German nouns being capitalised; the version history starts with the first sync. `expect` cannot yet compare two fields with each other or compute deadlines relative to another time. Details: [docs/design.md](docs/design.md), sections 12 and 16.

## How this was built

The starting point was a concept sketch for a team MCP server "Definition of Done" (14 November 2026). I defined the problem and the design rules from my two earlier MCP servers (deterministic findings with a location, judgment in the client model, nothing set to done automatically), approved the design ([docs/design.md](docs/design.md)) and reviewed each of the five phases before the next one started. Claude Code drafted the code, the tests and the documentation.

To test the format against reality, a draft DoD was extracted read-only from one real repository. That draft stays outside this repository; it led to two format changes (nested fields in `expect`, headings as fields) and to the open points on field comparison and deadlines.

## Licence

MIT, see [LICENSE](LICENSE).

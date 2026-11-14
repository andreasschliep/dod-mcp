# dod-mcp: verification

Run on 14 November 2026 on macOS with Node.js 26.7.0 and Docker Desktop 29.6.2; the image uses Node.js 26.13.1 (`node:26-slim`, pinned by digest). All data fictional unless stated otherwise.

## What was run

| Check                                            | Command                                                              | Result                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint, format, unit and protocol tests | `npm run check`                                                      | 82 tests, all pass; no type, lint or format errors                                                               |
| Container                                        | `npm run test:docker`                                                | 4 tests, all pass                                                                                                |
| Container with compose                           | `scripts/dev-cert.sh`, `docker compose up -d --build --wait`, `curl` | healthy; `/healthz` 200 without token; `/mcp` 401 without token, 200 with token; `docker compose down -v`        |
| Validator on the example                         | `node src/cli/validate.ts dod`                                       | 5 files valid, exit 0                                                                                            |
| Validator on real data                           | `node src/cli/validate.ts local/qualify-dod`                         | a draft extracted from one real repository: base and 4 types, 34 criteria, valid, exit 0. Not in this repository |
| Leak check                                       | portfolio denylist over the repository, file names only              | no hits before each commit                                                                                       |

### Tests per file

| File                       | Tests | Covers                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/load.test.ts`        | 18    | example valid; every validation code with file and line; add-only rule; invalid base or mapping; new type without code; size and alias limits; `dod-validate` exit codes                                                                                                                                  |
| `test/resolve.test.ts`     | 8     | unique, unknown, ambiguous, explicit among candidates, conflict, missing; invalid `types.yaml`                                                                                                                                                                                                            |
| `test/check.test.ts`       | 14    | the four example evidence files; every finding on its own; timestamps and time zones; most recent evidence decides; tool name matching; raw size; `expect` operators incl. dotted paths; same output for the same `as_of`; output budget                                                                  |
| `test/lint.test.ts`        | 9     | findings at known lines per type; fixed texts clean; scenarios, step order, keywords; numbers with dates, times, ranges; code spans; headings as fields                                                                                                                                                   |
| `test/store.test.ts`       | 11    | first sync and idempotence; comment-only change; `version_not_bumped` (type and base); `version_regressed`; earlier versions with their base; `diff_dod` incl. base changes; `no_history`, `unknown_version`; failing store; SQLite file across restarts; unsupported database                            |
| `test/server.test.ts`      | 14    | stdio with the official client: four read-only tools with output schemas; one resource per type file; merged view with origin, file and line; template and rubric; a new and an invalid type file appear without restart; errors as `isError` with hint; prompt; history and `diff_dod` over the protocol |
| `test/http.test.ts`        | 8     | HTTPS in process with a certificate made at test time: `/healthz`; 401 without or with a wrong token; foreign `Host` and any `Origin` rejected; body over 1 MB refused; official client over Streamable HTTP with two tokens; refusal to start without token file or certificate                          |
| `test/docker/container.ts` | 4     | non-root user, read-only root file system, start log; `/healthz` and 401; one resource per type file and `check_dod`; a new version of a mounted file survives a restart and shows in `diff_dod`                                                                                                          |

### Example output

`check_dod` on `examples/evidence/software-dev-gaps.json`: 9 criteria, 4 met, 3 not met (`evidence_other_ref` for the quality gate, `evidence_stale` for the tests, `attestation_missing` for the second person), 2 need judgment. The structured result is 4,077 characters, about 1,000 tokens, well under the 8,000-token budget. The table is in the README.

## What was not verified

- **Claude Code end to end.** Neither `claude mcp add` nor the prompt `done_check` was run in a real Claude Code session; that would have changed the local Claude Code configuration. The protocol tests use the official MCP client instead. Open: does Claude Code show `structuredContent` or only the text, and does it accept the self-signed certificate with `NODE_EXTRA_CA_CERTS`?
- **MCP Inspector.** Not run.
- **Linux hosts.** Secrets are mounted with mode 0644 so that the container user can read them; on Docker Desktop for macOS this works, on a Linux host file ownership may need adjusting.
- **Load and concurrency.** One container, one SQLite writer; not measured.
- **OAuth 2.1, rate limits, a second database backend, the Git history import:** not built (design section 16).

## Findings while building

- **A type cannot add a source to a base criterion.** Customer requests fetch their evidence from the helpdesk, not the ticket system; with only `tickets:get_item` in the base, every such check came out `needs_judgment`. The base now names both tools (version 3). Under the add-only rule the base has to know every source, or name none.
- **Prettier changes example texts.** It removed indentation and added blank lines in the acceptance criteria examples, which moved the expected lines. `examples/acceptance` is excluded from Prettier.
- **SDK bearer auth needs an expiry.** `requireBearerAuth` rejects tokens without `expiresAt`; static tokens get a five-minute expiry per check.
- **`@modelcontextprotocol/node` is versioned apart from the server package.** `toNodeHandler` comes in 2.1.2, built for `@modelcontextprotocol/server` ^2.4.0.
- **Docker assigns a new host port on restart** when the port is chosen by Docker; the container test reads it again after the restart.
- **Real data showed two format gaps** that are now closed (nested fields in `expect`, Markdown headings as lint fields) and two that are open (comparing two fields, deadlines relative to another time).

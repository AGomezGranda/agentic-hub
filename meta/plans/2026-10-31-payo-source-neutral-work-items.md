---
date: 2026-10-31
title: Payo source-neutral work items and direct prompts
status: completed
---

# Payo source-neutral work items and direct prompts

## Current State

- The CLI models `start` as a single positional `ticketKey`; it rejects a second positional argument. `answer` already joins trailing arguments into free-form text, providing a local parser precedent (`payo/apps/cli/src/args.ts:8-19,44-66,83-101`).
- `StartRunRequest` requires `ticketKey` (`payo/packages/contracts/src/api.ts:12-17`). The HTTP route passes that key through to composition (`payo/apps/server/src/http.ts:94-107`), which stores it in the factory run configuration and schedules execution (`payo/apps/server/src/composition.ts:242-255`).
- The factory currently depends on `TicketSource.get(key)` (`payo/packages/kernel/src/workspace.ts:1-5`, `payo/modules/factory/src/types.ts:23-46`). Its `FetchTicket` step resolves the ticket, creates the workspace, and snapshots the ticket in the checkpoint (`payo/modules/factory/src/commands.ts:145-175`).
- Persisted configuration requires `ticketKey`, and persisted checkpoints require a `ticket` field (`payo/packages/contracts/src/factory.ts:76-92,110-135`). The factory uses these records to reopen and resume runs (`payo/modules/factory/src/commands.ts:335-378`).
- Jira transport and JSON mapping are isolated in `payo/adapters/jira-acli/src/index.ts:21-71`; the server composition root wires that adapter (`payo/apps/server/src/adapters.ts:84-114`). Payo’s dependency rules require adapters to stay outside the factory and CLI, with only the server wiring them (`payo/test/boundaries.test.ts:21-26,84-90`; `docs/payo/engine-design.md:37-46`).
- `run.created` persists the factory configuration in the event log (`payo/packages/contracts/src/run.ts:17-27`), and the events API returns stored run events (`payo/apps/server/src/http.ts:123-129`). Embedding raw prompt text in config would expose it directly to authenticated event consumers. Separately, persisted `attempt.event` rows can contain agent-generated text, so an agent may echo the prompt into events even when the original request is stored only as an artifact.
- Existing focused coverage is in `payo/packages/contracts/src/{api,factory}.test.ts`, `payo/adapters/jira-acli/src/index.test.ts`, `payo/apps/cli/src/args.test.ts`, `payo/apps/server/src/{http,composition,factory-flow,factory-persistence,doctor}.test.ts`. The workspace check is `pnpm -C payo check` (`payo/package.json:9-13`).
- `meta/plans/` is the existing plans directory.

## Design Decisions

| Decision | Rationale |
|---|---|
| Represent the factory’s input as a source-aware `WorkItemRequest` and resolved `WorkItem`; use a `WorkItemSource` kernel port. | The factory should own planning and run state, not Jira-specific fetching or prompt-source selection. Jira and prompt are explicit request variants; a future Linear variant can be added with a source adapter without importing that adapter into the factory. |
| Keep `payo start ABC-123` as the Jira shorthand and use `payo start --prompt <text...>` for direct work. | The explicit flag distinguishes prompt text from the existing ticket positional argument while preserving the established `start` command. Join trailing prompt arguments with spaces, following the existing `answer` parsing pattern, so the unquoted example works. Continue parsing `--repo` and `--base` as options. |
| Store prompt contents as a `factory-work-item-request-v1` artifact and keep only its reference in `FactoryRunConfig`. | The initial request must survive restart/resume, and the original text should not be copied directly into `run.created.config`. This does not prevent an agent from echoing or quoting the prompt in persisted `attempt.event` text. Authenticated event consumers can see arbitrary agent-generated event text, so the event stream is not a confidentiality boundary for prompt contents. |
| Use `WorkItem` origin variants `{source: "jira", key, url}` and `{source: "prompt"}`. A direct prompt becomes a work item titled `Direct prompt`, with its original text as the description. | This keeps provenance explicit, avoids inventing a Jira-like key, and does not rewrite or summarize the user’s request. |
| Preserve old API/config/checkpoint records at read boundaries. | Existing local runs must remain inspectable and resumable. Normalize legacy `ticketKey` run configurations and `ticket` checkpoints into the new Jira work-item representation; accept legacy `ticketKey` HTTP requests as Jira shorthand. No SQLite table migration is needed. |
| A Jira login is not a global server-start requirement. Keep `acli` in `payo doctor`, but only gate real server startup on shared execution requirements (`pi`, `git`, and role skills). | Prompt-only work should not require an unrelated source adapter. If a Jira run is requested without a working Jira adapter, its existing durable fetch/escalation path reports the failure. |
| Do not add a source registry, source auto-detection, or a Linear adapter in this change. | The current two-source request union is enough; future source work can add a typed variant and adapter when it is actually needed. |

## Risks & Mitigations

- **An agent may echo prompt text into run events.** → Artifact indirection prevents direct serialization of the original request in `run.created.config`, but cannot prevent generated `message`, `result`, or `error` events from repeating it. Treat authenticated event consumers as able to see prompt-derived agent text; do not send prompts whose contents must be hidden from those consumers. Test that config contains only the artifact reference and add an echoing-runner case demonstrating that generated event text may be returned by the events API.
- **Old runs may fail to reopen after checkpoint/config renaming.** → Add legacy Zod readers that normalize the existing `ticketKey` config and `ticket` checkpoint; cover a legacy SQLite run through reopen and resume before removing old runtime field access. Keep the old `FetchTicket` stage valid and executable as a legacy stage.
- **A rollback to the old binary cannot read new prompt run records.** → Do not downgrade while source-neutral or prompt runs need resume; keep the data directory intact and resume them with this version. Existing Jira-format API requests and old persisted runs remain readable by the new version.
- **Variadic prompt parsing can confuse text with options.** → Before `--`, treat exact `--repo` and `--base` argument tokens as options; after `payo start --prompt --`, treat every remaining token as literal prompt text. Document and test both the ordinary option form and the end-of-options escape.
- **Jira can be unavailable after server startup.** → Keep Jira readiness visible through `payo doctor`; use the existing source-resolution escalation and `resume` behavior for a Jira run. Verify startup readiness separately from the full diagnostic report.
- **This could grow into speculative multi-provider infrastructure.** → Implement only the `jira` and `prompt` variants, one source port, and the existing server composition root. Do not implement Linear, a dynamic adapter loader, or source-specific factory branches.

## Implementation Phases

### Phase 1 — Generalize and persist factory work-item input [x]

#### Overview

Replace the factory’s Jira-shaped input and fetched-ticket state with source-neutral contracts, while keeping the current CLI/API Jira path working. Make prompt requests durable and make current Jira runs readable through the new model before exposing prompt mode in the CLI.

#### Changes

- `payo/packages/contracts/src/factory.ts`:
  - Add `WorkItemRequest`, the runtime discriminated union `{source: "jira", key}` or `{source: "prompt", text}`; both payloads must be nonblank.
  - Add `PersistedWorkItemRequest`, where Jira stores its key and prompt stores an `ArtifactRef` instead of raw text.
  - Add `WorkItemOrigin` (`jira` with key and nullable URL, or `prompt`) and `WorkItem` (`origin`, nonblank `title`, string `description`). Keep the existing `Ticket` schema under a legacy name and retain its `Ticket` export as an alias for old-record decoding.
  - Change canonical `FactoryRunConfig` to store `workItemRequest: PersistedWorkItemRequest`. Parse the existing config shape with `ticketKey` and normalize it to `{source: "jira", key: ticketKey}` while preserving the other settings.
  - Change canonical `FactoryCheckpoint` to store `workItem: WorkItem | null`. Accept the existing checkpoint shape with `ticket: Ticket | null` and normalize a saved Jira ticket to a `WorkItem` with Jira origin. Add `ResolveWorkItem` to `FactoryStage`; retain `FetchTicket` for reading and resuming existing checkpoints.
- `payo/packages/kernel/src/workspace.ts`: replace `TicketSource.get(key)` with generic `WorkItemSource.resolve(request)`. Parameterize the port by a `WorkItemRequest` subtype so source adapters can implement only their own variant; the factory depends on the complete request union.
- `payo/modules/factory/src/types.ts` and `payo/modules/factory/src/commands.ts`:
  - Change `FactoryDeps` to depend on `workItems: WorkItemSource` and `StartInput` to accept `workItemRequest: WorkItemRequest`.
  - In `beginFactory`, store prompt text as `factory-work-item-request-v1` (`text/plain`) and include its `artifact.recorded` event in the initial commit; persist only the reference in `FactoryRunConfig`. Persist Jira keys directly.
  - Replace the new-run `FetchTicket` transition with `ResolveWorkItem`. At execution, load prompt text from its artifact when needed, call `deps.workItems.resolve`, validate the result as `WorkItem`, record `factory-work-item-v1`, and checkpoint `workItem` before planning. Handle legacy `FetchTicket` checkpoints through the same resolver.
  - Pass the resolved artifact to planner/reviser as input named `work-item`. Keep workspace creation, escalation, and resume behavior unchanged.
- `payo/modules/factory/src/roles.ts`: use the `work-item` input name for planner/reviser while preserving the existing read-only role instructions and output contracts.
- `payo/adapters/jira-acli/src/index.ts`: keep `createAcliTicketSource` and Jira-key validation, but have its Jira-specialized resolver return `WorkItem`; `parseAcliTicket` maps the Jira key, summary, description, and URL into `WorkItem.origin` and the shared title/description fields.
- `payo/apps/server/src/adapters.ts` and `payo/apps/server/src/factory-fixtures.ts`: replace ticket-only adapter members/helpers with `WorkItemSource` implementations. In this phase the real source router accepts Jira requests and delegates to `createAcliTicketSource`; the fake source resolves existing fixture Jira requests. Prompt routing is wired in Phase 2.
- `payo/apps/server/src/composition.ts`, `payo/apps/server/src/http.ts`, and all factory/composition test inputs: adapt the existing `ticketKey` HTTP request to an internal `{source: "jira", key}` request, preserving the existing CLI and HTTP behavior while the factory becomes source-neutral.
- `payo/packages/contracts/src/factory.test.ts`: write unit tests first for valid/invalid work-item requests and origins, prompt persisted references, legacy `FactoryRunConfig` normalization, and legacy checkpoint normalization including a checkpoint at `FetchTicket`.
- `payo/adapters/jira-acli/src/index.test.ts`: write unit tests first confirming the fixture still maps Jira ADF and URL correctly into a Jira-origin `WorkItem`, rejects invalid Jira keys and malformed responses, and makes no network/process call on invalid keys.
- `payo/apps/server/src/factory-flow.test.ts`: write component tests first confirming the factory resolves a Jira request through the injected port, checkpoints the `WorkItem` before planning, sends the work-item artifact to the planner, and escalates/resumes a failed resolver without losing the original request.
- `payo/apps/server/src/factory-persistence.test.ts`: write SQLite integration tests first for (a) a prompt request artifact reference in run config with exact text recoverable after store close/reopen and (b) a legacy Jira config/checkpoint that reopens and resumes through the compatibility normalization. Assert that raw prompt text is absent from `run.created.config`.

#### Tests

Tests above are written before implementation. Contract and parser-schema cases are fast unit tests; Jira field mapping is an adapter unit test; factory resolver behavior is a component test with the existing fake runner; prompt durability and legacy resume are SQLite integration tests. Edge cases include blank prompt/key, invalid source variant, missing prompt artifact, resolver failure, malformed legacy checkpoint, and legacy `FetchTicket` recovery.

#### Success criteria

**Automated:**

- Focused: `cd payo && ./node_modules/.bin/vitest run packages/contracts/src/factory.test.ts adapters/jira-acli/src/index.test.ts apps/server/src/factory-flow.test.ts apps/server/src/factory-persistence.test.ts`
- Types: `cd payo && ./node_modules/.bin/tsc --noEmit`
- Lint/format: `cd payo && ./node_modules/.bin/biome check .`
- Full suite: `pnpm -C payo check`

**Manual:**

- Start `payo serve --dev-fakes`, run the existing `payo start ABC-123` path, and confirm it still reaches the approval gate.
- Inspect a new run’s `run.created.config` and confirm it contains only the source request or prompt artifact reference, never prompt plaintext.
- Reopen a fixture representing an old Jira run and confirm its checkpoint still reports a valid stage and ticket-derived work item.

#### What we're NOT doing

No prompt CLI option, Linear/other provider adapter, Jira writes, new HTTP source shape, title generation, or changes to planning/review policy in this phase.

### Phase 2 — Expose prompt starts and update Payo’s documented contract [x]

#### Overview

Expose the source-neutral request through the existing start API and CLI, with Jira shorthand preserved and prompt text passed verbatim into the same factory flow. Make the Jira adapter optional for server startup, then document the new source model and its persistence behavior.

#### Changes

- `payo/packages/contracts/src/api.ts`: make canonical `StartRunRequest` contain `workItemRequest: WorkItemRequest` plus the existing optional `repo` and `baseBranch`. Accept the existing `{ticketKey, repo?, baseBranch?}` payload as a legacy input and normalize it to `{source: "jira", key: ticketKey}`. Reject requests that provide both input forms, neither form, blank prompt text, or blank overrides.
- `payo/apps/server/src/http.ts`: pass the normalized `workItemRequest` to composition. Keep `POST /api/v1/runs`, its authentication, absolute repository validation, `202` status, and response schema unchanged.
- `payo/apps/server/src/adapters.ts`: compose the generic server `WorkItemSource` from the Jira resolver and an in-process prompt resolver. A prompt resolves to `{origin: {source: "prompt"}, title: "Direct prompt", description: exactText}` without invoking `acli`; Jira requests delegate to `createAcliTicketSource`. Keep provider choice and routing in the server composition root.
- `payo/apps/server/src/composition.ts`: accept `WorkItemRequest` in `Composition.start` and pass it unchanged to `beginFactory`.
- `payo/apps/cli/src/args.ts`: extend the `start` command to produce `workItemRequest`. Preserve `start ABC-123` as `{source: "jira", key: "ABC-123"}`. Add `--prompt <text...>`, join trailing prompt arguments with a single space, and reject missing/blank prompt, duplicate prompt flags, unknown Jira-mode options, or a prompt combined with a positional Jira key. Continue recognizing `--repo` and `--base` as start options before the end-of-options marker. Support `--` after `--prompt` to mark all remaining arguments as literal prompt text, so option-like tokens can be included unambiguously (for example, `payo start --prompt -- --repo`).
- `payo/apps/cli/src/index.ts` and `payo/apps/cli/src/client.ts`: send the parsed `workItemRequest` through `CliClient.start` using the shared contract; keep run-ID output and all other command behavior unchanged.
- `payo/apps/server/src/doctor.ts` and `payo/apps/server/src/main.ts`: add `startupBlockingFailures(report)` that ignores a failed `acli` check but retains failed `pi`, `git`, and `skills` checks. Use it for server readiness only; keep `runDoctor` and the `payo doctor` command reporting all checks, including `acli`.
- `payo/apps/server/src/adapters.test.ts`: add unit tests that prompt resolution preserves the exact text and never invokes the Jira resolver, and Jira resolution delegates the key to the Jira adapter.
- `payo/apps/cli/src/args.test.ts`: add parser unit tests for the exact unquoted example, quoted text, spaces, `--repo`/`--base`, Jira shorthand compatibility, missing/blank prompt, conflicting sources, and the end-of-options form with a prompt consisting solely of `--repo`.
- `payo/apps/cli/src/client.test.ts`: add a client test that posts the canonical prompt request and reads the run ID; add a regression test that a legacy-compatible Jira command sends the canonical Jira request.
- `payo/packages/contracts/src/api.test.ts`: add unit tests for prompt/Jira variants, legacy `ticketKey` normalization, conflicting/missing sources, blank prompt and blank overrides.
- `payo/apps/server/src/http.test.ts`: add a component test that posts a prompt request, receives `202`, and reaches the same approval gate as Jira; keep a legacy `ticketKey` request test. Assert `run.created.config` contains only the prompt artifact reference, not the raw request. With an echoing fake runner, verify that an agent-generated `attempt.event` can contain prompt text and that the event API returns it, pinning the documented confidentiality boundary.
- `payo/apps/server/src/doctor.test.ts`: test that `startupBlockingFailures` ignores only an unavailable `acli` check and still blocks for unavailable `pi`, `git`, or `skills`; verify `runDoctor` continues to report all four checks.
- `payo/apps/server/src/main.test.ts`: add a real-mode subprocess test with a valid temporary git repo and role-skill fixtures, a test Pi executable reporting ready, and an unavailable `acli`. Assert the server reaches readiness; keep a blocking-check failure case to verify that non-Jira requirements still prevent startup.
- `payo/test/boundaries.test.ts`: preserve and run the existing dependency checks; the CLI continues to import only `@payo/contracts`, and only the server wires adapter packages.
- `README.md`, `docs/payo/usage.md`, `docs/payo/agentic-factory.md`, `docs/payo/engine-design.md`, and `docs/payo/implementation-roadmap.md`: describe Jira and prompt as start sources, show `payo start --prompt "create a simple FastAPI todo app with strict typing"`, the unquoted multi-argument form, and the literal-token form `payo start --prompt -- --repo`; keep `payo start ABC-123`; update `TicketSource`/`FetchTicket` descriptions to the source-neutral port/stage; and state that Linear is future work. Correct real-mode requirements: Jira login is needed only for Jira runs; `payo doctor` still reports `acli`, but it is no longer required for prompt-only server startup. Document that prompt artifacts are stored under `PAYO_DATA_DIR`, that the raw request is not copied directly into `run.created.config`, and that agent-generated event text may echo the prompt and is visible to authenticated event consumers.

#### Tests

Tests above are written before implementation. CLI argument, client payload, Zod request, source-routing, and startup-helper tests are unit tests; `main.test.ts` additionally covers the real-mode readiness wiring in a subprocess. The HTTP request-to-approval case is a component test using the existing fake runner and workspace. Existing factory SQLite coverage from Phase 1 verifies actual request recovery; do not duplicate the same state-machine assertions at HTTP level. Edge cases include a prompt containing spaces, quotes, option-like text and the end-of-options marker, blank input, conflicting source selectors, API legacy payloads, unavailable Jira tooling, prompt text in `run.created.config`, and an agent echoing prompt text through SSE/events.

#### Success criteria

**Automated:**

- Focused: `cd payo && ./node_modules/.bin/vitest run packages/contracts/src/api.test.ts apps/cli/src/args.test.ts apps/cli/src/client.test.ts apps/server/src/adapters.test.ts apps/server/src/doctor.test.ts apps/server/src/main.test.ts apps/server/src/http.test.ts test/boundaries.test.ts`
- Types: `cd payo && ./node_modules/.bin/tsc --noEmit`
- Lint/format: `cd payo && ./node_modules/.bin/biome check .`
- Full suite: `pnpm -C payo check`

**Manual:**

- In fake mode, run `pnpm payo start --prompt create a simple FastAPI todo app with strict typing` and confirm it returns a run ID and reaches Approval; then run `pnpm payo start ABC-123` and confirm the Jira-compatible route still works.
- In a real environment with valid Pi/Git/role-skill setup but `PAYO_ACLI_BIN` pointing to a nonexistent executable, start the server and create a prompt run. Confirm the server is ready, the prompt run reaches planning, and `payo doctor` still reports the failed `acli` check. Confirm the original request is absent from `run.created.config`; treat any prompt echo in agent-generated event text as expected and document that event consumers can see it.
- With a ready Jira CLI, start `ABC-123` and confirm the Jira adapter is invoked only for that source.

#### What we're NOT doing

No Linear implementation, source auto-detection, dynamically loaded adapters, Jira issue creation or updates, changes to the planner/reviewer prompts, web UI, or changes to the run lifecycle beyond resolving and persisting the selected work item.

## Implementation Notes

- Phase 1 completed with source-neutral contracts, durable prompt artifacts, `ResolveWorkItem`, and legacy config/checkpoint normalization. The legacy SQLite resume integration case covers `FetchTicket` without a database migration.
- Phase 2 completed with canonical API/CLI requests, prompt routing, optional Jira startup readiness, and documentation updates. The real-mode subprocess uses a temporary committed role-skill repo, a ready test Pi executable, and an unavailable `acli` to verify readiness; startup blocking is separately covered by the existing failed-requirement subprocess case. No live Pi/Jira credentials were used.
- Manual fake-mode spot-check: started both an unquoted direct prompt and `ABC-123`; both runs reached Approval. The documented prompt confidentiality caveat is pinned by the HTTP echo-event test.

## Rollback and Compatibility

No SQLite schema migration is required. The new version reads legacy `ticketKey` API requests, old `FactoryRunConfig.ticketKey` records, old checkpoint `ticket` snapshots, and the `FetchTicket` stage. New runs write source-neutral config/checkpoints and prompt artifacts. The old binary cannot resume new source-neutral prompt runs, so do not downgrade while any such run needs recovery; retain the data directory and resume with this version.

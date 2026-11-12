---
date: 2026-11-11
title: Explicit GitHub draft publication and ticket naming in Payo
status: implemented
---

## Scope

Add user-requested publication of a successfully reviewed Payo execution as a GitHub draft PR. Confirm ticket identity before implementation; enforce branch and commit naming in engine code; let users customize ticketed naming and PR content in Settings. Publication supports executions created with the new naming snapshot, including new executions with no ticket. Existing executions remain readable and resumable but cannot use this publication flow.

Agreed phases: ticket identity and settings; branch/commit enforcement; durable GitHub publication; CLI/web controls. This is the publication portion of roadmap step 9, not its human-review, ready-for-review, merge, or subsequent-PR automation.

## Current State

- The roadmap identifies draft PR publication as the next slice and requires intent/outcome reconciliation before retries (`docs/payo/implementation-roadmap.md:144`). Current documented behavior ends at a retained local branch (`docs/payo/README.md:3`).
- The declared architecture makes the server the composition root, the kernel independent of modules/adapters, adapters implementations of ports, and clients thin (`docs/payo/engine-design.md:48`). Factory pure rules live in `domain/`, application flows in `planning/` and `execution/` (`docs/payo/engine-design.md:66`).
- Jira origin carries a key; prompt origin has no ticket identity (`payo/packages/contracts/src/factory.ts:27`). Prompt text is persisted as an artifact, so detection can use the stored work item rather than adding a second raw prompt store.
- Execution acceptance pins plan/base/checks/roles but no naming policy (`payo/modules/factory/src/execution/lifecycle.ts:205`). Duplicate implementation requests return a deterministic existing execution (`payo/modules/factory/src/execution/lifecycle.ts:166`).
- Branch creation and resume assume `payo/<execution-id>` (`payo/modules/factory/src/execution/prepare.ts:56`, `payo/modules/factory/src/execution/resume.ts:95`). The Git adapter also enforces that exact branch and uses the prefix as a commit ownership guard (`payo/adapters/git/src/execution.ts:640`, `payo/adapters/git/src/execution.ts:566`).
- Engine-owned subjects are currently `Implement <phase-id>` / `Finalize <phase-id>`; durable messages include a `Payo-Execution` trailer (`payo/modules/factory/src/execution/commit.ts:240`). Receipts and final artifacts reference the resulting SHAs.
- Successful execution writes `run.ended` (`payo/modules/factory/src/execution/commit.ts:591`). The generic reducer rejects subsequent events (`payo/packages/kernel/src/state.ts:53`). Publication cannot append to or reopen that execution.
- The settings form rebuilds a complete document on save; every new field must survive this round-trip (`payo/apps/web/src/features/settings/SettingsPage.tsx:714`). Config resolution remains restart-based.
- Server startup currently distinguishes execution from planning only (`payo/apps/server/src/run-application.ts:120`). The web similarly treats non-execution runs as planning (`payo/apps/web/src/features/run-workspace/RunWorkspace.tsx:49`), and ended runs stop streaming (`payo/apps/web/src/features/run-workspace/useRunActivity.ts:46`). A publication child needs explicit dispatch and rendering.

These references describe the inspected working tree, which already has unrelated staged and unstaged changes. Recheck touched definitions before implementation; preserve those changes.

## Design Decisions

### Hexagonal architecture and microkernel ownership

Keep publication within the existing factory module. It is another factory lifecycle, not a new plugin framework or a separate business module that imports factory internals.

| Location | Responsibility | Allowed dependencies |
|---|---|---|
| `packages/contracts` | Serializable configuration, request/response, snapshot and checkpoint schemas | No other Payo package |
| `packages/kernel` | Narrow repository-publication and code-host ports; existing generic run/event/store/gate machinery | Contracts only |
| `modules/factory/src/domain` | Ticket selection, template semantics, naming validation, publication eligibility and reconciliation decisions | Contracts and domain types; no I/O |
| `modules/factory/src/execution` | Apply pinned naming to owned branch and commit operations | Kernel ports and contracts |
| `modules/factory/src/publication` | Accept, execute, recover and query a publication lifecycle | Kernel ports and contracts |
| `adapters/git` | Git ref validation, ownership verification, commit inspection and exact-SHA push | Kernel and contracts |
| New `adapters/gh` | GitHub CLI invocation and normalization of repository/PR facts | Kernel and contracts |
| `apps/server` | Construct adapters, inject ports, coordinate commands, validate HTTP transport | Public package exports |
| `apps/cli`, `apps/web` | Collect choices, show server previews, invoke explicit commands | Contracts; existing CLI bootstrap config exception |

The kernel receives no ticket regex, naming template engine, publication stage machine, GitHub marker interpretation, or factory config dispatch. No changes to its event variants, reducer, terminal-state rules or SQL schema are required. Existing package rules remain intact; no module-to-module or adapter-to-adapter imports. Extend the existing boundary tests rather than introduce a parallel checker.

### Ticket identity and naming

- Jira uses its resolved canonical key and does not permit an override. Reuse the adapter's existing uppercase Jira-key shape, `[A-Z][A-Z0-9_]*-\d+`, for new selected ticket IDs; preserve every character, including digits and underscores. Do not tighten legacy planning schemas globally.
- For prompt runs, factory policy detects distinct uppercase key-shaped tokens with identifier boundaries in the stored description. Repeated references to one key count once. One candidate is preselected, several require a choice, and selection is confirmed before any worktree/writer starts. A manually entered valid ID is allowed. An explicit “No ticket” choice is allowed for unrelated references; never silently discard candidates or silently select among several.
- Keep the confirmed identity on the execution naming snapshot. Do not rewrite the immutable planning work item or add a second prompt-origin identity. Detection suggestions are read-time values; execution acceptance is the authority.
- Ticketed default branch: `{ticketId}/{slug}`, for example `ABC-123/create-todo-entity`. The suffix consists of 3–6 lowercase ASCII words separated by hyphens. Derive a suggestion from the selected PR title, normalize punctuation/diacritics, and retain at most six words. If fewer than three words remain, require user editing; do not add filler. Count the entire rendered suffix, including template literals, against the limit.
- Ticketed default commit subject and PR title: `[{ticketId}] {description}`. Enforce the exact selected key in the prefix, followed by a nonblank single-line description. Custom templates cannot remove, alter, repeat or move the required prefix. Branches retain exactly one slash, immediately after the exact key. Reject unknown placeholders and empty descriptions.
- Without a ticket, preserve `payo/<execution-id>` branches, use descriptive phase/final commit subjects without a ticket prefix, and use the selected PR title. Ticket-specific templates do not apply. Settings label them accordingly; no mandatory issue prefix or word-count rule is imposed on ticketless runs.
- Use phase titles for phase commit descriptions and `Finalize <selected PR title>` for final repairs. Collapse whitespace and reject control characters in subjects. Keep the current commit cadence, skip commits for unchanged trees, and retain `Payo-Execution` trailers outside the customizable subject.
- A collision never overwrites or silently adds a UUID. Before acceptance, let the user choose another valid slug. A race discovered during prepare remains gated; permit changing the stored slug/branch only while preparation has not established a workspace or commit intent, then retry preparation. After workspace creation, naming is immutable.

### Configuration and preview contract

Add `[publication]` configuration: `remote = "origin"`, `branch_template = "{ticketId}/{slug}"`, `commit_template = "[{ticketId}] {description}"`, `pr_title_template = "[{ticketId}] {description}"`, and `pr_body_template`. Add `[tools].gh`, default `gh`. Do not add environment overrides or secrets for these fields in this slice.

Template substitution is literal, with no evaluation, conditionals, filesystem access, shell execution or arbitrary properties. Naming fields support only their documented tokens (`ticketId`, `slug` or `description`). PR body supports `ticketId`, `prTitle`, `summary`, `changes`, `checks` and `executionId`. The default body has Summary, Changes and Validation sections populated from final-result/phase-receipt/check artifacts, not the full prompt or plan. The factory always appends its durable publication marker separately; the template cannot control it.

Contracts validate data shape; factory domain validates template semantics. Export `validatePublicationPolicy` from factory. The server calls it on candidate settings saves and startup; `packages/config` does not import factory. Browser validation handles shape and displays server policy errors, without reimplementing domain rules. Saving still requires restart. Execution acceptance snapshots effective templates and remote name so later settings edits cannot change an accepted execution.

Add factory `previewExecutionNaming(deps, sourceRunId, request, policy, signal)`. `ImplementPreviewRequest` has `prId`, optional `base`, optional `ticketId: string | null`, and optional `slug`. `ImplementPreview` returns candidates, chosen identity, slug, rendered branch, example commit/PR subjects, field errors, and a `previewHash` only for a valid selection. Multiple candidates with no selection produce a preview requiring a choice, not a runnable execution.

Extend `ImplementRequest` with optional `naming: { previewHash, ticketId: string | null, slug }`. It is optional for schema compatibility, but required by factory acceptance for a new execution. Hash the approved-plan artifact, selected PR, resolved base SHA, effective policy and selection. Acceptance recomputes the preview server-side and rejects stale hashes. Never trust client-supplied rendered branch/message strings. Check duplicate execution identity first: old callers can still retrieve an existing execution; a supplied selection conflicting with the stored snapshot returns conflict rather than implying it was applied.

### Publication is an explicit linked run

Create one deterministic publication child per execution, with a UUID derived using the existing hash-to-UUID pattern and a publication namespace. Its `config.factory.kind` is `factory-publication`. `PublicationRunConfig` records `sourceRunId` (planning), `executionRunId`, approved plan reference, reviewed commit, base commit, branch, resolved target, remote push URL, final title/body and preview hash. The execution stays ended with outcome `reviewed`.

Use existing `run.created`, step, gate, artifact and `run.ended` events. Checkpoints are immutable `factory-publication-checkpoint-v1` artifacts. Stages are `Push`, `CreatePr`, `Escalated`, `Completed`; checkpoint fields include revision, durable operation intent, observed remote SHA, PR reference, and paused operation/reason. Successful outcome is `published`. No agents are required for metadata generation or publication, so there is no new model cost or role configuration.

Expose `previewPublication`, `beginPublication`, `executePublication`, `openPublication`, `preparePublicationResume` and `readPublicationSummary` through the factory public entry point. Keep pure rules in `domain/publication.ts`, lifecycle/effect orchestration under `publication/`, and checkpoint storage in `publication/artifacts.ts` using the existing RunStore helpers. Reuse existing artifact read/write helpers and CommandError conventions.

### Narrow outbound ports

Add `packages/kernel/src/repository-publication.ts` with `RepositoryPublication`:

- `resolveRemote(repo, remote, signal)` returns fetch/push URLs; reject multiple push destinations.
- `readCommits(path, baseCommit, resultCommit, signal)` returns ordered commit SHA, subject and message records for the exact range.
- `readRemoteHead(pushUrl, branch, signal)` returns SHA or null; transport errors never mean absence.
- `pushCommit(path, pushUrl, branch, commit, signal)` creates the remote branch at the supplied SHA and never overwrites an existing branch.

Add `packages/kernel/src/code-host.ts` with `CodeHost`:

- `resolveRepository(remoteUrl, baseBranch, signal)` returns canonical host/owner/name, repository ID, base branch and current base SHA.
- `findPullRequests(target, headBranch, signal)` returns exact head/base identity, state, draft flag, head SHA, body and URL, across open/closed/merged states.
- `createDraftPullRequest(target, { headBranch, title, body }, signal)` creates only a draft in the explicitly named repository.

Port methods express effects and observed facts; they do not decide ticket validity, whether to publish/retry, whether a PR marker matches, or how to resolve conflicts. Reuse `ExecutionWorkspace.inspect` for local branch/HEAD/cleanliness checks. The Git adapter shares its existing executor internally; `adapters/gh` has an injectable argv-based executor following the existing process adapter pattern. Both receive AbortSignal and bounded timeouts/output sizes. The server alone supplies implementations.

### Publication authorization, target and recovery

1. A read-only preview requires a new-policy execution with terminal outcome `reviewed`, intact final evidence/receipts, exact owned branch, exact result HEAD and clean worktree. Read and validate every commit in the execution range against its pinned ticket policy. Reject a zero-commit/empty-result publication. Do not rewrite history to repair a mismatch.
2. Resolve the configured remote. Initially support same-repository GitHub.com SSH/HTTPS remotes; require fetch and push URLs to identify the same canonical repository and require the selected base branch to exist there. No fork selection, multiple destinations, enterprise host setup or arbitrary URL input. `gh` readiness is checked here, so missing GitHub tooling does not block planning/implementation startup. Never store credentials embedded in a remote URL; reject credential-bearing URLs.
3. Preview shows canonical destination, base/head, reviewed SHA, commit subjects, rendered title/body and base movement. If the target base no longer equals the pinned execution base, block publication in this slice. The execution was reviewed against that base; do not silently rebase, merge or claim a changed PR diff was reviewed. Recovery guidance explains that a newly approved plan/execution against the updated base is required. Recheck the base immediately before creation; GitHub base branches can still advance concurrently, which is disclosed in the preview/docs and left to normal PR review/CI.
4. `PublicationPreview` contains `previewHash`, execution ID, target, pinned content, commits and eligibility/errors. `PublishRequest` contains that hash and optional edited title/body. Validate edited title against the exact ticket prefix; append the marker after any edited body. Server recomputes preview before accepting and persists final content before scheduling. Preview creates no durable run and triggers no push/PR side effect.
5. Only explicit `POST /runs/:executionId/publish` or the matching CLI action creates/schedules the child. Completing an execution, viewing a preview, saving settings, starting the server or receiving SSE never publishes. Concurrent duplicates return one child; different content/destination against an already accepted child conflicts. A repeated matching request returns the existing child without scheduling it again, including after success.
6. Before the first push intent, successfully query the remote head and require absence; any pre-existing branch, including an equal SHA, gates rather than being adopted. Then persist intent including destination, branch and reviewed SHA before issuing push. On recovery with that stored intent, an absent ref permits retry, the exact intended SHA reconciles success, and a different SHA gates. Use an atomic create-only ref update so a racing remote writer cannot be overwritten. An explicit empty expected ref lease is one supported Git mechanism; it must never be used to replace an existing ref. Query after uncertain outcomes before retrying.
7. Before PR creation, persist its intent and an immutable marker, `<!-- payo-publication:<publication-run-id> -->`. Search by exact repository/head/base and validate marker, reviewed head SHA, title/body and draft state. One matching PR reconciles success. An unrelated PR, multiple matches, changed content/head, or closed/merged PR gates; never edit, reopen or duplicate it automatically. After creation, query again and verify normalized facts before recording completion.
8. On timeout, abort, lost response or error, retain durable intent and gate with the observed uncertainty. Resume queries before retrying an effect. If a query itself fails, remain gated. No timer-driven or startup retry. Never delete remote branches/PRs to compensate.
9. `openPublication` creates a recovery gate for every active publication on restart, including a crash immediately after child creation with no running step. Account for generic `openRun` interrupted-step gates (`retry`/`abandon`): explicit factory resume resolves the relevant stored gate using an allowed command and closes stale running steps before proceeding. Do not alter kernel gate rules or leave open gates when ending a publication.

## Phase 1 — Add ticket identity and naming settings

### Overview

Introduce pure factory naming policy, editable configuration and a read-only execution preview. Existing implementation behavior remains available until Phase 2 makes confirmed naming mandatory for new executions.

### Changes

1. [x] Add `payo/packages/contracts/src/publication.ts` with `PublicationPolicy` (effective camelCase values), `ExecutionNamingSnapshot` (`version: 1`, confirmed ticket ID or null, slug, branch, pinned policy), `ImplementPreviewRequest` and `ImplementPreview`. Export from `index.ts`. Keep subject/slug/template behavior in factory domain, not schemas.
2. [x] Extend `payo/packages/contracts/src/config.ts` `PayoConfigDocument` with the optional TOML fields described above and `tools.gh`; extend `packages/config/src/index.ts` `PayoConfig`/`resolvePayoConfigDocument` to carry them with defaults. Carry values through `apps/server/src/config.ts` without introducing new env variables. Add a documented starter body to `payo/config.example.toml`.
3. [x] Add `payo/modules/factory/src/domain/naming.ts`: `detectTicketIds`, `validatePublicationPolicy`, `resolveTicketSelection`, `suggestSlug`, `renderBranch`, `renderCommitSubject`, `renderPrTitle`, `renderPrBody`. Functions take explicit values and return values/validation failures without filesystem, clock, environment, process, fetch or kernel I/O calls. Keep the default body with factory policy; config carries absent overrides until policy resolution.
4. [x] Add `payo/modules/factory/src/execution/naming.ts` to read the approved source work item/plan, resolve effective policy/base, and provide `previewExecutionNaming`; export via `modules/factory/src/index.ts`. Reuse `selectedPr` and approved artifact reads, extracting a shared read helper only if needed to avoid an import cycle.
5. [x] In `apps/server/src/settings.ts`, call exported policy validation after config resolution and before writing. Validate the startup policy in `composition.ts` before accepting commands. Surface field-specific errors through the existing error path.
6. [x] Extend `SettingsPage.tsx` `SettingsForm`, `formFromDocument`, `buildCandidate` and `fieldForIssue` for remote, gh executable and four template controls. Show fixed identity/word-count constraints and supported placeholders. Preserve unrelated/hidden settings when saving.

### Tests — write before implementation

- Unit: new `modules/factory/src/domain/naming.test.ts` covers repeated/single/multiple IDs, token boundaries, manual selection, explicit no-ticket, immutable Jira selection, exact ID preservation, slug normalization/3–6 words, template literal word counts, required prefixes, unknown tokens, multiline/control-character subjects and ticketless fallbacks. This owns policy cases; do not duplicate them in UI tests.
- Unit: new `modules/factory/src/execution-naming.test.ts` covers source artifact use, unapproved source, nonexistent PR, valid/invalid previews and stale plan/base/policy fingerprint changes.
- Unit/config integration: extend `contracts/src/config.test.ts` and `config/src/index.test.ts` for strict shape, defaults, TOML round-trip and unchanged precedence. Extend `server/src/settings.test.ts` for semantic rejection before disk write.
- UI component: extend `SettingsPage.test.tsx` for complete new-field round-trip, unrelated save preservation and returned validation errors.

### Success criteria

**Automated**, from repository root:

```sh
rtk pnpm -C payo exec vitest run modules/factory/src/domain/naming.test.ts modules/factory/src/execution-naming.test.ts packages/contracts/src/config.test.ts packages/config/src/index.test.ts apps/server/src/settings.test.ts apps/web/src/features/settings/SettingsPage.test.tsx test/factory-boundaries.test.ts
rtk pnpm -C payo exec tsc -p tsconfig.json
rtk pnpm -C payo exec tsc -p apps/web/tsconfig.json
```

**Manual:** save custom ticketed templates and a multiline PR body in Settings, reload them and confirm restart guidance. Try removing the required ticket prefix and observe the server reject the save.

### Phase 1 verification — 2026-11-11

- [x] Domain, preview, config, server-settings and Settings component tests were written first and observed failing before implementation. The explicitly empty body round-trip also has a regression test.
- [x] All seven Phase 1 test files pass: 114 tests. Another 120 execution/server/config/package-boundary regression tests passed during implementation.
- [x] Both TypeScript projects pass. Biome passes for the 20 touched TypeScript/TSX files.
- [x] A real local fake-mode server with a temporary config accepted custom ticketed templates and a multiline body, returned the same values on reload, rejected a missing ticket prefix with HTTP 400, and retained the previously saved document. Temporary servers were stopped afterward.
- [ ] Browser save/reload and visual restart-guidance check: blocked by the existing local Vite error `Can't resolve 'tailwindcss'`. Component tests cover the controls, preservation, returned policy errors and restart guidance; dependencies were left unchanged.

Implementation notes: reused the existing approved-source reader and deterministic execution-ID helper by exporting them within the factory implementation; no new public lifecycle or writer behavior. Preview dependencies expose only artifact reads and base resolution. Absent body overrides stay absent until factory policy resolution; explicitly empty body templates survive unrelated Settings saves.

Verification tooling deviation: the prescribed `rtk pnpm -C payo ...` launcher attempted a package-manager download and failed with `fetch failed`. Ran the same installed Vitest, TypeScript and Biome executables through `rtk proxy node` from `payo/` instead. No dependency or lockfile changes.

### What we're NOT doing

No writer changes, prompt rewriting, arbitrary template language, custom ticket regex, per-repository profiles, live config reload or publication effect.

## Phase 2 — Enforce branches and commits

### Overview

Require a confirmed naming preview for new executions and apply the stored policy throughout execution and restart recovery. Keep old execution records working without making them publishable.

### Changes

1. Extend `ImplementRequest` in `contracts/src/api.ts` and add optional `naming` to `ExecutionRunConfig` in `contracts/src/execution.ts`. Extend `ExecutionSummary` with optional naming snapshot and a publication eligibility reason for missing snapshot. Absence means legacy; never fabricate a version-1 snapshot while reading history.
2. Update `prepare-execution.ts`, `execution/lifecycle.ts` `BeginExecutionInput`/`beginExecution` and `findExistingExecution` to validate/recompute confirmation, bind the resolved base, and snapshot naming atomically with `run.created`. Return existing deterministic executions before newly required configuration validation, while rejecting conflicting supplied selections.
3. Add one factory accessor for the expected branch: new snapshots use their pinned branch; legacy records use `payo/<runId>`. Use it in `execution/prepare.ts`, `execution/implement.ts`, `execution/resume.ts`, and any recovery/read-model assertions found by searching every `payo/` assumption. Read commit subjects from pinned policy in `execution/commit.ts`; preserve durable message/trailer reconciliation and commit cadence. Verify the actual created/reconciled full message matches intent, so a commit hook cannot silently remove/change the ticket subject while retaining its trailer.
4. Add a preparation-only naming correction command in `execution/naming.ts`, accepted only with no workspace and no commit intent. Add `ExecutionNamingRequest = { slug: string, previewHash?: string }` in `contracts/src/publication.ts`: omission of the hash requests a read-only correction preview; a hash confirms it. Both preserve the stored ticket and policy. Persist the new naming selection as a checkpoint override bound to the original policy/identity; use it for subsequent branch expectations and publication reads. Do not mutate `run.created.config`. Extend the checkpoint schema additively with this optional override. Revalidate preview/concurrency before retrying preparation.
5. In `adapters/git/src/execution.ts`, replace exact prefix assumptions with Git ref validation and persisted `.meta/<execution-id>.json` ownership checks for execution ID, canonical repo/path, branch and pinned base. Require the metadata at commit, not only a matching branch prefix. Never weaken root/path checks, commit parent/tree checks, clean-worktree checks or collision refusal. Preserve interrupted metadata-creation recovery during initial prepare.
6. In `apps/server/src/factory-fixtures.ts`, store the actual requested branch in fake workspace state and return it from inspect, rather than reconstructing `payo/<id>`. Update factory fake workspace helpers and persisted fixtures that depend on fixed names; retain explicit legacy fixtures.
7. Add `RunApplication.implementPreview`, the preparation naming-correction method, and thin validated HTTP endpoints in `apps/server/src/http.ts`: `POST /api/v1/runs/:sourceId/implement-preview`, existing `POST .../implement`, and `POST /api/v1/runs/:executionId/execution-naming`. Keep all policy inside factory. Pass effective policy through preparation options assembled in composition.

### Tests — write before implementation

- Factory component: extend `execution.test.ts` for missing confirmation on new execution, stale preview, exact ticketed branch/phase/final subjects, ticketless execution, duplicate identity, conflicting duplicate choices, pinned settings after restart, no-change scopes, collision before prepare, permitted pre-workspace correction and refusal after worktree creation.
- Git integration: extend `adapters/git/src/execution.test.ts` using temporary repos for arbitrary valid ticket branches with verified metadata, foreign/missing/mismatched metadata refusal, invalid refs, existing branch collisions and commit-hook subject changes. Keep parent/tree/trailer and crash reconciliation cases.
- Compatibility: extend `factory-persistence.test.ts` to resume an old execution under its original branch/message intent and reject publication eligibility without rewriting receipts. Extend `http.test.ts` for preview/acceptance/correction shape and errors, not the domain rule matrix.
- Architecture: extend `test/factory-boundaries.test.ts` to reject process/network imports in pure factory domain, alongside its existing I/O/global restrictions.

### Success criteria

**Automated:**

```sh
rtk pnpm -C payo exec vitest run modules/factory/src/execution.test.ts modules/factory/src/execution-state.test.ts adapters/git/src/execution.test.ts apps/server/src/factory-persistence.test.ts apps/server/src/http.test.ts test/boundaries.test.ts test/factory-boundaries.test.ts
rtk pnpm -C payo check
```

**Manual:** inspect a temporary ticketed execution's branch and `git log`; verify exact ID prefixes and trailers. Restart a paused execution after changing settings and confirm its naming is retained. Exercise a branch collision without overwriting the existing branch.

### Phase 2 verification — 2026-11-11

- [x] The Phase 2 suite passes: 177 tests across the seven files.
- [x] Branch/subject/preview and restart behavior are covered by `execution.test.ts`, `execution-state.test.ts` and `factory-persistence.test.ts`; ownership, collision, invalid-ref and commit-hook checks by `adapters/git/src/execution.test.ts` against temporary repositories; API shape by `http.test.ts`; pure-factory boundaries by `test/factory-boundaries.test.ts`.
- [x] Both TypeScript projects pass. Biome exits 0 with warnings only (new test non-null assertions and the pre-existing CSS `!important` warnings).
- [x] The manual properties are exercised by integration tests: exact ticketed/ticketless subjects and trailers, pinned naming after reopen, and collision refusal without overwriting the existing branch. No separate hand-run server inspection was repeated.
- [x] `pnpm check` was reproduced with the installed binaries from `payo/` (Biome, both `tsc` projects, full Vitest), because the prescribed `rtk pnpm` launcher attempted a package-manager download. `@payo/gh` was linked with `pnpm install --offline`; no dependency versions changed.

### What we're NOT doing

No history rewriting, legacy naming migration, extra commits, squash/rebase, remote push, or post-workspace branch renaming. CLI/web confirmation controls ship in Phase 4; direct API clients can exercise this phase.

## Phase 3 — Add durable GitHub publication

### Overview

Publish the exact reviewed result through injected repository/code-host ports, with persisted intent and conservative reconciliation. Model publication as a linked factory run while retaining the kernel's existing lifecycle unchanged.

### Changes

1. Add the two kernel port files/signatures described above and public exports in `packages/kernel/src/index.ts`. Extend `contracts/src/publication.ts` with `PublicationRunConfig`, `PublicationCheckpoint`, `PublicationSummary`, `PublicationPreviewRequest` (empty object), `PublicationPreview`, `PublishRequest` and normalized target/PR records. Add optional `publication` to `RunSummary`; execution summaries may expose the deterministic publication child ID/status through read-time discovery, never through events on the ended execution.
2. Add `adapters/git/src/publication.ts`, exported by its existing index, implementing remote resolution, exact-range commits and create-only push using its own package's Git executor. Use argv arrays and explicit SHA/refspecs, not current HEAD/default push settings. Run `git check-ref-format --branch`; reject unsafe URLs/protocols and credential-bearing URLs. Disable configured extra-tag pushes and reject multiple push URLs so only the requested branch is affected. A remote ref appearing between query and push must fail without update, even if it is an ancestor of the desired commit.
3. Add `payo/adapters/gh/package.json` (`@payo/gh`, dependencies only kernel/contracts), `src/exec.ts`, `src/index.ts`, and fixture files under `src/fixtures/`. Use explicit repository/base/head/title/body arguments, `--draft`, no shell, no autofill/editor/browser/fork prompts. Feed multiline body via stdin (`--body-file -`) or a private temporary file with cleanup. Normalize structured query output, validate it, and preserve uncertainty on errors. Resolve only supported same-repository GitHub.com targets. The adapter does not decide marker ownership or retries. Update server package dependency and workspace lockfile through pnpm.
4. Add `modules/factory/src/domain/publication.ts` for eligibility, preview binding and observed-state reconciliation. Add `publication/lifecycle.ts`, `publication/run.ts`, `publication/artifacts.ts` and `publication.ts` public facade for acceptance, effects, restart gates, explicit resume and read projections. Use the detailed protocol above and existing store helpers; no filesystem/process access in this application flow. Generate body from validated result/receipt/check artifacts; do not create an agent attempt.
5. Update `apps/server/src/adapters.ts` `AdapterSet`/`createAdapterSet` and `composition.ts` to build/inject the new ports and policy. Fake mode supplies deterministic fake ports; real gh availability is checked lazily during publication preview, not a global startup blocker. Shutdown aborts and waits for publication tasks through existing scheduling controls.
6. Update `run-application.ts` to dispatch publication configs before the planning fallback on startup, retain publication handles, expose preview/publish methods, and include children in list/summary/events/hasRun/isActive/resume. Map publication cost requests to their planning source. Repeated publish opens the existing child without scheduling. Update `run-summary.ts` for publication stage, gates and linkage.
7. Add `POST /api/v1/runs/:executionId/publication-preview` and `POST /api/v1/runs/:executionId/publish` in `http.ts`; publish returns the existing `RunIdResponse` with the child ID. Read/resume/events use existing run endpoints. Preserve token/origin/body-limit/error handling. Generic `resume` rejects execution issue-answer payloads on publication runs.
8. Extend `test/boundaries.test.ts` with gh adapter imports, kernel-to-gh rejection and client-to-gh rejection. Extend `test/factory-boundaries.test.ts` to cover new domain/application folders without allowing process calls or imports from adapter packages. Do not modify kernel event/reducer/state semantics to support the new flow.

### Tests — write before implementation

- Unit: new `domain/publication.test.ts` covers eligibility, exact ticket commit-range validation, empty results, legacy refusal, stale previews, target mismatch, marker/content/draft/head mismatches, conflicting PRs and reconciliation decisions.
- Factory component: new `publication.test.ts`, using fake ports and existing fake/in-memory store conventions, covers explicit acceptance only, concurrent duplicate acceptance, conflicting second content, crash before/after push, push success with lost response, crash before/after PR creation, unknown query outcome, different remote SHA, equal but unowned pre-existing branch, existing unrelated/closed PR, base movement, no-step startup interruption and generic interrupted-step gate resolution. Verify effects are never issued before their intent is stored and never on open/recovery alone.
- Git integration: new `adapters/git/src/publication.test.ts`, with local bare remote, verifies exact SHA push even if local HEAD moves, remote-query failure versus absence, multiple destinations rejection, no extra tags and atomic refusal of a racing existing ref. No GitHub network required.
- Adapter fixture tests: new `adapters/gh/src/index.test.ts` verifies argv/stdin, supported URL identity, malformed/partial query data, all PR states, authentication failures, cancellation and ambiguous effect outcomes. Use recorded synthetic fixtures, not live credentials.
- Server persistence/component: extend `factory-persistence.test.ts`, `composition.test.ts` and `http.test.ts` for child recovery, execution remaining terminal, summary/events visibility, source cost mapping, missing gh not blocking nonpublication work, and shutdown. Reopening old/new planning and execution histories must still work.

### Success criteria

**Automated:**

```sh
rtk pnpm -C payo exec vitest run modules/factory/src/domain/publication.test.ts modules/factory/src/publication.test.ts adapters/git/src/publication.test.ts adapters/gh/src/index.test.ts apps/server/src/factory-persistence.test.ts apps/server/src/composition.test.ts apps/server/src/http.test.ts test/boundaries.test.ts test/factory-boundaries.test.ts
rtk pnpm -C payo check
```

**Manual:** inspect a fake publication's event/artifact sequence and verify intent precedes effects. Restart between simulated remote success and outcome persistence, explicitly resume, and verify the same child/PR reference is retained. A live scratch-repository publication is optional and requires an explicit operator publication action; it is not part of planning or the default test suite.

### Phase 3 verification — 2026-11-11

- [x] The Phase 3 suite passes: 128 tests across the nine files.
- [x] Full `vitest run` passes: 1033 tests passed, 1 pre-existing test skipped. Both TypeScript projects pass. Biome exits 0 with warnings only.
- [x] Eligibility, exact commit ranges and observed-state reconciliation are covered by `domain/publication.test.ts`. Explicit-only acceptance, intent before effects, duplicate acceptance, cost mapping, lost push/PR responses, unowned equal remote branches, unknown query outcomes and interrupted startup are covered by `publication.test.ts`.
- [x] The Git adapter is covered against a local bare remote (exact-SHA push, remote query failure/absence, invalid destinations, no extra tags, racing ref refusal). The gh adapter is covered with recorded fixtures (argv/stdin, URL identity, malformed output, PR states, auth failure, cancellation, ambiguous outcomes).
- [x] Server restart/recovery is covered by `composition.test.ts` ("recovers an interrupted publication child on restart and resumes it explicitly"); the explicit preview/publish HTTP flow, terminal parent and child reuse by `http.test.ts`; boundaries by `test/boundaries.test.ts` and `test/factory-boundaries.test.ts`.
- [x] The manual fake-publication sequence and restart between remote success and outcome persistence are exercised by the publication and composition tests above. No live scratch-repository publication was performed (optional per the plan).
- [x] Deviation: fake execution commits now use valid 40-hex SHAs instead of placeholders so fake mode exercises the real publication contract; the e2e expectation was updated accordingly. Publication remains unavailable from the CLI/web until Phase 4.

### What we're NOT doing

No human PR-review loop, CI repair, ready/merge actions, next-PR branching, webhook polling, fork/enterprise support, remote cleanup, generic workflow registry, new database tables, new event kinds or paid metadata agents. UI display is completed in Phase 4; ship Phase 3 and 4 together.

## Phase 4 — Expose confirmation and publication in CLI and web

### Overview

Provide server-backed naming confirmation before implementation and an explicit publication preview/action after review. Display publication as its own linked run, including live status, recovery gates and the GitHub result.

### Changes

1. [x] Extend `apps/cli/src/args.ts` `Command`/parsers, `client.ts` `CliClient` and `index.ts` `runCli`/`formatSummary` with these commands:

   ```text
   payo implement <source-id> --pr <pr-id> --preview [--base <ref>] [--ticket-id ABC-123 | --no-ticket] [--slug create-todo-entity]
   payo implement <source-id> --pr <pr-id> --confirm <preview-hash> [--base <ref>] [--ticket-id ABC-123 | --no-ticket] --slug create-todo-entity
   payo execution-naming <execution-id> --confirm <preview-hash> --slug another-valid-description
   payo publish <execution-id> --preview
   payo publish <execution-id> --confirm <preview-hash> [--title <text>] [--body-file <path>]
   ```

   Implementation without confirmation prints the server preview and confirmation instructions and starts no new execution. `--confirm` is explicit authorization; no interactive input framework is added. Reject conflicting flags, missing values and publication without either preview or confirmation. Ticketless confirmation uses `--no-ticket`; its server branch can remain `payo/<id>` and slug may be omitted where irrelevant. `execution-naming` first obtains the preparation-only preview through the same endpoint when `--confirm` is absent; it preserves the stored ticket/policy. Read body files in the CLI's existing local-I/O layer and send text via structured JSON. Print publication child ID; `status`, `logs -f` and `resume` work on that child.
2. [x] Extend `features/plan-review/api.ts` with preview/correction client helpers. Update `ImplementPrForm.tsx`: preview before launch, show candidate/manual/no-ticket selection and editable slug, render exact server branch/subject examples, and confirm the latest valid preview. Changing selection/base/slug invalidates the displayed confirmation until refreshed. Do not duplicate detection/rendering rules in React. Existing execution navigation remains available without requesting a new naming snapshot.
3. [x] Add `features/run-workspace/PublishPrForm.tsx` and endpoint helpers in that feature's `api.ts`. On eligible reviewed executions, load a preview on explicit action, show destination/base/head/commits/title/body, allow title/body editing, then send `PublishRequest` only on “Create draft PR”. Show ineligible legacy/stale-base/mutated-worktree reasons from the server. Duplicate clicks are disabled locally and deduplicated durably by the server.
4. [x] Add `features/run-workspace/PublicationView.tsx`. Update `RunWorkspace.tsx` with an explicit publication view/default and links to execution/planning, publication stages, resume action, final GitHub URL and activity. Navigate to the publication child after acceptance; do not wait for the ended execution's SSE. Extend `useRunActivity.ts` checkpoint refresh to recognize `factory-publication-checkpoint-v1`.
5. [x] Add preparation-only slug correction controls to the existing execution retry UI, using server-provided eligibility and preview. Do not expose identity/history changes after workspace creation.
6. [x] Update `features/runs/RunList.tsx` family grouping/labels for `publication.sourceRunId` so children appear under the same work, not as unrelated plans. Update `ActivityTimeline.tsx`, `activityLabel.ts` and `stageLabel.ts` only for labels that generic step/artifact rendering does not already cover. Keep CostPanel pointed at the existing work-cost query; publication adds no agent attempts and does not alter WorkCostTree or fabricate cost measurements.
7. [x] Update `docs/payo/usage.md`, `docs/payo/README.md`, `docs/payo/engine-design.md`, `docs/payo/implementation-roadmap.md`, `docs/payo/agentic-factory.md`, repository `README.md` and `payo/apps/web/README.md` to distinguish local review from explicit publication, document templates, legacy exclusion, restart and base-drift limits, and mark only the publication portion of step 9 implemented. Do not mark human PR review or next-PR automation complete.

### Tests — write before implementation

- CLI unit/HTTP-client: extend `args.test.ts` and `client.test.ts` for preview without mutation, explicit confirmation, ticket selection/no-ticket, edited content, conflicting flags, stale preview, body-file errors, child status and resume. Test dispatch with fake HTTP responses, not GitHub.
- UI components: add `ImplementPrForm.test.tsx`, `PublishPrForm.test.tsx` and `PublicationView.test.tsx`; extend `SettingsPage.test.tsx`, feature API tests, `RunWorkspace.test.tsx` and `RunList.test.tsx`. Cover confirmation-required interaction, server-rendered values/errors, invalidation after edits, preparation-only correction, no publish before click, legacy ineligibility, child navigation and refresh after publication checkpoint events. Reuse existing Button/Markdown, query client and test helpers; verify labels, keyboard access and pending/error feedback.
- Thin end-to-end: extend `apps/server/src/e2e.test.ts` with one fake-port CLI scenario: preview → confirm naming → reviewed execution → publication preview → explicit publish → child published → repeated request returns same child. Domain edge cases remain in unit/component tests. No live remote effects in CI.

### Success criteria

**Automated:**

```sh
rtk pnpm -C payo exec vitest run apps/cli/src/args.test.ts apps/cli/src/client.test.ts apps/web/src/features/plan-review/ImplementPrForm.test.tsx apps/web/src/features/run-workspace/PublishPrForm.test.tsx apps/web/src/features/run-workspace/PublicationView.test.tsx apps/web/src/features/run-workspace/RunWorkspace.test.tsx apps/web/src/features/runs/RunList.test.tsx apps/server/src/e2e.test.ts
rtk pnpm -C payo check
rtk pnpm -C payo web:build
```

**Manual:** in fake mode, complete prompt naming confirmation, inspect exact naming, explicitly create a draft, follow the publication child and recover an interrupted publication. Check mobile/keyboard layout and title/body previews. Optionally use a disposable GitHub repository to inspect the real draft, its prefixes/body/check summary and single-PR retry behavior; click confirmation yourself after verifying destination.

### What we're NOT doing

No auto-publish toggle, publication from old executions, freeform history repair, GitHub comments/review management, automatic ready/merge, remote branch deletion, new UI framework or client-owned naming policy.

## PR Strategy

1. **PR 1: Add ticket naming policy and settings**
   - Phase 1 — Add ticket identity and naming settings
   - Additive preview/policy groundwork; existing execution behavior remains intact.
2. **PR 2: Enforce naming and publish reviewed results explicitly** — depends on PR 1.
   - Phase 2 — Enforce branches and commits
   - Phase 3 — Add durable GitHub publication
   - Phase 4 — Expose confirmation and publication in CLI and web
   - Ship these together so newly mandatory confirmation has working clients, and linked publication runs have complete recovery/list/UI support. Implement and verify each phase separately within this PR.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Naming change weakens worktree ownership or breaks restart | Verify metadata identity rather than prefix; pin naming; retain legacy fallback and crash tests. |
| A Git hook changes the ticket subject | Verify actual full message against persisted intent on create/reconcile, beyond the trailer check. |
| A prompt mentions unrelated/multiple tickets | Show candidates, require confirmation/choice, allow explicit no-ticket; never guess among several. |
| Multiple PR units want the same short branch | Derive from the selected unit, preview collisions and allow only pre-workspace slug correction. |
| Publication retries create duplicate branches/PRs | Durable intent, deterministic child, exact marker/target reconciliation, create-only push and query before retry. |
| Network/auth failure is mistaken for absence | Port errors preserve uncertainty and gate; absence is an explicit successful query result. |
| Remote config or settings change redirects publication | Bind preview and durable intent to canonical destination, push URL, SHA, content and pinned policy. |
| Target base moves after implementation | Block observed drift; no automatic rebase. Recheck before PR creation and disclose the remaining external race. |
| Ended parent cannot stream publication progress | Explicit child run, config dispatch and child navigation; no writes to ended parents. |
| A new child is rendered/recovered as planning | Update server dispatch, summary, list, costs/resume and explicit web publication rendering together. |
| Template/body exposes raw planning content | Use selected unit/result/receipt/check summaries only; show complete body before user requests publication. |
| Config fields disappear on an unrelated save | Extend both form directions and test complete-document round-trip. |
| Missing gh blocks unrelated local work | Lazy publication-only readiness validation; no new startup-blocking probe. |

## Compatibility and Rollback

All persisted naming/checkpoint fields are additive. Existing execution branches, pending commit intents, receipts and terminal states remain untouched. Eligibility is based on a stored version-1 naming snapshot, never a timestamp or UI flag. New execution confirmation is an intentional API/CLI behavior change and ships with both clients.

No SQL migration or historical event rewrite. Publication children use existing events and immutable artifacts. Stop the server and back up the existing data directory before changing versions. An older server may not understand new publication configs and will log/skip those children; it cannot safely resume them. New ticket-named executions also require the new server for recovery. Roll back before accepting new executions/publications where possible; otherwise retain the newer version to recover them. Never rename branches, delete child logs, rewrite SHAs or remove remote PRs as rollback.

## Assumptions and Validation

- **Default publication is a draft in the same GitHub.com repository through origin.** Validate a supported SSH and HTTPS fixture, a missing base, and mismatched fetch/push identities. Fork/enterprise expansion is separate work.
- **Ticketed templates retain the mandatory example structure.** Settings can customize descriptive text but cannot bypass the exact ID prefix. Validate defaults and rejected prefix-changing customizations in domain tests; ticketless naming stays relaxed.
- **Short descriptions are suggested without another model call.** Validate six-word truncation and the explicit edit path for titles yielding fewer than three usable words.
- **Observed target-base drift blocks this initial slice.** Test that no push happens in this case and document the new-plan/new-execution recovery path. Automated rebase/revalidation is deliberately deferred.
- **Publication metadata needs no agent.** Validate zero publication attempts and unchanged work-cost totals; do not extend cost schemas solely for an unmeasured local operation.
- **PR body provenance must survive retry.** Append a noncustomizable marker, snapshot final content, and test exact owned-PR reconciliation across lost responses and manual edits.
- **GitHub CLI flags and create-only Git updates must be verified against the installed binaries before adapter implementation.** Official references: [gh pr create](https://cli.github.com/manual/gh_pr_create) supports explicit base/head/draft/body-file; [git push](https://git-scm.com/docs/git-push) documents an empty expected lease as requiring an absent ref. Confirm the chosen argv in adapter tests and the atomic refusal case against a local bare remote. Do not equate a dry-run CLI preview with a side-effect-free operation; Payo previews use read-only queries.

## Planning Verification

Read-only source/documentation inspection and independent bounded code research informed this plan. Reviewed the declared package boundaries, factory domain/application layout, terminal reducer rules, execution naming/recovery, settings round-trip, server dispatch and UI streaming. Checked the requirement-to-phase coverage and PR-to-phase mapping. No implementation code changed, no test suite ran and no branch was pushed or PR created during planning.

## Phase 4 implementation verification — 2026-11-12

- [x] CLI end-to-end scenario passes: preview → confirm naming → restart/resume → reviewed → publication preview → explicit publish → published child → duplicate child reuse.
- [x] CLI preview/confirmation, naming correction and publication commands; server-validated web naming, explicit publication preview/edited content, linked child display/recovery, family grouping and checkpoint refresh implemented.
- [x] Focused component tests observed failing before implementation; component tests cover explicit-only effects, edited publication content, server ineligibility, naming invalidation and preparation-only correction. Existing Settings coverage remains green.
- [x] Full suite: 1048 tests passed, one existing skipped test. Both TypeScript projects pass. Biome passes with existing warnings.
- [x] Production Vite build passes (bundle-size advisory only). Fixed the existing Tailwind resolution blocker by declaring the already installed tailwindcss ^4.3.3 directly in web devDependencies; pnpm updated the lockfile offline without version upgrades.
- [ ] Manual browser/mobile visual and Settings save/reload checks were not performed; component coverage verifies labelled controls, keyboard interactions, confirmation, server errors and restart guidance. The prior build blocker is resolved.
- [ ] Optional live disposable GitHub publication was not performed. No live push or PR creation was issued.

Verification tooling: used installed node executables for Vitest, TypeScript, Biome and Vite. Full integration tests require execution outside the sandbox for local server binding; the sandbox run failed for that restriction and the authorized run passed. pnpm dependency update completed offline outside the sandbox.

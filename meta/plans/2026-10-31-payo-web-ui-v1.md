---
date: 2026-10-31
title: Payo web UI v1 implementation
status: draft
---

# Payo web UI v1 implementation

## Current State

- The [UI direction](../../docs/payo/payo-web-ui-v1.md) specifies a local run-centered React application, editor-based plan changes, and four incremental phases.
- The server has authenticated run, event, stream and command routes; failure responses currently omit CORS headers even for allowed origins ([http.ts:49](../../payo/apps/server/src/http.ts#L49), [http.ts:233](../../payo/apps/server/src/http.ts#L233)). Separate browser origins must be explicitly allowed ([config.ts:67](../../payo/apps/server/src/config.ts#L67)).
- Summaries contain stage, repository and gates but no work-item identity ([api.ts:74](../../payo/packages/contracts/src/api.ts#L74), [composition.ts:184](../../payo/apps/server/src/composition.ts#L184)). A checkpoint holds the resolved item, plan and review references and answers ([factory.ts:103](../../payo/packages/contracts/src/factory.ts#L103)).
- The editable plan is a run-scoped file with directory and symlink checks ([plans.ts:58](../../payo/modules/factory/src/plans.ts#L58)); approval reads it, rejects unanswered questions, removes the workspace and ends the run ([commands.ts:703](../../payo/modules/factory/src/commands.ts#L703)). Review artifacts can contain findings without verifier verdicts ([review.ts:52](../../payo/modules/factory/src/review.ts#L52)).
- The workspace already includes `apps/*`; `check` runs Biome, TypeScript and Vitest, but the root TypeScript configuration includes only `.ts` and Node types ([package.json:10](../../payo/package.json#L10), [tsconfig.json:14](../../payo/tsconfig.json#L14)).

## Design Decisions

- Use Vite on `127.0.0.1:5173` with strict port selection and an explicit `PAYO_WEB_ORIGINS=http://127.0.0.1:5173` server setting. The browser calls `http://127.0.0.1:7331` directly; the token stays in React memory and is sent only in Authorization headers. Reloading requires re-entry.
- Extend the run summary with a nullable work-item display identity derived from the cached factory checkpoint, falling back to the run ID until resolved. Avoid exposing the prompt or inventing a title before resolution. Existing CLI output remains compatible.
- Add a factory-owned read function on the existing handle, exposed through composition and a run-scoped endpoint. Return typed, explicitly available/unavailable plan and review data; never accept a path from the browser. At an approval or escalation gate read the checked working file, otherwise use the latest validated plan snapshot. Missing or unsafe working files are unavailable, not silently presented as current; show the safe run-specific path only when available. The existing CLI `payo edit <run-id>` is the preferred editor instruction.
- Use the server's gates for commands. An answer is available for known questions at Approval or Escalated; approval and request-changes require the corresponding gate command, and resume requires its gate command. Approval copy says it ends the current run.
- Treat the event sequence as the cursor. Load history, then stream from the next sequence; deduplicate replay and coalesce event-driven summary and review refreshes. Also refresh on reconnects, focus and commands. Stop reconnecting for an ended run; abort old streams on run change or unmount. Server responses remain authoritative on conflicts.
- Render Markdown with raw HTML disabled and unsafe links rejected; render event and agent text as text. Unknown stages use their server-provided name. Do not synthesize future workflow states.

## Risks & Mitigations

- **Cross-origin errors appear as network failures:** return CORS headers only after validating host and origin, including for authorized-origin errors; test both allowed and hostile origins.
- **External edits or concurrent CLI commands make the view stale:** refetch on focus, before a decision and after conflicts; state clearly that the server decides using the file at command time. A refresh cannot make the later command atomic with a filesystem edit.
- **Artifacts may be missing, unsafe or partially verified:** report unavailable data and unchecked review lenses separately; retain existing artifact checksum and plan-path validation. Never fall back to an old snapshot while claiming it is the working file.
- **Sensitive content and token:** keep the token in memory, prevent raw HTML and dangerous links, and show only data from the selected authenticated run. Do not log tokens.
- **Existing working tree and historical runs:** make summary additions compatible with existing clients and use nullable identity for older or unresolved checkpoints; no data migration. Each PR can be reverted independently without deleting runs.

## Phase 1 — Connection and run list

### Overview

Create the browser foundation and start runs against the existing local server. Make errors readable from the browser before adding workflows.

### Progress

- [x] Preserve validated-origin CORS headers on server failures; keep rejected host/origin responses header-free.
- [x] Add nullable work-item identity and tolerant public stage summaries without exposing prompt descriptions.
- [x] Build the React/Vite/Tailwind web foundation, checks, scripts, dependency lockfile and import boundary.
- [x] Implement in-memory token connection, doctor status, grouped recent runs and Jira/prompt run creation.
- [x] Add server, contract, client and boundary tests; `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- [ ] Manual fake-run walkthrough from both Jira and prompt inputs remains to be performed.

### Changes

- In `payo/apps/server/src/http.ts`, pass validated-origin CORS headers into `respondFailure` for failures after host and origin validation; preserve empty headers for rejected host/origin. Keep headers-sent handling intact.
- In `payo/packages/contracts/src/api.ts`, add nullable `workItem: { source: "jira" | "prompt", title: string, key: string | null }` to `RunSummary`; populate it from `handle.checkpoint.workItem` in `payo/apps/server/src/composition.ts`. Make the public summary's nullable stage a nonblank string so unknown server stages can be displayed; retain the strict factory checkpoint enum. Update summary fixtures and public exports if needed. Use `null` for unresolved items, including old runs.
- Add `payo/apps/web/package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`, and `src/styles.css`; install React, Vite, TanStack Query, Tailwind and the minimum shadcn/ui dependencies and application-owned controls needed for this phase. Set loopback host and strict port. Configure DOM/JSX types and Vite bundler resolution in the web tsconfig; exclude `apps/web` from the root TypeScript project and include both project checks in `payo/package.json`'s `check`. Add `web:build` and `web:dev` scripts. Update `payo/pnpm-lock.yaml`.
- Add a web import restriction in `payo/biome.json` and cases in `payo/test/boundaries.test.ts`: only `@payo/contracts` among Payo packages, no relative cross-package imports.
- Build a token prompt, authenticated doctor status, recent runs grouped by open gate / active / ended, and a New run form for Jira key or prompt with optional absolute repository and base branch. Validate required fields, show server validation and startup errors, and navigate to the returned run URL. No persistence of the token.

### Tests (write first)

- Server integration in `payo/apps/server/src/http.test.ts`: allowed-origin 401, 400 and 409 retain CORS; rejected host/origin never receive it. Verify nullable and resolved work-item summaries without leaking prompt text.
- Client unit/component tests alongside `apps/web/src`: Jira and prompt request bodies, optional overrides, required input, 401 versus network failure, empty list and start errors. Use Vitest and a DOM test environment with React Testing Library for interactions.
- Boundary fixture tests cover allowed contracts import and rejected factory and relative server imports.

### Success criteria

- **Automated:** `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- **Manual:** Start the server with the documented allowed origin, enter the token from `payo token`, start each fake input type, and verify empty, unavailable and invalid-token states.

### What we're NOT doing

Token persistence, server hosting of built assets, remote access or pagination.

## Phase 2 — Live run workspace

### Overview

Make each run addressable and show server activity without coupling the shell to plan content.

### Progress

- [x] Add run URLs with direct navigation, browser back/forward, recent-run links and a narrow-screen run selector.
- [x] Load validated run summaries and event history; stream authenticated events with UTF-8-safe SSE parsing, sequence ordering/deduplication, resumable cursors, bounded reconnects and cancellation.
- [x] Present run metadata, tolerant stage labels, event activity and expandable attempt/agent text; coalesce summary refreshes across event bursts.
- [x] Add focused parser, stream, routing and component tests; `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- [ ] Manual fake-run walkthrough, run switching and server-interruption recovery remain to be performed.

### Changes

- Add `apps/web/src/RunWorkspace.tsx`, `RunList.tsx`, `StageStrip.tsx`, `ActivityTimeline.tsx` and `stream.ts`; select `/runs/<run-id>` via browser history, support direct navigation/back, and provide a narrow-screen run selector. Show work item, repo, branch, state and connection state.
- Fetch `/events` and consume `/events/stream?fromSeq=<last+1>` with authenticated fetch. Parse chunked SSE including heartbeats and split UTF-8, validate events with public contracts, sort and deduplicate by `seq`, reconnect with bounded backoff while active, and surface disconnect/unauthorized states. Use the CLI parser in `payo/apps/cli/src/client.ts` as behavioral reference; keep the web import boundary intact. Cancel obsolete streams.
- Present known stages with readable labels and retain unknown labels; show event timeline and expandable attempts and available agent event text. Do not imply that arbitrary artifact bytes are retrievable.

### Tests (write first)

- Unit tests for chunk boundaries, heartbeat, ordering, duplicate replay, cursor, abort and ended-run behavior; test unknown stage decoding through the public summary contract and display. Test that a burst of events converges on the latest gate without one refresh per event. Component tests cover direct run selection and reconnect/error status where they add behavior beyond the parser.

### Success criteria

- **Automated:** `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- **Manual:** Watch a fake run, open its URL directly, switch runs, interrupt and restore the server, and confirm activity catches up without duplicates. Check the narrow selector.

### What we're NOT doing

Artifact download, generalized workflow stages, implementation or PR views.

## Phase 3 — Plan review and decisions

### Overview

Expose a constrained read model and use it for the actual approval and escalation flows.

### Progress

- [x] Added the exported `RunReview` contract with availability-discriminated plan/review data, answers, and nullable verifier verdicts.
- [x] Added the factory-owned read model, checksum/schema validation, safe gate-file reads, snapshot fallback outside gates, and unavailable reasons for missing/unsafe/corrupt data.
- [x] Exposed the authenticated run-scoped review endpoint through composition and HTTP response validation.
- [x] Added safe Markdown plan rendering, findings and provenance warnings, answer forms, server-gated actions, focus/command/conflict refresh, and escalation/resume UI.
- [x] Added focused contract, factory, server, API, security, gate, refresh, conflict, keyboard and retry tests; `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- [ ] Manual fake approval, CLI editor/request-changes, escalation/resume and stale-state browser walkthrough remains to be performed.

### Changes

- In `payo/packages/contracts/src/api.ts`, define and export `RunReview` with `plan` as an availability-discriminated object containing current markdown, editor path and structured questions when available; `answers` as a question-ID map; and `review` as an availability-discriminated object containing findings, unchecked lenses and nullable verifier verdicts. Include an unavailable reason suitable for display, without filesystem error details. Validate artifact shapes with existing `PlanVersion`, `Finding` and `VerifiedOutput` schemas. Update `payo/packages/contracts/src/index.ts` exports as needed.
- Add `readRunReview(handle: FactoryHandle): Promise<RunReview>` in `payo/modules/factory/src/read-model.ts` and export it from `index.ts`. Access the existing handle's factory-owned dependencies; load checksum-validated checkpoint references, use `readPlan` for the live gate file, and project only known review artifact kinds (`factory-review-input-v1` and `factory-review-v1`). Handle absent, missing, corrupt and unsafe artifacts explicitly. Do not call `openFactory` for a read because it can perform recovery. Capture a checkpoint snapshot for each projection; document that file edits may race reads.
- Add `review(runId)` to `payo/apps/server/src/composition.ts` and authenticated `GET /api/v1/runs/:runId/review` in `http.ts`, using the existing run lookup and response validation. Never accept an artifact ID or filesystem path from the request.
- Add `apps/web/src/PlanReview.tsx` and `GateActions.tsx`: show plan, findings, unchecked lenses, questions and existing answers together; link to activity and display `payo edit <run-id>` and the returned path. Do not imply findings reviewed the displayed text: identify the reviewed plan when provenance is available, and otherwise label findings as potentially stale or their provenance as unknown, including after external edits or revisions. Safely render Markdown. Submit individual answers and allowed approval, request-changes or resume commands; disable duplicate submissions, explain unanswered questions, show escalation reason and refresh on 409. Refetch when the window regains focus, before decisions and after commands; if the read fails, prevent an approval based on a stale view and offer retry.

### Tests (write first)

- Factory unit tests in `payo/modules/factory/src/read-model.test.ts`: current edited file versus snapshot, answers, both review variants, missing file, unsafe symlink and corrupt or absent artifact; do not hide unsafe paths with snapshot fallback.
- Server integration in `payo/apps/server/src/http.test.ts` and `factory-flow.test.ts`: authentication, run isolation, missing artifacts, current answers, and command conflicts. Retain existing persistence tests for reopened runs.
- Client component tests: unanswered questions and allowed commands, conflict refresh, escalation/resume, unavailable plan, external-edit refetch, review provenance after an edit or revision, and hostile HTML/link content. Test decisions and escaping at the lowest layer that exercises them.

### Success criteria

- **Automated:** `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- **Manual:** Complete a fake approval, answer a question, edit via the CLI in an external editor, refresh the view and request changes; exercise escalation/resume and a stale-state conflict. Confirm approval says it ends the run.

### What we're NOT doing

Browser editing, exposing general filesystem or artifact access, or starting implementation after approval.

## Phase 4 — Validate and refine

### Overview

Exercise the assembled application and document the supported local workflow.

### Progress

- [x] Documented install/dev commands, exact allowed origin, token retrieval, fake Jira/prompt walkthroughs, editor flow, approval behavior, and connection troubleshooting in `docs/payo/usage.md`.
- [x] Audited the assembled controls for keyboard access, focus styles, labels, status/error announcements, unavailable/reconnect states and narrow-layout components; added focused keyboard and retry coverage.
- [x] Compared Payo activity coverage with `tools/swarm-viewer/README.md` and documented the independent Pi swarm data gap without retiring the viewer.
- [x] `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- [ ] Full browser fake-flow, narrow/wide visual check, interruption/recovery, invalid-token and external-editor walkthrough remains. No browser executable or existing browser harness is available, and port `7331` is already occupied; shell/API and component coverage cannot verify the rendered responsive experience.

### Changes

- Update `docs/payo/usage.md` with install/build/dev commands, exact origin setting, token retrieval, fake-run walkthrough, editor flow and connection troubleshooting. Explain approval's current terminal behavior.
- Check keyboard operation, visible focus, screen-reader labels and status announcements, responsive layout, failure and reconnect states. Fix concrete gaps in the existing web components.
- Compare the activity view against `tools/swarm-viewer/README.md`: document that its independent Pi swarm data is outside Payo coverage. Do not retire the viewer.

### Tests (write first)

- Add focused component tests only for accessibility or regression bugs discovered during validation. Add a browser smoke test only if a concrete cross-layer gap warrants a harness; do not duplicate lower-level tests.

### Success criteria

- **Automated:** `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- **Manual:** Run the fake flow end to end; check keyboard-only use, labels and status announcements, narrow and wide layouts, server interruption, token rejection and external edits. Record any remaining reproducible gaps in the PR.

### What we're NOT doing

Retiring swarm-viewer, hosted or multi-user access, chat, or a plugin framework.

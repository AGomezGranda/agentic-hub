---
date: 2026-11-01
title: Payo live swarms dashboard
status: draft
---

# Payo live swarms dashboard

## Implementation progress

- [x] Phase 1: projection, incremental polling, run-list refresh and automated checks.
- [x] Phase 2: agent cards, accessible details and automated checks.
- [x] Phase 3: assembled flow, documentation and automated checks.
- [ ] Manual walkthroughs on desktop and narrow screens, including buffering and keyboard/focus checks.
- [ ] Six-run resilience exercise and list latency/server-load measurement with representative long histories and many ended runs.

Implementation note: `getRunEvents` keeps the existing third `AbortSignal` argument and accepts `fromSeq` as its fourth argument to preserve callers. Manual checks require a running server and representative run data and have not been performed.

Later UI direction supersedes the multi-run overview: server status and the new-run form have distinct pages, the sidebar lists runs, and each selected run displays its own swarm using its existing event stream. The multi-run polling implementation and its associated manual load exercise are no longer applicable.

## Current State

- Payo starts runs independently and shares an agent concurrency limiter across them ([composition.ts](../../payo/apps/server/src/composition.ts#L135), [composition.ts](../../payo/apps/server/src/composition.ts#L267)). Review lenses can execute concurrently within a run ([review.ts](../../payo/modules/factory/src/review.ts#L27)).
- The web app lists runs, but does not periodically refresh that list, and mounts a workspace for only the selected run ([App.tsx](../../payo/apps/web/src/app/App.tsx#L55), [App.tsx](../../payo/apps/web/src/app/App.tsx#L152)). The workspace already loads events and reconnects its authenticated per-run stream ([useRunActivity.ts](../../payo/apps/web/src/features/run-workspace/useRunActivity.ts#L20)).
- The events API supports reading from a sequence number and a per-run SSE stream ([http.ts](../../payo/apps/server/src/http.ts#L136)). Events describe steps, agent attempts, roles, models, activity and outcomes ([run.ts](../../payo/packages/contracts/src/run.ts#L24), [agent.ts](../../payo/packages/contracts/src/agent.ts#L24)). A step can start before an agent gets a limiter permit, so a started step alone does not prove an agent is running ([agent-step.ts](../../payo/packages/kernel/src/agent-step.ts#L59)).
- Swarm-viewer offers a list, stage columns and an agent details drawer, but reads pi-subagents artifacts rather than Payo events ([README](../../tools/swarm-viewer/README.md), [index.html](../../tools/swarm-viewer/src/adapters/inbound/ui/index.html#L24)).

## Design Decisions

- **Location and visual direction:** Add a live overview to the existing Payo home screen, retaining run creation, connection controls and links to the existing workspace. Favor legible status, parallel agent cards and activity over decorative animation. These are assumptions from the request; validate with the user during draft review and in the manual walkthrough.
- **One swarm per run:** Group attempts by run and step. Show the recorded role, model, outcome and latest activity; do not invent parent-agent relationships or call a step an active agent before its attempt starts. A run waiting at a gate must visibly say it needs attention.
- **Live transport:** Poll the existing run list every 5 seconds and, while the overview is mounted, poll events for each active run every second using `fromSeq`. Load each active run's full history once, then incrementally request events. Use short HTTP requests rather than one long-lived SSE connection per run, avoiding browser per-origin connection limits. Keep the existing workspace SSE unchanged. New runs may take up to 5 seconds to appear. Polling only retrieves persisted activity: the producer buffers up to 32 agent events and may not flush a partial batch until the attempt finishes, so activity can remain delayed for the duration of an attempt. Accept that limitation for this web-only change and validate it during the manual walkthrough; a bounded producer flush would require a separate change.
- **Honest freshness:** Preserve the last successful view on a request failure, label that run's activity as stale, and retry. Show run-list freshness separately: stage, gates, roster and ended status may be stale even while event polls succeed. A 401 is surfaced as an authentication error rather than silently retried. Stop polling on navigation away or disconnect. On a run ending, retry the final incremental event fetch on failure before retaining its last state; list ended runs without repeatedly fetching their histories. If a successful list response omits a previously observed active run, retain it as uncertain and continue polling until it reappears or its events confirm it ended; do not infer removal from absence alone.
- **Data exposure:** Show activity labels and tool names by default; reveal message, result and error text only on an explicit agent-details interaction. Those details are already available in the authenticated workspace; render them as text, never HTML.

## Risks & Mitigations

- Many active runs cause one request per run per second and the first request can return a large history. Avoid overlapping requests for the same run, update incrementally, release state when the dashboard unmounts, and manually check at least six active runs. No specific throughput guarantee is implied; if this becomes costly, design a server-side aggregate feed separately.
- Each run-list refresh also rereads and parses the full event history of every loaded run, including ended runs. Measure list latency and server load with representative long histories and many ended runs; if the cost is unacceptable, adjust the refresh cadence or plan a server-side summary optimization separately.
- A failed request or a run ending between list refreshes can leave outdated cards. Expose stale state, retry from the last contiguous sequence, and fetch the final events when the list first reports an ended run.
- Overly detailed activity can expose sensitive content on a shared screen. Keep text behind explicit selection and retain the existing authentication boundary.

## Phase 1: Live run and agent state

### Overview

Add a working, automatically refreshed overview using existing API endpoints. Keep the selected-run workspace and its current streaming behavior intact.

### Changes

- In `payo/apps/web/src/features/run-workspace/api.ts`, add an optional `fromSeq` argument to `getRunEvents`, preserving existing callers and `AbortSignal` support; encode it as the server's `fromSeq` query parameter.
- Add `payo/apps/web/src/features/run-workspace/swarmState.ts` with a pure projection from ordered `RunEvent[]` to steps and attempts, including role, model, last activity, finish outcome and timestamps. Distinguish steps without an attempt from running attempts, and handle retries as separate attempts. Do not infer queue position or percentage complete.
- Add `payo/apps/web/src/features/run-workspace/useLiveSwarms.ts` to maintain a separate `EventLog` and polling lifecycle per active run using `getRunEvents`. Seed from full history, then read from `cursor + 1`; prevent overlapping polls, deduplicate events, abort requests on cleanup, and retain completed runs' final projection until unmount. When run-list data reports an end, retry the final incremental fetch until it succeeds before stopping that run's polling. Retain an active run omitted from a successful list response as uncertain, polling its events until it reappears or `run.ended` is observed. Report loading, live, stale and unauthorized states separately.
- In `payo/apps/web/src/app/App.tsx`, configure the existing run list query to refresh every 5 seconds while connected and mount a basic `LiveSwarms` overview on the home screen. Add `payo/apps/web/src/features/run-workspace/LiveSwarms.tsx` to display each active or recently ended run, its gate/stage and projected agent statuses, with links through the existing `navigateToRun`. Keep the existing new-run form and doctor card accessible.
- Keep the overview within `run-workspace`, whose existing dependency on `runs` matches the documented feature boundaries. Do not introduce a new server endpoint or dependency.

### Tests — write before implementation

- **Unit:** Add `swarmState.test.ts` for concurrent attempts, separate retries, failed and finished attempts, latest activity, and a started step without an attempt. Include empty and duplicate event input.
- **Web integration:** Add `LiveSwarms.test.tsx` using the existing fetch mocks and fake timers. Verify two active runs update independently, incremental `fromSeq` reads avoid duplicate events, no requests overlap for a run, an externally created run appears after list refresh, an ended run receives its final events after a failed final fetch and retry, and unmount aborts in-flight requests. Cover stale recovery and 401 feedback. Verify a failed list refresh marks summary data stale even when event polls succeed, and that an omitted active run remains uncertain and recovers when it reappears or ends.
- **Unit:** Extend `api.test.ts` beside the run-workspace API to verify `fromSeq` is encoded and omitted for existing callers. If that file does not yet exist, create it using the existing shared API mock pattern.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`, `pnpm -C payo exec vitest run test/web-boundaries.test.ts test/boundaries.test.ts`, and `pnpm -C payo web:build` pass.
- **Manual:** With two active runs, observe both update without selecting them; start a third from another client and see it appear within one list refresh. Exercise an attempt that emits fewer than 32 nonterminal events before finishing, observe the buffering delay and confirm the interface does not promise that all activity has been received. End a run and confirm its final outcome is visible. Navigate to a run and back, and confirm the existing workspace and run creation still work.

## Phase 2: Agent-focused swarm interface

### Overview

Turn the functional overview into a clear, inspectable swarm view inspired by the viewer's cards and details, using Payo's actual run and step data.

### Changes

- Expand `LiveSwarms.tsx` with a visually distinct card per run and compact agent cards grouped by step. Show role, model when known, running or recorded outcome, last activity and elapsed time based on event timestamps; show gate attention and loading/stale/authentication states as text as well as color. Use Payo stage names from the run summary rather than inferring stages from timing.
- Add `payo/apps/web/src/features/run-workspace/SwarmAgentDetails.tsx` for keyboard-accessible agent selection and a details panel showing that attempt's chronological activity and recorded message/result/error text. Keep selection stable while new events arrive, and provide a close control and an explicit link to the existing run workspace for gates and full history.
- Add only the styles needed in `payo/apps/web/src/app/styles.css` and reuse existing theme tokens and controls. Reflow cards and details for narrow screens and respect reduced-motion preferences.

### Tests — write before implementation

- **Web component:** Extend `LiveSwarms.test.tsx` to verify parallel agent cards, stage and gate labels, textual status and stale indicators, empty runs, and navigation to a run.
- **Web component:** Add `SwarmAgentDetails.test.tsx` for keyboard selection and close, selection surviving an activity update, and rendering untrusted agent text literally. Check that activity text is not displayed in the overview before selection.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web` and `pnpm -C payo web:build` pass.
- **Manual:** On desktop and a narrow viewport, inspect two parallel agents in one run and agents in another; confirm statuses and activity update, details open and close by keyboard, and gate links reach the existing workspace. Check readable contrast, focus visibility and reduced-motion behavior.

## Phase 3: Resilience and rollout verification

### Overview

Exercise the complete overview under connection changes and multiple simultaneous runs, then adjust only issues demonstrated by those checks.

### Changes

- Extend `payo/apps/web/src/app/App.test.tsx` with one assembled flow covering connection, the live overview, opening a run and returning home. Reuse the existing mocked server responses.
- Update `payo/apps/web/README.md` to describe the overview, its refresh intervals, separate summary and activity freshness, and the producer's partial-batch activity delay. Document that agent details can contain recorded output.
- If verification reveals a defect, fix it in `useLiveSwarms.ts`, `swarmState.ts` or the relevant component and add a focused regression test at the lowest useful level. No server or persisted-event migration is planned; rollback consists of reverting the web changes.

### Tests — write before implementation

- **Web integration:** In `App.test.tsx`, verify the assembled connection-to-overview-to-workspace flow and that leaving the overview stops its polling. Do not duplicate the reconnect and projection cases already covered in Phase 1.

### Success criteria

- **Automated:** `pnpm -C payo check` and `pnpm -C payo web:build` pass.
- **Manual:** Run at least six concurrent active runs, verify the page remains usable and run updates continue, temporarily stop and restart the server to check stale/recovery behavior, and confirm disconnect stops requests. Measure list-refresh latency and server load with representative long histories and many ended runs, and record the dataset and observed limits. If unacceptable, adjust cadence or plan a separate server-side summary optimization rather than claiming a performance guarantee.

## What we're NOT doing

- Reusing pi-subagents artifact formats, modifying swarm-viewer, displaying other systems' swarms, or building an animated agent graph.
- Adding agent hierarchy, queue position, progress percentages, tool arguments or new instrumentation that existing Payo events do not provide.
- Adding a server-wide stream, new dependencies, run-control actions to the overview, or changes to persisted events.

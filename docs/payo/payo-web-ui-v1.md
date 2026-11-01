---
date: 2026-10-31
title: Payo web UI direction
status: draft
---

# Payo web UI direction

## Current state

- The agreed design calls for a local Vite + React SPA, TanStack Query, and HTTP/SSE; plans remain editable in the user's editor ([engine design](../../docs/payo/engine-design.md)).
- The current factory resolves a Jira ticket or prompt, creates and reviews a plan, and ends the run on approval. An escalation requires an explicit resume ([usage](../../docs/payo/usage.md)).
- The server exposes run summaries, events, a resumable event stream and gate commands, but not plan content, structured questions or review artifacts for the UI ([HTTP routes](../../payo/apps/server/src/http.ts), [factory contracts](../../payo/packages/contracts/src/factory.ts)).
- The roadmap anticipates implementation, checks, implementation review and PRs per plan, followed by human PR review ([roadmap](../../docs/payo/implementation-roadmap.md)). Those capabilities do not exist yet.

## Product direction

Make the application a run-centered workspace. Its job is to show what Payo is doing, what it produced and what the user needs to decide. A recent-runs sidebar groups items into Needs you, Running and Completed; a New run action starts from Jira or a prompt, with optional repository and base branch overrides.

The run workspace has a header with its work item, repository, state and connection status; a stage strip; and a main area for the current deliverable and available actions. Plan, findings and activity are accessible from the same run. Show attempt details and logs on demand, not as the main view. The selected run remains addressable by URL. On narrow screens the sidebar collapses to a run selector.

At an approval gate, show the plan, review findings and unanswered questions together. Answers can be submitted in the UI; users edit the plan in their own editor, using the displayed path and instructions. Offer approval and request-changes when the gate allows them; explain unanswered questions and report conflicts if the state has changed. An escalated run shows its reason and resume action. The backend remains authoritative for all commands.

## Design decisions

- **Component-driven design.** Build screens from small, reusable components with clear responsibilities: common controls, run-level presentation and workflow-specific content. Compose them into screens; keep API calls and command handling at the screen or feature boundary so presentational components remain easy to understand and reuse. Add shared components when there is a real repeated need, not a speculative framework.
- **Styling and component foundations.** Use Tailwind CSS for layout and styling, and add shadcn/ui components as needed for common controls such as buttons, forms, dialogs, tabs and menus. Keep their source in `apps/web` and maintain it as application code. Use shared CSS variables for colors, borders and status colors. Test keyboard and assistive-technology behavior in the assembled UI.
- **Extend by composition.** Keep the run shell, stage display, activity timeline and gate presentation independent of factory-specific plan content. When implementation and PR views exist, add focused components within the same workspace and connect them to the server's contracts. Avoid a UI plugin system or generalized workflow framework until another workflow requires one.
- **Prepare for implementation without building it now.** Organize the workspace around the run, its stages, deliverables, attempts and gates, rather than around a fixed four-step approval wizard. Stage labels and actions come from server state; unknown future stages remain visible with a readable fallback. Do not create implementation or PR states in the client before the server supports them.
- **Leave room for a per-PR work view.** When implementation arrives, the same run workspace can add a plan/PR strategy list, selected PR progress, checks, findings and eventual PR links. The plan and run activity remain accessible. The existing roadmap's gate and ordering rules stay server-owned.
- **Be honest about approval.** Today approval ends the run; the UI must say so and must not imply that coding starts. When implementation changes this behavior, update the server contract and UI together and distinguish historical approval-only runs from runs that continue.
- **Use existing boundaries.** `apps/web` consumes public contracts and the server API. Add narrowly scoped authenticated read models for the current plan, question/answer state and findings; do not expose arbitrary filesystem paths or make the browser reconstruct factory state from internal artifacts.
- **Local connection.** Follow the existing loopback, bearer token and origin policy. Use a token prompt with session-memory storage and authenticated fetch-based SSE; never put the token in a URL. Present disconnect, reconnect and unauthorized states clearly.
- **Server owns truth.** Reconnect from the last processed event sequence, avoid duplicate entries, and refresh the summary after reconnects and command conflicts. Render agent and plan content safely as untrusted text/Markdown.

## Proposed phases

### 1. Connection and run list

Create `payo/apps/web` using React, Vite, Tailwind CSS and the existing workspace conventions. Add the needed shadcn/ui controls and shared CSS variables; compose them into a token prompt, server/doctor status, recent runs and a new-run form. Handle server unavailable, invalid token, empty list and start errors. Add a workspace check/build command and include the app in TypeScript and Biome checks.

Verify with focused client tests for Jira/prompt submission and connection errors, and manually start a fake run from each input. Run `pnpm -C payo check` and the new web build command.

### 2. Live run workspace

Add run routing and compose the workspace from a run shell, summary, stage strip, event timeline and expandable attempts/logs. Connect to the existing event history and stream; use event sequence numbers for reconnect and deduplication. Keep these components independent of plan-specific content, and keep stage rendering tolerant of new stage names.

Test event ordering, duplicate replay, reconnect and unknown-stage rendering at the cheapest useful level. Manually interrupt and restore the server connection while watching a fake run. Run `pnpm -C payo check` and the web build.

### 3. Plan review and decisions

Extend `payo/packages/contracts/src/api.ts` and `payo/apps/server/src/http.ts` with a run-scoped read model backed by factory-owned state for the latest plan, open questions/answers and available review findings. Provide an explicit unavailable state when an artifact is absent. Add the plan, findings, answers and gate controls to the web workspace. Preserve editor-based plan changes and refresh the plan view after external edits or commands.

Add server integration tests for authorized run-scoped reads, missing artifacts and current answers; add focused client tests for unanswered questions, action conflicts and escaped content. Manually complete the fake approval flow and an escalation/resume flow. Run `pnpm -C payo check` and the web build.

### 4. Validate and refine

Exercise the full fake workflow, keyboard navigation, narrow layouts and connection failures. Compare the Payo activity view with `tools/swarm-viewer` before any retirement decision: the viewer also reads independent Pi swarm data, so Payo run coverage alone does not establish replacement. Document how to launch and use the UI in `docs/payo/usage.md`.

Run `pnpm -C payo check` and the web build; manually verify the flows above and record any gaps. A browser end-to-end smoke test is appropriate only if the implementation introduces a suitable existing test harness or a concrete integration gap warrants one.

## Risks and mitigations

- **Premature future abstractions:** compose the current UI from focused components, but extract shared components only for demonstrated reuse; add per-PR UI and contracts only with the implementation workflow.
- **Stale state across CLI and web:** treat API conflicts as authoritative, refresh after commands and reconnects, and make live status visible.
- **Sensitive local data:** authenticate reads, constrain them to the selected run and render content safely. The token is a secret; prompt and agent output may contain sensitive text.
- **Plan edited outside the browser:** refresh on return to the run and before decisions; the server remains responsible for reading and snapshotting the current file.

## What we're not doing

Browser plan editing, implementation agents, checks, GitHub/PR actions, chat, hosted or multi-user access, and a general plugin framework. No claim that approval starts implementation until the backend actually supports it.

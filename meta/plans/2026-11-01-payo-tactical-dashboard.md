---
date: 2026-11-01
title: Payo tactical dashboard and design system
status: draft
---

# Payo tactical dashboard and design system

## Current State

- [App.tsx](../../payo/apps/web/src/app/App.tsx#L36) owns the in-memory token, server connection, run list, run creation and history-based navigation. It composes the selected run with a sidebar or displays the connection and creation views.
- [styles.css](../../payo/apps/web/src/app/styles.css#L3) defines a small light palette, while individual components use additional literal colors. [Button.tsx](../../payo/apps/web/src/shared/ui/Button.tsx#L10) provides the existing shared button variants and focus treatment.
- [RunWorkspace.tsx](../../payo/apps/web/src/features/run-workspace/RunWorkspace.tsx#L17) displays the current run, connection, stage, plan review and activity. [useRunActivity.ts](../../payo/apps/web/src/features/run-workspace/useRunActivity.ts#L20) already loads history and streams updates, with reconnection and authorization states.
- [RunList.tsx](../../payo/apps/web/src/features/runs/RunList.tsx#L19) groups runs needing attention, active runs and ended runs. [ActivityTimeline.tsx](../../payo/apps/web/src/features/run-workspace/ActivityTimeline.tsx#L17) presents chronological events and expandable agent attempts. [StageStrip.tsx](../../payo/apps/web/src/features/run-workspace/StageStrip.tsx#L12) preserves unknown stage names.
- [PlanReview.tsx](../../payo/apps/web/src/features/plan-review/PlanReview.tsx#L108) refreshes before decisions, enforces current gate and question state, and warns about unknown review provenance. These behaviours must survive any visual rearrangement.
- The web app has colocated component and flow tests, and enforced feature boundaries ([README.md](../../payo/apps/web/README.md#L30)). The previous plan records its full browser and responsive walkthrough as unfinished ([prior plan](2026-10-31-payo-web-ui-v1.md#phase-4--validate-and-refine)).

## Design Decisions

- **Direction:** a restrained control room, with a dark neutral canvas, layered surfaces, crisp borders, compact but readable typography, and limited accent colors for state. Validate the palette and density in a browser during phase 1; adjust tokens before carrying them across screens. This is an assumption until the user reviews the result.
- **Scope:** redesign the whole existing web app, with the run workspace as the main operational view. Keep the existing server contracts and navigation. Validate the priority against a fake run walkthrough before phase 3.
- **Dynamic means useful live information:** give existing stage, connection, gate and event data a clearer hierarchy; use expandable attempt details and a user-controlled activity filter. Do not invent progress percentages, agent states, or metrics absent from the API. Updates must not move keyboard focus or hide actionable information.
- **System, not a component library:** extend CSS tokens and the existing button, adding a shared primitive only when it removes repeated feature-independent UI. Tailwind and Lucide are already installed. Keep feature ownership and import boundaries intact.
- **Accessibility:** status is expressed in text as well as color; preserve semantic links, labels, announcements, focus indicators and keyboard operation. Respect reduced-motion preferences and keep narrow screens usable.

## Risks & Mitigations

- **A dense dark interface hurts legibility:** check text and status contrast, focus indicators, long content and mobile layouts; tune the tokens and spacing before broad rollout.
- **Live updates obscure decisions or steal attention:** retain visible connection and gate state, avoid automatic scrolling and focus changes, and offer an unfiltered activity view.
- **Rearrangement weakens approval safeguards:** keep the existing refresh-before-command logic, warnings, disabled states and error handling; run the existing review and assembled-flow tests.
- **UI suggests unavailable facts:** derive every label and count from existing run or event data; show unknown and unavailable states explicitly.
- **Browser validation requires a local server:** use the documented fake-run setup and record any blocked manual checks; do not treat component tests as visual verification.

## Direction update (user approved)

Use the operations desk for home and a run-focused workspace, with sharp corners, selectable run views, compact density, and a configurable activity panel. The prior dark rounded direction was rejected. Preferences are session-only. Keep decision warnings and actions available in the default view. The user subsequently requested a left-edge work sidebar and integrated sections instead of floating panels.

## Implementation progress

- [x] Implement the foundations, dashboard, run views, filtering, and decision styling; retain the existing review and stream safeguards.
- [x] Run `pnpm -C payo check` and `pnpm -C payo web:build` after the sidebar changes (505 tests passed, one skipped; build passed).
- [ ] Complete the browser walkthrough. On the latest attempt the browser access host was unavailable; an isolated fake server could not start because port 7331 was already in use. The existing server was left untouched.

- [ ] Phase 1 — Sharp, light operations direction implemented and approved conceptually. Web tests and build pass; browser host unavailable, so desktop/320px, token, focus and contrast checks remain open.
- [ ] Phase 2 — Dashboard layout, loaded group counts and session-only compact density implemented. Fake-run and responsive walkthrough remains open. The home view does not invent a cross-run activity stream; live activity belongs to the selected run.
- [ ] Phase 3 — Split, decision and activity views plus activity filtering implemented and covered by tests. Stream lifecycle remains unchanged. Manual recovery and responsive checks remain open.
- [ ] Phase 4 — Review and gate surfaces restyled, with existing decision safeguards retained and tested. Manual decision scenarios remain open.
- [ ] Phase 5 — Usage guide updated; full `payo check` and web build pass. Browser host unavailable, so fake flow, keyboard, responsive, contrast, reduced-motion and external-edit walkthroughs remain unverified.


## Phase 1 — Visual direction and foundations

### Overview

Establish the control-room visual language on the shell and connection entry point before applying it to every screen.

### Changes

- In `payo/apps/web/src/app/styles.css`, define semantic canvas, surface, border, text, accent and status tokens, plus consistent selection and reduced-motion treatment. Use system fonts already available; no remote font dependency.
- Update `payo/apps/web/src/shared/ui/Button.tsx` to use the tokens for all existing variants, including visible keyboard focus, hover and disabled states.
- Update the header, page frame, invalid-route and connection-error styling in `payo/apps/web/src/app/App.tsx`, and the token entry in `payo/apps/web/src/features/connection/TokenPrompt.tsx`. Preserve in-memory token handling and existing navigation.
- Inspect the result in the browser at wide and narrow widths and adjust the palette and density before phase 2.

### Tests (write first)

- Retain `payo/apps/web/src/app/App.test.tsx` connection, navigation and disconnect coverage. Add a component test only if the shell or token interaction changes; a color-only change does not need one.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`, `pnpm -C payo web:build`.
- **Manual:** Check token entry, invalid token, keyboard focus, contrast and the shell at 320px and desktop widths. Review the direction with the user before applying it broadly.

### What we're NOT doing

Theme switching, custom fonts, a new UI library, or changes to token persistence.

## Phase 2 — Dashboard and navigation

### Overview

Make the home screen a compact operational overview with clear access to work requiring attention and to run creation.

### Changes

- In `payo/apps/web/src/app/App.tsx`, restructure the connected home layout so connection health, grouped runs and new-run creation have distinct visual hierarchy; keep the existing selected-run route and mobile selection.
- Restyle `payo/apps/web/src/features/connection/DoctorCard.tsx`, `payo/apps/web/src/features/runs/RunList.tsx`, and `payo/apps/web/src/features/runs/NewRunForm.tsx` with the shared tokens. Show group counts from the existing groups and keep the current run links, selected state, empty and loading states, and all form validation.
- Keep counts scoped to the loaded list and label them accordingly; do not claim historical totals beyond the returned data.

### Tests (write first)

- Update `payo/apps/web/src/features/runs/RunList.test.tsx` to cover group counts, an empty group, and the selected run if the displayed grouping changes. Retain assembled creation and navigation tests in `payo/apps/web/src/app/App.test.tsx`.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`, `pnpm -C payo web:build`.
- **Manual:** Connect, inspect empty and populated lists, create Jira and prompt runs, navigate back and forward, and select a run on a narrow screen.

### What we're NOT doing

New endpoints, pagination, cross-run analytics, or persistent dashboard preferences.

## Phase 3 — Live run workspace

### Overview

Put the run's current state and live activity in a compact, readable workspace without changing streaming semantics.

### Changes

- In `payo/apps/web/src/features/run-workspace/RunWorkspace.tsx` and `StageStrip.tsx`, reorganize the title, repository, branch, current stage, run status and connection status into a clear operational header. Preserve unknown stages and all loading, reconnecting, unauthorized and ended labels.
- In `payo/apps/web/src/features/run-workspace/ActivityTimeline.tsx`, use a compact timeline with expandable attempts and a labeled filter for all events versus agent attempts. Default to all events, preserve sequence order and existing event text, and show an explicit empty-filter state. Do not auto-scroll or change focus as new events arrive.
- Keep `payo/apps/web/src/features/run-workspace/useRunActivity.ts` and `stream.ts` responsible for the existing stream lifecycle; presentation changes must not alter deduplication, refresh, retries or cancellation.

### Tests (write first)

- Extend `payo/apps/web/src/features/run-workspace/ActivityTimeline.test.tsx` with filter switching, an empty filtered result, and a new event arriving while filtered; verify switching back reveals all events in order. Retain `RunWorkspace.test.tsx`, `StageStrip.test.tsx` and stream tests for reconnection, errors and unknown stages.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`, `pnpm -C payo web:build`.
- **Manual:** Watch a fake run, expand an attempt, filter activity while updates arrive, switch runs, interrupt and restore the server, and verify the view remains usable at narrow widths.

### What we're NOT doing

Synthetic progress, charts, event virtualization, new agent telemetry or artifact downloads.

## Phase 4 — Review and decisions

### Overview

Apply the visual system to the plan and decision workflow while keeping the server-authoritative safeguards prominent.

### Changes

- Restyle and organize `payo/apps/web/src/features/plan-review/PlanReview.tsx` and `GateActions.tsx` so the plan, review findings, questions and allowed actions have clear hierarchy. Keep the provenance warning, unavailable states, editor guidance, conflict recovery, answer state and terminal approval copy visible in their relevant contexts.
- Preserve Markdown sanitization, pre-command refresh and gate validation; do not move decisions into client-only state or hide a warning behind a collapsed section.

### Tests (write first)

- Retain `payo/apps/web/src/features/plan-review/PlanReview.test.tsx` coverage for review, command, conflict and unsafe content. If rearrangement changes interactions, add a focused test that a warning remains visible and that an unavailable or stale review cannot be approved.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`, `pnpm -C payo web:build`.
- **Manual:** Exercise a fake approval, answer a question, use the external editor, request changes, and check escalation, conflict and unavailable-review states using keyboard and pointer.

### What we're NOT doing

Browser plan editing, changes to approval semantics, or new review data.

## Phase 5 — Validation and refinement

### Overview

Verify the assembled experience and document the supported operational workflow.

### Changes

- Walk through the documented fake run in `docs/payo/usage.md`, including connection recovery and decision flows; update its UI descriptions if the redesign changes them.
- Resolve concrete responsive, contrast, focus, reduced-motion, long-content and state-announcement issues in the affected web components. Check that the screen works at 320px and common desktop widths without obscured controls or horizontal page overflow.
- Record any unverified manual scenarios in the implementation PR. Add no browser test harness unless a specific cross-layer failure cannot be covered more cheaply.

### Tests (write first)

- Add focused colocated tests only for interaction or accessibility regressions discovered during the walkthrough; use existing web test infrastructure.

### Success criteria

- **Automated:** `pnpm -C payo check`, `pnpm -C payo web:build`.
- **Manual:** Complete the fake flow from connection through a decision; verify keyboard-only navigation, focus, contrast, reduced motion, responsive layouts, invalid token, interruption/recovery and external edits.

### What we're NOT doing

Hosted or multi-user access, a general analytics platform, or unrelated backend changes.

## PR Strategy

1. **Foundations and dashboard:** phases 1–2, after the visual direction is reviewed. This establishes the system and a usable home screen.
2. **Live workspace:** phase 3, building on the shared tokens; independently reviewable and revertible.
3. **Review and validation:** phases 4–5, preserving decision safeguards and completing the end-to-end visual walkthrough. Each PR retains existing API compatibility and can be reverted without migrating run data.

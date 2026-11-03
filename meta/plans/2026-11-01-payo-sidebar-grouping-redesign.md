---
date: 2026-11-01
title: Payo sidebar grouping and information redesign
status: draft
---

# Payo sidebar grouping and information redesign

## Implementation Progress

- [x] Phase 1 — User-selectable run grouping (web tests and build pass).
- [x] Phase 2 — Information-rich sidebar redesign (project checks and web build pass).
- [ ] Manual browser review at 320px and desktop widths; not performed in this implementation run.

## Current State

- `payo/apps/web/src/app/App.tsx:37-74` owns the in-memory connection token and polls `GET /runs` every five seconds. `App.tsx:128-182` composes the main navigation and `RunList` in a 18rem-wide desktop sidebar.
- `payo/apps/web/src/features/runs/RunList.tsx:10-25` renders fixed “Needs you,” “Active,” and “Ended” groups. Its rows already show the work-item title, identifier, repository, stage, and base branch (`RunList.tsx:91-138`), but do not show an individual run's status or open-gate count.
- The narrow-screen “Select run” control is shown alongside the run groups when a run is selected (`RunList.tsx:39-58`); the current implementation does not hide the groups on narrow screens.
- `payo/packages/contracts/src/api.ts:79-97` includes `repo`, `baseBranch`, `status`, `outcome`, `stage`, work-item details, timestamps, and `openGates` in each `RunSummary`. `payo/apps/server/src/http.ts:94-98` returns those summaries from the existing authenticated `GET /runs` route. Repository grouping and sidebar counts can therefore be computed in the browser without changing server routes or contracts.
- `payo/apps/web/src/features/runs/RunList.test.tsx` covers the current status-group counts, link selection, and narrow-screen selector. `payo/apps/web/src/app/App.test.tsx` covers assembled navigation and run-list flows. The latest visual direction recorded in `meta/plans/2026-11-01-payo-tactical-dashboard.md` is a sharp, light operations desk with a left-edge work sidebar.

## Design Decisions

- Offer mutually exclusive **Status** and **Repository** grouping modes in an accessible, visibly selected control. Status remains the default. Keep the choice in component memory only; it survives navigation while the connected app remains mounted, and resets on reload or disconnect.
- Group repository runs by the exact `RunSummary.repo` string, not by a directory basename, so separate checkouts with the same name never merge. Sort repository group headings lexically; preserve the server's run order within each group. Keep the existing status-group order and semantics, including empty status groups.
- Keep grouping and summary calculations in the web feature. Do not add a server endpoint or contract field for information the current run summary already supplies.
- Continue the existing light, sharp-cornered visual direction and use the CSS variables already defined in `payo/apps/web/src/app/styles.css`. Do not add a component library or styling dependency.
- Treat all sidebar counts as counts from the currently loaded run list; do not imply they are lifetime totals or global analytics.

## Risks & Mitigations

- **Different repositories have similar names:** use the full repository path as the group identity and visible heading, and test two paths with the same final directory name.
- **The denser sidebar becomes hard to scan or use on small screens:** prioritize title, actionable state, and stage; retain wrapping/truncation rules for long text, keyboard-visible focus, the selected-run selector, and the existing navigation. Verify at 320px and desktop widths.
- **Repository groups obscure action state:** keep each row's status and open-gate count visible in either grouping mode; do not rely on the current group heading or color alone to convey that a run needs attention.
- **Counts appear more complete than the API guarantees:** label the total as loaded runs and keep each group count scoped to that list.
- **Sidebar redesign breaks run navigation:** retain the existing run URLs, selected-link semantics, and browser-history behavior; cover grouping and assembled navigation separately.

## Phase 1 — User-selectable run grouping

### Overview

Let users switch between the existing status grouping and a repository grouping. Keep the selected mode local to the mounted sidebar and preserve the current selected run while regrouping.

### Changes

- In `payo/apps/web/src/features/runs/RunList.tsx`, add a `"status" | "repository"` grouping mode held in component state and defaulted to `"status"`. Render a labelled native radio group with “Status” and “Repository” options so the mode works with keyboard and assistive technology.
- In `RunList.tsx`, build the status groups in the existing order (“Needs you,” “Active,” “Ended”) and retain their current predicates. For repository mode, group by the exact `repo` value, sort group headings by `repo.localeCompare`, and preserve each group's input order. Render each group's item count; show full repository paths in repository headings so same-named checkouts remain distinguishable. Show the existing no-runs message rather than empty repository groups when the list is empty.
- Keep `RunList`'s public props and `payo/apps/web/src/app/App.tsx`'s API/query behavior unchanged. Regrouping must not trigger a request, navigate, or change `selectedRunId`.
- Extend fixtures and tests in `payo/apps/web/src/features/runs/RunList.test.tsx` to support distinct repositories, ended runs, and open gates.

### Tests (write first)

- **Component tests** in `RunList.test.tsx`: preserve the existing status-group order and counts, including zero-count groups; choose Repository and verify exact-path grouping, lexical heading order, per-group counts, and original run order within a group; verify two different paths ending in the same directory remain separate groups.
- **Component interaction test** in `RunList.test.tsx`: switch Status → Repository → Status with a run selected and verify its link remains selected, the mode's groups update, and the narrow-screen selector still selects the same run. Verify regrouping does not call `onSelect` by itself.
- **Empty-list edge case** in `RunList.test.tsx`: both modes retain the no-runs message and do not render empty repository groups.

### Success criteria

- **Automated:** `pnpm -C payo exec vitest run --project web`; `pnpm -C payo web:build`.
- **Manual:** With zero, one, and multiple repositories loaded, switch grouping by mouse and keyboard. Confirm same-named repository folders remain distinguishable, counts update, and regrouping neither changes the URL nor selects a different run.

### What we're NOT doing

Server/API or contract changes, a repository picker, persistent grouping preferences, filtering, sorting controls, collapsible groups, pagination, or new status categories.

## Phase 2 — Information-rich sidebar redesign

### Overview

Make the left sidebar easier to scan as an operational run navigator, using only the run data already returned by the API. Preserve run actions and navigation while making attention state legible in both grouping modes.

### Changes

- In `payo/apps/web/src/app/App.tsx`, refine the `<aside>` and navigation section into a distinct left rail with clear section hierarchy and spacing. Widen the desktop rail from `lg:w-72` to `lg:w-80`; retain the existing `aria-label="Your work"`, navigation links, selected-page state, and narrow-screen stacked layout.
- In `payo/apps/web/src/features/runs/RunList.tsx`, retain and restyle the existing loaded-run count, then add summary counts for “Needs you” (`openGates.length > 0`) and “Active” (`status === "active"` and no open gates), using the same predicates as the status groups. Keep group counts visible and explicitly label the total as loaded data.
- Redesign each run row around a scan order of work-item title and identifier, actionable status, current stage, and base branch. Derive the status text from existing fields: “Needs you” when `openGates` is nonempty, “Active” for other active runs, and “Ended” for ended runs. Include the exact open-gate count when nonzero. Keep the repository path visible on rows in Status mode; in Repository mode, the group heading supplies that context and the path need not be repeated for every row. Keep status text visible in both modes, not just through color.
- Use existing theme variables and Tailwind utilities for the new hierarchy, selected-run treatment, status indicators, and focus styling. Do not introduce extra metrics or fabricate a progress value from `stage`.
- Keep the existing narrow-screen run selector and run links available. Truncate one-line work-item titles with an ellipsis; wrap full repository group headings at arbitrary path characters, and truncate repository paths shown on Status-mode rows while retaining the full path in the element text and `title` attribute. Prevent horizontal page overflow and retain visible focus indicators for the grouping radios, navigation, selector, and run links.
- Update `payo/apps/web/src/features/runs/RunList.test.tsx` for the summary counts and row metadata. Extend `payo/apps/web/src/app/App.test.tsx` only where needed to assert that the labelled sidebar navigation remains available through assembled page navigation.

### Tests (write first)

- **Component tests** in `RunList.test.tsx`: verify loaded, attention, and active counts against a mixed list; verify an open-gate run shows “Needs you” and its exact gate count in both grouping modes; verify active-without-gates and ended rows show their correct status; verify stage-pending and no-runs states remain readable.
- **Assembled UI test** in `App.test.tsx`: verify the sidebar's labelled main navigation and run links remain available while navigating between New run, Server status, and a selected run. Reuse the existing mock server and navigation tests rather than adding another test harness.
- Retain the existing link/select interaction and group-switch tests from Phase 1. No new server integration test is needed because the response contract and server route are unchanged.

### Success criteria

- **Automated:** `pnpm -C payo check`; `pnpm -C payo web:build`.
- **Manual:** Inspect the connected sidebar at 320px and desktop width with empty, mixed-status, and multi-repository lists. Check scan hierarchy, group control, gate counts, selected state, long paths/titles, keyboard-only navigation, visible focus, and absence of horizontal overflow. Confirm Status remains the initial grouping after reload and that the current mode persists while navigating within a connected session.

### What we're NOT doing

A redesign of the run workspace or header, new API data, repository filesystem discovery, multi-user accounts, user profiles, server-side preferences, or a general dashboard/analytics view.

## Rollback

The change is UI-only and stores no preference or run data. Reverting the web changes restores the current fixed status grouping and sidebar presentation; no server or database migration is required.

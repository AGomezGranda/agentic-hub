---
name: review-implementation
description: Review the current local git diff (uncommitted work) against the plan or plan phase it implements, then run the audit swarm on it. Use after implementing a phase and before committing. Not reviewing the plan itself (review-plan), writing code (implement-plan) or reviewing a repo with no plan (swarm directly).
---

# Review Implementation

## 1. Resolve plan and phase

- Plan: path from the user, else the plan file whose phase matches the diff
  (`find . -type d -iname plans -not -path '*/node_modules/*'`, then the
  branch name). Read it FULLY.
- Phase: from the user, else the first phase with unchecked `- [ ]` items.
- No plan found: say so and run the swarm alone (step 3) with no `plan`.

## 2. Plan conformance (you, not children)

Diff: `git status --short`, `git diff HEAD`, and read untracked files directly
(`git diff` does not show them). Never use `main...HEAD`: it mixes committed
history into a local review.

Map each phase item and success criterion to hunks. Report:
- **Missing**: plan items with no matching change, or only partly done.
- **Extra**: hunks or files the phase does not call for (scope creep).
- **Unverified**: success criteria (tests/lint/build) not run; run them now.
- **Silent deviations**: where the change differs from the plan without a
  note in the plan file.

## 3. Swarm (skip for fewer than 3 files and no new logic)

Pick lenses by what the diff touches (skip `security` for docs/refactors).
`plan-conformance` is already covered by step 2, so leave it out unless you
want an independent second view.

`subagent({ workflow: "./pi/workflows/swarm.js", args: { scope: "uncommitted changes (git diff HEAD plus untracked files)", plan: "<plan path>, phase <N>", lenses: [...], round: 1 }, async: true })`

## 4. Triage and report

Follow the standing orders: classify each verified finding (blocker,
non-blocker, stale, invalid, speculative), fix accepted batches with one
worker per seam, re-run with `round+1` on changed files only, max 3 rounds.

Report: plan/phase reviewed; conformance gaps (missing/extra/unverified/
deviations); lenses run; findings accepted and rejected; rounds; what was
not checked. Tick completed plan items only if the user asks.

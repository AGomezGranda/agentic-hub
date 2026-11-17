---
name: implement-plan
description: Execute an approved implementation plan phase by phase with verification checkpoints. Use when implementing a previously written plan. Not writing the plan (create-plan) or reviewing it before execution (review-plan).
---

# Implement Plan

## Start

- Read the plan FULLY (no offset/limit), including any existing `- [x]`
  checkmarks — completed phases are trusted, resume from the first unchecked
  item.
- Read the files it references and touches. Think about how the pieces fit
  together before editing anything.
- Track phases as a todo list.

## Per phase

Work incrementally, one observable behaviour at a time, with no external
testing skill needed:

1. Select one observable behaviour from the phase.
2. For new or changed behaviour, write a focused test at the cheapest level
   that can catch the bug. Confirm it fails for the intended reason before
   implementing the change. For a behaviour-preserving refactor, run the
   relevant existing checks before editing. If they leave a meaningful
   caller-visible behaviour uncovered, add a focused test for it and
   confirm it passes on the current code.
3. Implement the smallest sufficient change. Wire side-effecting collaborators
   at startup, pass each consumer only what it uses, and call pure helpers
   directly. Keep domain code free of framework/I/O imports, business rules
   out of use cases and adapters, and invariants inside their owner — per the
   governing architecture contract (repo standard, else the
   `architecture-audit` skill's `references/standard.md`). Rerun the test, then the phase's
   full automated success criteria (tests/lint/build from the plan).
4. Refactor while green. Rerun the focused checks after each small
   structural step. Leave touched code
   cleaner than you found it (boy-scout rule): small splits, renames to the
   domain language, extracting a value object or port the change needed.
   A restructure the plan didn't foresee that spans many callers or another
   context is a scope change — record it under the plan's Structural Debt
   and ask, rather than doing it silently. Commit pure moves separately from
   behaviour changes.
5. Repeat for the next behaviour.

Trivial prose/glue changes (a one-line pass-through, a constant, a comment)
don't need ceremonial tests — YAGNI applies to tests too. Reuse the
project's existing runner and helpers; don't stand up a parallel harness.
Test through the appropriate public boundary; use doubles for external
effects. Avoid tests coupled to private structure and redundant
higher-level assertions over behaviour a lower-level test already proves,
while allowing distinct integration contracts to be tested separately.

Report progress as you go and check off completed items in the plan file
itself; don't pause for approval between routine steps.
Pause only for a consequential scope change, a genuinely missing user
choice, or an action requiring fresh authorisation. Handle routine
implementation discoveries autonomously and record them in the plan.

On resume, trust completed plan items (including existing `- [x]`
checkmarks) unless changed code or failed checks give reason to revisit
them. Never replay completed phases automatically.

## When the plan doesn't match reality

Stop and say so rather than improvising silently:
```
Issue in Phase [N]:
Expected: [what the plan says]
Found: [actual situation]
Why this matters: [...]
How should I proceed?
```
The plan is a guide, not scripture — codebases drift since a plan was
written. For trivial mismatches (renamed file, moved import, slightly
different signature): adapt, note the deviation in the plan file, continue.
For substantive mismatches (architecture differs, wrong assumption, scope
impact): stop and ask with the block above instead of diverging silently.

Use subagents sparingly here — mainly for a targeted debugging dive or
exploring one unfamiliar corner, not as the default way of working.

Limit delegation to three subagents total across the entire task, excluding
the parent; scouts and reviewers share those slots. Only the parent delegates,
and every child must be told not to spawn agents. Completed children still count; reuse them for follow-ups where supported,
otherwise finish remaining work in the parent. Preserve all required checks.

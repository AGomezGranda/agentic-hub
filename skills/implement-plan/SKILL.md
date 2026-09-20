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

Work test-first (TDD) whenever the phase has non-trivial logic:

1. Write the phase's tests first, at the level the plan names (favour fast unit
   tests, fewer integration, a thin e2e top). Run them and watch them fail for
   the right reason — a test that passes before you write code tests nothing.
2. Implement the minimum that turns the tests green, then refactor with the
   tests as a safety net.
3. Run the phase's full automated success criteria (tests/lint/build from the
   plan). Fix issues before proceeding.
4. Check off completed items in the plan file itself as you go.
5. Pause at natural stopping points for the user to look over the diff —
   don't batch every phase into one silent pass.

Trivial glue (a one-line pass-through, a constant) doesn't need its own test —
YAGNI applies to tests too. Reuse the project's existing runner and helpers;
don't stand up a parallel harness.

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
written. Use judgment, but surface the mismatch instead of quietly diverging.

Use subagents sparingly here — mainly for a targeted debugging dive or
exploring one unfamiliar corner, not as the default way of working.

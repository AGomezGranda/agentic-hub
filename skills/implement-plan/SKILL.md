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
2. Write one focused test for it first, at the cheapest level that can catch
   the bug (favour fast unit tests, fewer integration, a thin e2e top). Run
   it and confirm it fails for the intended reason — a test that passes
   before you write code tests nothing. A pre-existing passing test stays
   useful as regression coverage, but it never proves a new test exercised
   the missing behaviour.
3. Implement the smallest sufficient change. Rerun the test, then the phase's
   full automated success criteria (tests/lint/build from the plan).
4. Refactor while green, with the tests as a safety net.
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

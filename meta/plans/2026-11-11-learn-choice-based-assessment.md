---
date: 2026-11-11
title: Choice-based assessment for the learn skill
status: draft
---

## Goal

Let the learner demonstrate understanding by choosing among roughly six options,
without requiring them to compose explanations in chat. Preserve adaptive teaching,
spaced review, and honest evidence of what they can do independently.

## Current State

- `skills/learn/SKILL.md:29` diagnoses prerequisites with adaptive questions;
  `:73` prefers explanation and reconstruction without a default answer format.
- `skills/learn/references/teaching.md:47` permits multiple choice but prefers a
  brief justification. Its evidence rules at `:60` require recall or reconstruction
  for Independent and an explanation of limits for Transfer.
- `skills/learn/references/workspace.md:61` already stores preferences; its attempt
  records at `:80` can hold the exact prompt and response without a new file format.
- The local `../agent_skills/socratic-tutor/SKILL.md` emphasizes verbal reasoning
  and independent recall. This is an intentional interaction change that keeps
  its adaptive questioning and evidence principles, rather than strict parity.

## Design Decisions

- Default to one question at a time with about six labeled options, normally five
  substantive choices plus “I don’t know.” Use fewer when six would require filler.
  Accept just the letter or number; do not require a justification afterward.
- Apply this to onboarding too: offer concrete experience descriptions instead of
  asking the learner to describe their knowledge from scratch. Treat self-report
  as placement context, not demonstrated understanding.
- Use predictions, plausible explanations, debugging choices, and unfamiliar
  scenarios. Distractors should expose specific misconceptions. Vary the correct
  answer's position and avoid clues from length or wording.
- When evidence is ambiguous, ask another concrete choice-based question. A wrong
  answer or “I don’t know” prompts focused teaching and a different case, not an
  indefinite guessing loop. Free-text explanations remain optional.
- Separate recognition from independent production. Successful choices are useful
  evidence, but do not alone establish recall, construction, or practical mastery.
  Do not interpret difficulty writing an explanation as conceptual failure.
- For goals requiring independent performance, offer occasional small practical
  tasks, such as repairing code or constructing an example. Demonstrate limits
  through actions or counterexamples where appropriate; prose is not mandatory.
  If the learner skips these, continue teaching and leave those criteria unassessed.
- Keep assessment in chat: present labeled choices in ordinary messages when a
  host's question widget cannot show six. No browser submission controls are needed.

## Phase 1 — Make choice-based assessment the default

### Overview

Update the teaching contract and continuity guidance together so a resumed course
preserves the preferred interaction without overstating mastery.

### Changes

1. `skills/learn/SKILL.md`: update onboarding, diagnosis, and Tutor and assess with
   the choice format, letter-only responses, optional explanations, adaptive
   follow-ups, and practical checks described above. Retain skip/pause controls.
2. `skills/learn/references/teaching.md`: replace the preference for written
   justification with choice-based probes; include one sample six-option question
   and guidance on interpreting a selection. Revise evidence and final-assessment
   wording to accept demonstrable practical work instead of mandatory prose while
   retaining the distinction between recognition and independent production.
3. `skills/learn/references/workspace.md`: document the preference in the existing
   Preferences field. Preserve option labels and text in pending prompts and
   attempt records so a response such as “C” remains interpretable on resume.
   Assessment records state whether evidence demonstrates recognition or production.

### Tests and success criteria

This changes instructions only; use behavioral walkthroughs, not new test code.

Automated inspection:

```sh
git diff --check -- skills/learn
rg -n 'choice|justification|explanation|Independent|Transfer|Preferences|Pending' skills/learn
```

Manually exercise these cases before considering implementation complete:

- New course with no experience description: offer concrete choices and accept a
  single label without requesting prose.
- Correct selection: assess the chosen reasoning and continue adaptively; do not
  award independent construction from recognition alone.
- Wrong selection or “I don’t know”: teach the relevant gap, then use a new case.
- Two plausible interpretations: probe with a concrete scenario, not a mandatory
  “explain why.”
- Skip a practical check: continue and record only the missing evidence, not failure.
- Resume with a pending lettered question: restore its exact choices and preference.
- Practical work demonstrates understanding: credit the observed performance even
  when no written explanation accompanies it.

### Non-goals

No new UI, server, dependencies, mastery score, course migration, or modifications
to the external agent_skills repository. Existing course evidence stays intact.

## Risks & Mitigations

- Guessing or recognition can look like mastery: use varied cases and explicitly
  scope evidence; reserve production claims for observed production.
- Six choices can become burdensome: prioritize meaningful alternatives over a
  rigid count, retaining an uncertainty option.
- Old guidance can force prose again: inspect all three instruction files together,
  including final-assessment and evidence labels, for contradictory requirements.

## PR Strategy

One PR: “Make learn assessments choice-based by default.” Includes
Phase 1 — Make choice-based assessment the default. No dependencies.

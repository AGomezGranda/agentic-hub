# Teaching and evidence

## Calibrate depth

Teach toward the agreed goal, not toward an arbitrary amount of content. Advanced
learning can begin with elementary prerequisites; skipping them is not rigor.
Use the dimensions relevant to the topic and name what remains out of scope:

| Dimension | What the learner should eventually be able to do |
|---|---|
| Mental model | Explain the mechanism and connect representations |
| Reconstruction | Derive a result, trace a process, or justify each step |
| Assumptions | State when a claim holds and when it stops holding |
| Counterexamples | Break a plausible but incorrect generalization |
| Transfer | Solve a structurally related problem with different surface details |
| Judgment | Compare alternatives under concrete constraints and costs |
| Verification | Choose and apply a way to check the result independently |

For programming: trace execution, reason about invariants and failure modes, build
or repair something, test it, and defend design choices. Use runnable examples
where feasible; distinguish a passing example from a general guarantee.

For mathematical topics: define objects, motivate a claim, derive or prove it,
check assumptions, and find a case where relaxing an assumption breaks it.

For practical or creative topics: explain the mechanism, demonstrate a technique,
observe an actual attempt, compare outcomes against explicit criteria, and vary
constraints. Do not infer physical performance from a verbal description alone.

## Design a lesson

Choose one learning outcome and its required prerequisites. A useful sequence:

1. Pose a concrete problem and elicit a prediction if the learner can attempt it.
2. Introduce the model and define its vocabulary in context.
3. Work through a representative example, showing why each step follows.
4. Expose a limit or tempting wrong model with a counterexample.
5. Fade assistance: partial example, independent task, then transfer.
6. Reconnect the result to the mission and identify what to review later.

Use this sequence flexibly. Someone who demonstrates competence can skip the
worked example. Someone meeting new material needs instruction before interrogation.
Short sections should add up to a complete explanation, not a shallow overview.
Expand an unfinished conceptual thread before introducing unrelated new material.

Keep assessment prompts separate from their solutions. A worked teaching example
and an independent task must use different cases. Default to choice-based probes
(see below): make each distractor expose a specific misconception, vary the correct
position, and avoid clues from length or wording. A choice can diagnose a
misconception but cannot by itself establish independent construction or transfer;
offer a practical task when the goal requires production.

## Assess honestly

Ask one question at a time with about six labeled options: five substantive choices
and an "I don't know" option. Use fewer when a sixth would be filler. Accept a bare
letter or number and do not require a justification; a free-text explanation stays
optional. Vary the correct position between questions.

Example:

> A cache holds 100 entries and evicts the least recently used entry. Keys `a`,
> `b`, `c`, `d`, and `e` are read in that order, then `a` is read again. Which key
> is evicted when a new key is inserted?
> A. `a`  B. `b`  C. `c`  D. `d`  E. `e`  F. I don't know

To interpret a selection, check which misconception the chosen distractor exposes.
A correct choice supports recognition; when the same reasoning recurs on a new case,
it can support Developing. It does not by itself establish recall, reconstruction, or
practical mastery. A wrong choice or "I don't know" locates a gap: teach that gap,
then ask a different case rather than repeating the question. When two readings are
plausible, probe with a scenario that distinguishes them.

Track per-concept evidence, using these labels rather than numerical confidence:

| Status | Required evidence |
|---|---|
| Unassessed | No adequate demonstration yet, including material merely read |
| Developing | Partial understanding, recognition without production, or performance with assistance |
| Independent | Two distinct successful checks, at least one requiring unprompted production: recall, reconstruction, or observed practical work |
| Transfer | Independent success on an unfamiliar case plus demonstrated limits, by explanation, action, or counterexample |
| Retained | Successful delayed retrieval and application in a later session |

These labels summarize evidence, not an inevitable ladder. A learner can transfer
today without demonstrating retention yet. Preserve separate evidence and dates;
do not discard transfer evidence when adding a retention result. State the scope
of each claim: a successful exercise in one case does not establish an entire field.

Unprompted recall means no answer, worked solution, or substantive hint immediately
preceded the attempt. Rephrasing the same exercise after revealing its answer is
supported practice. Mark it that way, then test a distinct case later.

When grading a response:

- Identify what is correct and the precise gap, using the learner's own work.
- Separate conceptual error, execution slip, ambiguous wording, and missing evidence.
- Ask another concrete scenario that distinguishes two reasonable interpretations.
- Verify your own expected answer if the learner challenges it or finds a counterexample.
- Record exposed hints and solutions, not just a pass/fail judgment.
- Change a status only when new evidence warrants it; explain a regression concretely.

Example: a learner can trace aliasing immediately after an explanation. Record
supported tracing as Developing. Later, ask them to predict a different mutation
and explain the object graph without hints. A second independent check can support
Independent. A new API design exposing an aliasing bug can test Transfer. Revisit
the mechanism in a later session before claiming Retained.

## Review and completion

Select a small review set at session start: overdue concepts, persistent errors,
and prerequisites of today's work. Use recall before showing the recap's answers.
Initially suggest review next session, then roughly a week later after success;
adapt to evidence and the learner's schedule. No automatic reminders are implied.

If review fails, identify whether the mechanism or only a detail was forgotten.
Repair the gap and test again later; do not erase the historical evidence.
Interleave related tasks so the learner must choose a method, not merely repeat it.

Define exit criteria before teaching: a concrete task, the required production,
relevant boundary cases, and acceptable assistance. Default to independent work and
transfer on the milestone's core concepts. Retention remains pending until there is
delayed evidence; finishing today cannot establish long-term retention.

Use a final mixed task and at least one independent production: a reconstruction, a
repair, a constructed example, or a teach-back. Credit observed practical work even
when no written explanation accompanies it; do not treat difficulty writing prose as
conceptual failure. Report achieved criteria, unassessed criteria, and a
review/practice recommendation. Do not keep extending the syllabus because further
topics exist, or claim mastery from lesson completion.

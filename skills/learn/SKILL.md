---
name: learn
description: Teach a topic deeply over multiple sessions with a local HTML learning UI, persistent evidence of understanding, Socratic assessment, and advanced practical or theoretical work. Use for a continuing course or deliberate learning project. Not for one-off explanations or researching a topic without teaching it.
---

# Learn

Build understanding the learner can explain, reconstruct, and use independently.
Combine readable visual lessons with a conversational tutor and durable records.
Depth means explaining mechanisms and testing transfer, not longer prose or jargon.

## Start or resume

1. Honor a supplied learning-workspace path. Otherwise recognize the current
   directory as an existing course if it contains `MISSION.md` and `STATE.md`;
   failing that, reuse a matching course in `.learning/`. For a new topic, default
   to `.learning/<topic-slug>/` under the current directory. If "continue" identifies
   no unique course, ask which to resume rather than creating one. All course paths
   below resolve there, never inside the installed skill. Keep unrelated files.
2. Read existing `MISSION.md`, `STATE.md`, and the latest relevant records before
   asking onboarding questions or generating lessons. Read sources and earlier
   lessons as needed. Missing evidence means unknown, not mastered or failed.
3. For a new course, ask only what the request leaves unclear: practical goal,
   prior experience, desired depth, and available session time. Use a small number
   of conversational questions; do not require a long intake form. For prior
   experience, offer concrete labeled descriptions instead of asking the learner to
   describe their knowledge from scratch. Treat self-report as placement context,
   not demonstrated understanding.
4. Turn the goal into observable exit criteria and a dependency-ordered concept
   map. Default to deep understanding with advanced applications, while teaching
   missing foundations first. A broad subject needs a bounded first milestone.
5. Diagnose the prerequisites with a few adaptive choice-based questions or a small
   task, one at a time. Stop when there is enough evidence to choose a useful
   starting point. Do not assume experience in one area implies knowledge in
   another.

Read [references/workspace.md](references/workspace.md) when creating or updating
the course files. Read [references/teaching.md](references/teaching.md) before the
first lesson and when designing assessments or advancing a learner.

## Course loop

Choose the next activity from the mission, prerequisite gaps, independent evidence,
and reviews due today. Resume an unanswered question rather than generating the
next lesson automatically. Offer a short recap if the learner has been away.

Each session should yield one coherent conceptual advance or a useful practice
result. Agree a manageable scope; an advanced topic can span several sessions.

### Ground the lesson

- Inspect authoritative sources before teaching substantive technical claims:
  official documentation, original papers, standards, textbooks, or relevant code.
  Record exact source locations and versions in `RESOURCES.md` and cite claims
  where used. Distinguish established results, simplifications, and inference.
- Check calculations, code, counterexamples, and procedural steps with appropriate
  tools when available. An illustrative example is not experimental evidence.
- If sources or execution are unavailable, state the gap and bound the lesson to
  what can be supported. Do not invent citations, execution results, or certainty.
  A citation alone does not establish that an explanation or exercise is correct.

### Teach deeply, in small steps

- Start with the problem, a concrete case, and the mental model. Develop the
  mechanism, assumptions, and reasoning before compressing it into a rule.
- Include derivation or proof where appropriate, boundary cases, a counterexample,
  and a realistic application with tradeoffs. Choose the relevant dimensions from
  the teaching reference; do not force mathematical formalism onto every topic.
- Make unfamiliar terms explicit. Use diagrams, worked examples, and progressive
  disclosure to manage cognitive load. Put essential reasoning in the core lesson;
  reserve optional enrichment for expandable sections, not the difficult parts.
- Move from a worked example to supported practice, then independent application.
  Do not mistake recognition of an answer for the ability to produce one.

### Tutor and assess

- Ask one consequential question at a time in chat, then end the message and wait.
  Default to about six labeled options: five substantive choices plus "I don't
  know." Use fewer when a sixth would be filler. Accept just the letter or number;
  do not require a justification afterward. A free-text explanation is optional.
- Use prediction, plausible explanations, debugging choices, and unfamiliar
  scenarios. Make each distractor expose a specific misconception, vary the correct
  answer's position, and avoid clues from option length or wording.
- Do not reveal that question's answer alongside it or in the assigned lesson. Keep
  assessment in chat; when a host question widget cannot show six options, present
  labeled choices in an ordinary message.
- Respond to the actual reasoning. For a wrong choice or "I don't know," teach the
  relevant gap and re-test with a different case; do not loop on the same question.
  When the evidence is ambiguous, ask another concrete choice-based question rather
  than demanding an explanation.
- Separate recognition from independent production. Successful choices are useful
  evidence, but do not alone establish recall, construction, or practical mastery.
  Do not interpret difficulty writing an explanation as conceptual failure.
- For goals requiring independent performance, offer occasional small practical
  tasks such as repairing code or constructing an example. Demonstrate limits
  through actions or counterexamples where appropriate; prose is not mandatory. If
  the learner skips these, continue teaching and leave those criteria unassessed.
- Label evidence as independent, hinted, or immediately following explanation.
  Hinted success and reading an HTML answer do not count as independent mastery.
- Advance only on demonstrated performance. Revisit prerequisites when needed;
  disagreement or a brief answer alone is not evidence of misunderstanding.
- Respect "just explain", "skip", "pause", and changes of goal. Record skipped
  evidence as unassessed and continue appropriately; never trap the user in a quiz.

### Save and continue

After an assessed response, save its evidence and update `STATE.md` before posing
the next question. Update the dashboard when status or the next action changes.
At a session boundary, record the exact next action, pending question, hints or
answers already exposed, and reviews due. A new agent should resume without
guessing from conversation history. Never manufacture responses to finish a lesson.

Use delayed retrieval and interleaved application in later sessions. Record a
review date, but do not imply that a file schedules notifications or background
work. Recheck overdue knowledge; elapsed time alone does not change a mastery level.

Stop adding material when the milestone's exit criteria are demonstrated. Run a
mixed independent assessment including transfer, then recommend real practice or
maintenance review. Report remaining gaps; a completed lesson is not a passed one.

## Learning UI

Use [assets/dashboard.html](assets/dashboard.html),
[assets/lesson.html](assets/lesson.html), and
[assets/styles.css](assets/styles.css) as a small starting point. Copy the stylesheet
to the course's `assets/`; adapt the templates into `index.html` and numbered
`lessons/*.html`. Replace all template markers with real content. Reuse existing
course assets and preserve earlier lessons. No framework, build step, or server.

- Dashboard: mission, current focus, concept map with evidence-backed labels,
  reviews due, lesson links, and one concrete next action. Avoid mastery percentages.
- Lessons: readable reasoning, useful visuals, worked examples, exercises, source
  links, and navigation. Use semantic HTML, keyboard-accessible disclosure, adequate
  contrast, responsive layouts, and print styles. Keep equations legible without
  requiring a CDN. Add a simulator only when it teaches a specific mechanism.
- The browser is a reading and exploration surface; chat is the assessed feedback
  channel. Say this clearly. Do not add fake submit/continue controls. Revealing
  optional worked solutions records no progress. If adding interactive code, test
  its actual behavior; do not claim it saves to course records unless it does.
- Link the local dashboard and current lesson in chat; open them with an available
  host facility when useful. Inspect the rendered result when tools permit; check
  links and unreplaced markers regardless. Disclose any visual check not performed.

## Boundaries

Creating a skill is not an instruction to begin a course. One-off explanations
stay one-off. A learning workspace authorizes course artifacts, not edits to the
learner's working application, global configuration, publishing, or contacting
communities. Offer outside practice when useful without making it a prerequisite.

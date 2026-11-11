# Workspace and continuity

The workspace is the portable course record. Markdown is authoritative; HTML is a
readable projection. A browser click, page view, or self-reported confidence alone
does not update assessed progress. No browser storage or service is needed.

## Files

```text
MISSION.md                  Goal, baseline, depth, milestones, exit criteria
STATE.md                    Current concept map, evidence links, next action
RESOURCES.md                Inspected sources and the claims they support
records/0001-<session>.md    Dated attempts, feedback, evidence, handoff
index.html                  Dashboard generated from these records
lessons/0001-<topic>.html    Lessons with sources, exercises, navigation
reference/<topic>.html      Optional compact reference worth revisiting
assets/styles.css           Shared local presentation
```

Create only files needed now. Paths in this reference resolve from the course
workspace. Paths to bundled templates resolve from the installed skill directory.
Do not overwrite an existing course or rename its root on resume. Escape user and
source text when embedding it in HTML; keep relative links within the course.

## MISSION.md

Capture the concrete reason for learning, prior experience (self-report versus
diagnosed evidence), desired depth, session budget, and relevant constraints.
Define a bounded milestone with observable exit criteria. For example:

> Diagnose and repair a lost-update bug, explain the isolation guarantees relied
> on, and compare two remedies under concurrent load without substantive hints.

Map required concepts and prerequisite relationships. Keep future branches as a
short backlog; do not produce a semester of lessons before seeing the learner work.
When the learner changes the goal, record the change and adjust the milestone;
do not silently expand it yourself.

## STATE.md

Keep this small enough to read at every invocation:

```markdown
# Course state
Updated: <date and session ID>
Mission: <link to MISSION.md and current milestone>
Current lesson: <relative link, or none during diagnosis>

| Concept | Prerequisites | Evidence-backed status | Evidence | Review due |
|---|---|---|---|---|
| <concept> | <IDs or none> | <label and scope> | <record links> | <date or pending> |

## Misconceptions and open questions
<Active gaps, with evidence links; distinguish learner errors from source uncertainty>

## Resume here
Activity: <diagnosis / instruction / practice / review / final assessment>
Next action: <one concrete action>
Pending question: <exact wording with every option label and text, or none>
Already exposed: <hints, solutions, or none>
Awaiting: <learner response, a tool result, or nothing>
Preferences: <pacing, explanation style, assessment format (default lettered choices), practical constraints>
```

The summary must agree with the records. If interrupted between writes, use the
latest actual attempt to repair the summary. If ambiguous, retain uncertainty and
ask a focused clarification; do not fill gaps with imagined conversation.

## Session records

Use increasing record numbers without replacing earlier sessions. Append assessed
attempts during the session, then save a handoff on pause or completion:

```markdown
# <Session ID> — <date> — <focus>
Starting point: <previous handoff and relevant reviews>
Outcome sought: <bounded objective>

## Attempt <number> — <concept>
Prompt/task: <exact question or exercise reference, including all option labels and text>
Learner response: <faithful excerpt, summary, or artifact path; label summaries>
Assistance: <independent / hinted / after explanation; specific help exposed>
Assessment: <what the actual work establishes and what it does not; whether it shows recognition or production>
Feedback/repair: <correction or next probe>
Status change: <old → new with reason, or unchanged>
Review: <date or next-session condition>

## Handoff
Covered: <what was taught, distinct from what was demonstrated>
Pending: <exact next action and unanswered question; hints/solutions exposed>
Remaining criteria: <gaps before the milestone is achieved>
```

Never record an answer before receiving it. If the session ends after instruction,
save the material as covered and the independent task as pending.

For a choice-based question, copy the full prompt and option labels into the pending
question and the attempt record before awaiting a response, so a later "C" remains
interpretable. State in the assessment whether the evidence demonstrates recognition
or independent production.

## RESOURCES.md and lessons

For each inspected source record title, URL or local path/section, version or date
where relevant, supported concepts, and caveats. Prefer primary material; label
secondary explanations. Unread recommendations are candidates, not verified sources.
Link sources beside the relevant lesson claims, derivations, and worked examples.

Reuse an existing pending lesson. For new lessons, increment the number, use the
bundled lesson template, and link back to the dashboard. Retain earlier lessons;
record substantive corrections visibly so previous evidence remains interpretable.

Update `index.html` from `STATE.md`: present actual evidence labels and review dates,
not estimated percentages. Link only artifacts that exist. During intake, show
diagnosis as the next action rather than inventing lessons or learning progress.

Before handing off, verify that state, evidence, and HTML agree, relative links
resolve, and no `{{...}}` template markers remain. Course continuity must survive
a new conversation reading only these files.

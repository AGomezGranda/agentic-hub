**OpenCode** — first check which dispatch tools this environment actually
documents. If a subagent mechanism is available, dispatch children the same
way this skill's Pi/Claude Code branches do — one message/call per batch,
not a loop — and say in one line that you used it instead of the serial
path below. A directory's presence (e.g. an `agent/` dir) is not evidence
of a callable subagent API. If no mechanism is documented, or you can't
tell, proceed with the serial procedure below. Never emulate Pi/Claude
calls (`runs.all`, `Agent`/`Task` batch shapes) on this host.

You are both investigator and verifier for every item this skill would
otherwise fan out to a child (a dimension, a test level, a review lens,
or a sub-question — whatever this skill calls its unit of fan-out). This
is a real procedure, not an apology for missing a mechanism:

- **Ordering.** Read the cheapest item first, not the order this skill
  happens to list its items in — a cheap, early finding often narrows or
  redirects what a later, more expensive item needs to look at. For a
  judgement skill (code-quality-audit, architecture-audit, testing-strategy, review-plan),
  "cheapest" usually means the item touching the fewest files; for
  research, it means the most specific sub-question.
- **Context budget.** Finish and record one item's findings — in the
  finding schema below — before opening the next item's files. Never hold
  two items' file sets in context at the same time: read, judge, write
  down, then move to the next. A cross-module edge (architecture-audit)
  is one item: both sides of it belong to the same file set. A serial run that keeps every file
  it has ever opened resident is the failure this rule exists to prevent.
- **Verification collapses to one pass.** The tiered verification this
  skill describes exists for a parent judging *someone else's* claims —
  it does not apply to you here. A `path:line` claim is
  a lead, not evidence, only when someone else made it; the one you just
  read yourself needs no second read. Record the evidence (excerpt, line
  number) as you go, and do not re-open files at report-writing time to
  re-confirm what you already saw first-hand.
- **What to drop when it doesn't fit.** A serial run of every item at full
  depth may not fit in one context. If it won't, say so and drop the
  lowest-risk, least-central items first rather than truncating silently —
  never drop a dimension, level, or lens by name as a standing policy. Name
  what you dropped and mark it unverified in the final report, with the
  next work to cover it.

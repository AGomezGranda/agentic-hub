---
name: research-codebase
description: Research how something in the codebase actually works — fanning out parallel read-only subagents and synthesising the findings into a cited research document. Use when the user needs to understand an area deeply before planning or changing it.
---

# Research Codebase

Answer a question about the codebase with evidence, not recollection. Output is
a written document where every claim points at a `file:line` a reader can open.

This is **read-only**. Don't edit code, don't fix what you find — note it and
move on.

## 1. Get the question

If the user already gave one, start. If not, ask for it and wait — don't guess
a topic.

If they mentioned specific files, work items, or docs, read those FULLY (no
offset/limit) before anything else. That context shapes how you decompose.

## 2. Size it before fanning out

Judge the surface first:

- **Narrow** (one file, one function, "where is X defined") — just grep and
  read. A fan-out of subagents here costs more than it returns.
- **Broad** (a subsystem, a cross-cutting flow, "how does X work end to end") —
  decompose into 3-5 independent sub-questions and fan out.

Say which mode you picked in one line, then proceed.

## 3. Decompose and fan out

Split the question into sub-questions that don't depend on each other's
answers — *where does X live*, *how does Y work*, *what calls Z*, *is there an
existing pattern for W*. Overlapping sub-questions waste agents; sequential
ones ("find X, then analyse X") should be one agent's job, not two.

Spawn them in **one** subagent workflow call, fanned out together, not a loop of
sequential single calls. Give each child:

```
Read-only investigation. Question: [specific sub-question].
Return: a short answer, and the concrete evidence for it as file:line
references with a 1-2 line quote or paraphrase of each. If you can't find
something, say so explicitly rather than guessing. Do not modify files.
```

Two useful shapes beyond "how does this work":
- **Pattern hunt** — "find existing implementations of a similar thing, with
  code excerpts", when the research feeds a plan.
- **Prior art** — check `plans/`, `research/`, `docs/`, ADRs for what's already
  been written on this. Treat those as *historical context*, not truth: code
  wins where they disagree, and say so when they do.

Only search the web if the user explicitly asks; if you do, carry the links
through into the document.

## 4. Verify before you synthesise

Wait for **all** children before writing anything.

Then open the key files yourself. A subagent summary is a lead, not a citation
— read enough of each cited file to confirm the claim and that the line number
is real. Never write a `file:line` you haven't personally seen. Drop or
downgrade anything that doesn't survive that check.

Mark confidence honestly:
- **verified** — you read the code
- **inferred** — follows from what you read, but not directly shown
- **unknown** — nobody found it

"Nobody found it" is a genuine finding. Say the thing is absent rather than
writing around the hole.

## 5. Harvest the open questions

This is the highest-value output of the research — a confident document that
quietly omits what it couldn't establish is worse than no document, because
the next person plans against it. Do this as a deliberate pass, not as an
afterthought while writing.

Sweep for all six sources:

1. **Unanswered** — a sub-question no agent could resolve from the code.
2. **Unverified inferences** — every finding you tagged `inferred` is a
   candidate; promote it if a plan would rest on it.
3. **Contradictions** — docs, ADRs, comments or plans disagree with the code,
   or two code paths disagree with each other. Record both sides.
4. **Intent gaps** — code shows *what*, never *why*. A magic constant, a
   retry count, a deliberate-looking ordering, a special case with no
   rationale. "Why is this 30 seconds?" is a real open question.
5. **Unbounded blast radius** — callers you couldn't enumerate: dynamic
   dispatch, reflection, config- or string-driven lookup, other repos,
   anything reached from outside this codebase.
6. **Dead ends** — code that looks unreachable or unused but you can't prove
   it either way. Deleting it is the trap this catches.

Write each as:

```
**{The question, as a question}**
Unresolved because: {what you searched, and what you'd have expected to find}
Blocks: {the decision or change this would affect — or "nothing, context only"}
Next probe: {the specific file, command, experiment, or person to ask}
```

Rank by what blocks a decision, not by how interesting it is. Separate the
ones that are **answerable with more digging** from the ones that are
**unanswerable from this repo** and need a human, another repo, or a running
system — that distinction tells the reader whether to spend time or ask.

Never leave the section empty. If there are genuinely none, write
`None — every sub-question resolved against the code.` so a reader can tell
the difference between *nothing unknown* and *nobody looked*.

## 6. Write the document

Save to `research/YYYY-MM-DD-description.md` (create the dir if missing; ask if
the user uses another convention). Frontmatter: `date`, `title`, `question`,
`commit` (from `git rev-parse --short HEAD`) so the doc dates itself against a
moving codebase.

```markdown
## Answer
{Direct answer to the question in a few sentences. No preamble.}

## How it works
{The mechanism, in the order a reader needs it. Cite file:line inline.}

## Key files
| File | Role |
|---|---|

## Findings
- **{claim}** — `path/to/file.py:42` — {evidence} _(verified)_

## Gotchas
{Surprises, dead code, drift between docs and behaviour, footguns.}

## Open questions
{Per the harvest above: question / unresolved because / blocks / next probe.
Answerable-with-digging first, then unanswerable-from-this-repo. Never empty.}
```

Rules for the body:
- Lead with the answer. A reader who stops after the first paragraph should
  have it.
- Cite, don't retell — link `file:line` instead of pasting large blocks. Quote
  only the lines that carry the point.
- Describe what the code **does**, not what it should do. Improvement ideas go
  in Gotchas, flagged as opinion.
- Self-contained: someone reading it cold, without this conversation, should
  follow it.

If the branch is pushed, optionally convert references to permalinks
(`gh repo view --json owner,name`, then
`https://github.com/{owner}/{repo}/blob/{commit}/{file}#L{line}`) — useful for
sharing, skip for local-only work.

## 7. Present and follow up

Summarise in the chat: the answer, the 3-5 files that matter, and the open
questions. Don't paste the document back.

Lead the summary's open questions with anything that **blocks a decision**,
and ask the user directly — several will be intent questions only they can
answer, and answering them in the chat is cheaper than another research pass.
Fold the answers back into the document and strike them off the list.

For follow-ups, append to the same file — a `## Follow-up: {topic}` section
plus a bumped `date` — rather than starting a new document. Re-run fresh
research for the follow-up; don't answer it from the existing text.

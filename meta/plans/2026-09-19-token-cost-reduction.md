---
date: 2026-09-19
title: Reduce token cost across the skills and the host setup
status: draft
---

## Context

Measured across 42 local transcripts (38 sessions, 2,404 assistant turns):

```
uncached input :          4,799  ( 0.00%)
cache WRITE    :      7,816,654  ( 3.13%)   5m=0  1h=7,816,654
cache READ     :    241,640,045  (96.86%)
output         :      2,319,911
read:write ratio: 30.9x
```

Caching is already optimal — 96.9% hit rate, 100% on the 1h TTL. There is
nothing to gain from cache tuning, and this plan does not attempt any.

Weighted at list prices (Enterprise bills limit-consumption, not dollars, but
the ratios hold):

| | Share of spend | Share of tokens |
|---|---:|---:|
| Cache reads | 42% | 97% |
| Cache writes | 32% | 3% |
| Output | 26% | ~1% |
| Opus | 63% | 30% |
| Sonnet | 37% | 70% |

Cost is `turns × average context`, summed over turns — **quadratic in session
length**. Six sessions (126-157 turns, 135-221K peak context) account for 40%
of all input tokens ever recorded. Median peak context is 128K.

Tool output is not the problem: Bash 1.98MB / 813 calls, Read 0.69MB / 169
calls, Agent 0.05MB / 48 calls at 1,141 chars average. All tool results
together are under 10% of appended content. `rtk` is working and the subagent
fan-out is working — **Phases 2-5 of
`2026-09-19-skills-quality-cost-and-subagents.md` are optimising something
that already measures cheap.** This plan reprioritises rather than replaces
that one; where they overlap, this plan's phase ordering wins.

Two further measurements:

- 106 turns wrote >15k tokens (4.4% of turns, 32.6% of all cache writes).
  With only 38 cold starts, ~68 are mid-session full-prefix rebuilds. The
  claude.ai connectors dropped and reconnected twice during the analysis
  session itself; each reconnect rewrites the tools prefix, which cascades to
  system and messages.
- `~/.claude/settings.json` sets `"model": "opus[1m]"`. Opus is 63% of spend
  on 30% of tokens, and the 1M window removes the context ceiling that would
  otherwise force a clear or compact — it works directly against the session
  -length lever.

### Non-goals

- Cache configuration of any kind.
- Reducing tool-result volume (already handled by `rtk`).
- Changing the subagent fan-out shape (Phases 2-5 of the other plan).
- Weakening evidence standards. Every change here must be neutral or positive
  for output quality; the finding-slot format in Phase 4 is expected to raise
  it.

## Implementation Phases

0. Host settings — two lines in `settings.json`, connector pruning.
1. Session-length discipline — every skill terminates and hands off.
2. Read-siting — full reads move to children; parent reads only what it writes.
3. Output density — slot-based findings, severity-gated, across all skills.
4. Baseline measurement — `agentic-hub cost` so the above is provable.

Phase 0 is host config outside the repo and is by far the cheapest. Phases 1-3
are skill edits. Phase 4 subsumes the measurement half of the other plan's
Phase 7.

---

## Phase 0 — Host settings and connectors

### Overview

Config-only, no repo changes, largest immediate effect.

### Changes

- `~/.claude/settings.json`: `"model": "opus[1m]"` → `"model": "sonnet"`.
  Sonnet 5 is the model actually in use for this work; Opus becomes an
  explicit per-session `/model` choice for `create-plan` and `implement-plan`
  if it earns it. Never switch mid-session — caches are model-scoped and a
  switch is a full cold rebuild.
- claude.ai → Settings → Connectors: disable Gmail, Google Calendar, Google
  Drive, Microsoft 365, Sigma, ebury_rocks. Measured usage across 42
  transcripts is Atlassian Rovo (22 calls) and Notion (3); everything else is
  zero. These are account-level, not `.mcp.json` — local config cannot
  disable them.
- Per-session: `/mcp` to disconnect what a given repo does not need.

### Tests

None — config.

### Success criteria

**Automated**: none.
**Manual**: a fresh session lists only Atlassian Rovo and Notion under `/mcp`;
`/status` reports Sonnet. Re-run Phase 4's tooling after a week and confirm
the >15k-write turn count has fallen below ~2% of turns.

### What we're NOT doing

Not removing Atlassian Rovo or Notion. Not touching the `rtk` or
`risk-ai-infra` hooks.

---

## Phase 1 — Session-length discipline

### Overview

The 40%-of-everything lever, and the one thing no current skill does. Each
skill already produces a handoff artifact; none of them exits after writing
it.

### Changes

- `research-codebase/SKILL.md` §7, `review-plan/SKILL.md` §5,
  `create-plan/SKILL.md` §4, `code-quality-audit`, `testing-strategy`: add a
  closing step — summarise in chat, name the artifact path, and tell the user
  to `/clear` before the next skill. The artifact is the handoff; the
  conversation is not.
- `implement-plan/SKILL.md`: the same, per PR group rather than per plan,
  reusing the **PR Strategy** section `create-plan:38-43` already produces.
- One shared sentence, same wording in all six, stating why: cost is
  `turns × context` summed over turns, so a 150-turn session costs roughly 4×
  what the same work costs split across five 30-turn sessions.

### Tests

Phase 4's tooling is the test. No unit tests — these are prose edits.

### Success criteria

**Automated**: `pytest` still green (catalog/agents parsing unaffected).
**Manual**: median peak context per session falls below ~80K over the
following two weeks; no session exceeds ~60 turns without a deliberate reason.

### What we're NOT doing

Not adding an automated clear. Not a hook — the user decides when a phase is
finished.

---

## Phase 2 — Read-siting

### Overview

"Read FULLY (no offset/limit)" is a correct rule sited in the most expensive
possible place. A file read on turn 5 of a 130-turn session is paid for on
125 further turns; a file read in a child is paid once. The skills currently
tell children to summarise and the parent to re-read everything — the exact
inverse.

Separately, no skill has a *selection* criterion: `create-plan:20` ("read
every file the research turns up FULLY") and `implement-plan:Start` ("read the
files it references and touches") are both unbounded.

### Changes

- Add one shared block to `research-codebase`, `create-plan`, `review-plan`,
  `implement-plan`, `code-quality-audit`, `testing-strategy`:

  > **Read fully:** the plan/research/review document, and every file you will
  > edit.
  > **Read targeted:** files you only need the interface of — grep the symbol,
  > read its region.
  > **Delegate:** if answering one question needs more than ~8 files, that is
  > a child's job. You are buying context you pay for on every remaining turn.

- Reframe the verification pass (`research-codebase:62-67`,
  `code-quality-audit:116-118`, `testing-strategy:134-136`) from *re-open
  every cited file* to *spot-check the claims that carry a decision*. This is
  the same mechanism as Phase 4 of the other plan, but stated as a quality
  rule — which is what makes it survive contact with a model inclined to be
  thorough.
- `create-plan:20-21` loses "Read every file the research turns up FULLY…
  don't plan off a subagent's summary alone" in favour of the shared block.

### Tests

None — prose.

### Success criteria

**Automated**: `pytest` green.
**Manual**: on a research run over a subsystem of 20+ files, parent peak
context stays under ~60K while the document still carries verified `file:line`
citations for every decision-bearing claim.

### What we're NOT doing

Not permitting partial reads of purpose-written documents (plans, research,
reviews, ADRs, tickets) — those stay full-read, always. Not removing
verification.

---

## Phase 3 — Output density

### Overview

Output is 26% of spend on ~1% of tokens, and the documents are read back in
later sessions, so length compounds. The verbosity is restatement, not
information: `review-plan` states each finding up to three times — as a
finding, in Cross-Cutting Themes, and in Recommended Changes.

### Changes

- **Slot-based findings.** Replace "a one-paragraph body" with fixed slots.
  Applies to `review-plan`, `code-quality-audit`, `testing-strategy`:

  ```
  🔴 **Architecture** — {claim, one line}
  §{section} · confidence: {high|medium|low}
  Because: {evidence, one sentence, with file:line}
  Fix: {the change, one sentence}
  ```

  ~40% of the tokens, more scannable, and a slot that cannot be filled is a
  weak finding — this is expected to raise precision, not trade against it.
- **Severity gate.** Critical/major get Because + Fix. Minor/suggestion get
  one line. Most volume is minors.
- **Drop restatement.** Cross-Cutting Themes becomes a pointer line
  (`Themes: concurrent writes (§3, §5) · untested error paths (§2, §4)`).
  Recommended Changes stays — it is the actionable section. Strengths caps at
  three bullets in the summary.
- **Shared contract line** at the top of every document-producing skill:

  > This document is read in a later session by someone with no memory of this
  > one. Every line must change what they do. Delete anything that only
  > demonstrates thoroughness.

- `research-codebase §5`'s six open-question sources stay — that section is
  the skill's highest-value output. Only its per-item prose is slotted.

### Tests

None — prose. Phase 4 measures the effect; a future eval (other plan, Phase 7)
guards the quality side.

### Success criteria

**Automated**: `pytest` green.
**Manual**: a review of the same plan produces the same count of
critical/major findings as the current format at roughly half the document
length. If finding count drops, the format is wrong — revert and reconsider.

### What we're NOT doing

Not imposing word counts. Not cutting the number of lenses or the number of
findings — density only.

---

## Phase 4 — Baseline measurement

### Overview

None of the above is provable without a before/after. Three scripts already
exist from the analysis behind this plan; productise them.

### Changes

- New `src/agentic_hub/cost.py`, exposed as `agentic-hub cost`, reading
  `~/.claude/projects/*/*.jsonl` and reporting, separately (never blended):
  uncached input, cache-write split by TTL, cache read, output; per model;
  per session with turn count and peak context; tool-result volume by tool;
  and the count of >15k-write turns as a prefix-rebuild proxy.
- `--since` for before/after windows.
- Tests in `tests/test_cost.py` against a small fixture JSONL.

### Tests

Written first: fixture JSONL with two sessions and two models →
assert per-model totals, peak-context derivation, rebuild count, and that a
missing `usage` key is skipped rather than raising.

### Success criteria

**Automated**: `pytest`, `ruff check`, `pyrefly`.
**Manual**: `agentic-hub cost` reproduces the numbers in this plan's Context
section from the current transcripts.

### What we're NOT doing

Not a TUI view. Not parsing Pi or Codex transcripts — Claude Code only for
now, noted as a follow-up since Pi is the primary host.

---

## PR Strategy

| PR | Phases | Why |
|---|---|---|
| — | 0 | Host config, no repo change. Do first; it costs minutes. |
| 1 | 4 | Measurement lands before the changes it measures. |
| 2 | 1 + 2 | Both are shared prose blocks across the same six skills. |
| 3 | 3 | Output format touches every document template; review alone. |

Phase 4 before Phases 1-3 so there is a baseline. Phases 1-3 are independent
of the other plan's Phases 1-8 except where noted in Phase 2.

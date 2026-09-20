---
date: 2026-09-19
title: Improve the skills for output quality, token cost, and subagent use across Pi/Codex/Claude Code/OpenCode
status: draft
---

## Context

`skills/` holds seven skills (`code-quality-audit`, `create-plan`,
`implement-plan`, `remove-comment-slop`, `research-codebase`, `review-plan`,
`testing-strategy`), symlinked into Pi, Claude Code and OpenCode and flattened
into a Codex prompt file by `agents.py:52-77`. They are a deliberate fork of
the `accelerator` plugin's equivalents — the name collision with
`accelerator:create-plan` etc. is intended, and not a finding.

**Primary host is Pi**, with Codex, Claude Code and OpenCode as secondary
targets. That ordering matters, because Pi is the only host whose subagent
capabilities have been checked against the skills' actual wording.

### What the skills currently assume

Five skills tell the model to fan out "in one `subagent` workflow call":
`create-plan/SKILL.md:17`, `research-codebase/SKILL.md:40`,
`review-plan/SKILL.md:48`, `code-quality-audit/SKILL.md:42-43`,
`testing-strategy/SKILL.md:72-74`.

### What Pi actually provides (verified)

`~/.pi/agent/settings.json` installs `npm:pi-subagents` and
`git:github.com/DietrichGebert/ponytail`. So:

- The `subagent` tool **is real on Pi** and the skills' wording is accurate
  there. `docs/tool-reference.md` confirms `workflowScript` with
  `runs.run(...)` / `runs.all([...])` for parallel fan-out, plus per-call
  `model`, `context: fresh|fork`, `async`, and `isolation`.
- `ponytail-review` / `ponytail-audit`, referenced at
  `code-quality-audit/SKILL.md:8,26-27,93`, **do exist** — as Pi skills under
  `~/.pi/agent/git/github.com/DietrichGebert/ponytail/skills/`. Also valid.
- pi-subagents ships purpose-built agents the skills never name
  (`agents/*.md` frontmatter read directly):

  | Agent | tools | thinking | notes |
  |---|---|---|---|
  | `scout` | read, grep, find, ls, bash, write, contact_supervisor | **low** | `output: context.md` |
  | `researcher` | read, write, web_search, fetch_content | medium | `output: research.md` |
  | `reviewer` | read, grep, find, ls, contact_supervisor (read-only) | **high** | no write tools at all |
  | `evidence-auditor` | read, web_search, source_check | high | "independent evidence review of important claims" |
  | `oracle` | read, grep, find, ls, bash | high | `defaultContext: fork` |
  | `worker` | + edit, write | high | `defaultReads: context.md, plan.md` |

- **Every packaged agent sets `inheritSkills: false`.** A child does **not**
  see the skill that spawned it. `docs/agents.md:270-279` is explicit:
  "Custom agents start with a clean system prompt and only the context you
  intentionally give them." (`systemPromptMode: replace` is the default for
  nine of the ten; `delegate` sets `append` deliberately per
  `docs/agents.md:282` — the `inheritSkills: false` half this plan rests on
  holds for all ten regardless.)
- Custom agents are discoverable from `~/.pi/agent/agents/**/*.md`
  (`docs/agents.md:20-24`) and support `model:`, `thinking:`, `tools:`,
  `output:`, `defaultReads:`, and — critically — `skills: <name>` /
  `skillPath:` to load one specific skill into the child regardless of
  `inheritSkills` (`docs/agents.md:300-310, 345-355`).
- pi-subagents also ships reference prompts at `prompts/parallel-research.md`
  and `prompts/parallel-review.md` that solve the same fan-out problem these
  skills solve, with a stricter child contract (P0/P1/P2, explicit
  `Merge verdict:` line, "if nothing qualifies say exactly `No issues found.`").

### The gaps this plan closes

1. **`inheritSkills: false` silently breaks three fan-outs.**
   `code-quality-audit:44-46` spawns a child "given the domain map/conventions
   from step 2" and expects that dimension's rubric to be applied — but the
   rubric is in §3 of a SKILL.md the child cannot see.
   `testing-strategy:72-79` has the same defect (the child is told to "answer
   that level's questions below"; "below" is not in its context), made worse
   because the child also cannot reach `AUDIT_STRATEGY.md`, which
   `SKILL.md:10-13` calls mandatory reading. `review-plan:50-58` is the only
   one that inlines a self-contained child prompt.

2. **The verification pass cancels the fan-out's token saving.**
   `research-codebase:62-67`, `code-quality-audit:116-118` and
   `testing-strategy:134-136` all require the parent to re-open every cited
   file. Correct for trust, but the parent then pays the full token cost and
   the fan-out only buys wall-clock. `evidence-auditor` exists for exactly
   this job and is never used. Children also never use `output:` files, so
   every finding returns as prose into the parent's context.

3. **Named agents and per-child cost controls are unused.** Every fan-out
   spawns a generic child. Locator-shaped work belongs on `scout`
   (`thinking: low`); lens review belongs on `reviewer` (read-only tools,
   `thinking: high`, which also structurally enforces the "audit, don't
   rewrite" rule that `code-quality-audit:18-19` and `testing-strategy:20-21`
   currently only request politely).

4. **The `subagent` wording is Pi-only with no degradation path.** Claude Code
   uses `Agent`/`subagent_type`; Codex has no subagent mechanism at all. On
   Codex the model must either fake the fan-out or silently serialise — and
   the mandatory re-verification step in §4 becomes redundant work, because a
   serial reader already read the files first-hand.

5. **Codex export is broken for two skills.** `agents.py:74-75` writes only
   `description` + SKILL.md body, so `testing-strategy` loses
   `AUDIT_STRATEGY.md` (450 lines its body declares mandatory), and any
   future `references/` file vanishes the same way. Separately,
   `catalog.py:23-26` splits on the *first* colon only, so
   `code-quality-audit`'s `description: >` folded block (`SKILL.md:3-9`)
   parses to the literal scalar `">"` — the six continuation lines are
   silently dropped for having no colon — and its Codex prompt file leads
   with a bare `>` (a lone blockquote marker), exactly the case the
   `catalog.py:15-16` comment predicted.

6. **Progressive disclosure is barely used.** Only `testing-strategy` has a
   companion file. The content most worth moving out is precisely the content
   a *child* needs and the *parent* does not: `code-quality-audit`'s six
   dimension rubrics (§3, ~350 words) and `review-plan`'s 13-lens table (§2).

7. **Arbitrary fan-out caps.** `code-quality-audit:46-48` and
   `testing-strategy:76-79` cap children at 4-5 and tell the model to merge
   two dimensions into one child if all six apply — which produces one child
   doing two jobs worse, for no stated reason. Children are cheap relative to
   parent context; that is the point of fanning out.

8. **Smaller items.** `review-plan:13` jams two `find` commands onto one
   line with a stray double space in "plans  or reviews" and will read as one
   command. `create-plan:45` and `review-plan:13` duplicate meta-directory
   discovery with different commands. No skill declares an `allowed-tools`
   equivalent. There are no evals, in a repo whose product is skills.
   Separately, `agents.py`'s `status()` treats a Codex-generated file as
   `linked` forever once the marker line exists, even after the source
   `SKILL.md` changes underneath it — a symlinked host can't rot this way,
   but a generated one can, and nothing today tells an operator their Codex
   copy is stale.

Body sizes are healthy (295-1452 words, all well under the ~5k-word
guidance), so this plan does not do a blanket prose trim — but word count is
evidence about length, not clarity, and two files don't clear a close
reading: `remove-comment-slop/SKILL.md:45-79`'s Examples block carries more
narrative build-up than the pattern needs, and `create-plan/SKILL.md:14-21`
gives a subagent fan-out with no return format, no evidence bar and no
empty-result rule — the weakest child contract in the repo, and
`create-plan:20-21` ("Read every file the research turns up FULLY… don't
plan off a subagent's summary alone") is the same parent-pays-twice pattern
Phase 4 removes elsewhere. Both are handled directly below: `create-plan`
joins the Phase 3/4 child-contract work; `remove-comment-slop` stays a
Phase 5 "only if" as already scoped. `implement-plan:49-50` ("Use
subagents sparingly here") is structurally fine but is named here so it
isn't a silent omission.

### Cost model

Three budgets recur through this plan and are not interchangeable: **parent
context** (what the model synthesising the report has to hold), **total
tokens** (parent + every child, what gets billed), and **dollars** (total
tokens × price-per-token, which price tiering changes independently of
token count). Roughly:

- Phase 2 (un-capping fan-out) *raises* total tokens and *lowers* wall-clock;
  it does not lower parent context or dollars per token.
- Phase 3 (verbatim excerpts) *raises* parent context slightly (~40→~90
  tokens per finding) in exchange for Phase 4 being able to skip full
  re-reads — a trade, not a free win, and negative if Phase 4 does not ship
  alongside it.
- Phase 4 (tiered verification, `output:` files) *lowers* parent context,
  the plan's biggest lever (~32k → ~5k parent tokens on an 8-file audit).
- Phase 5 (progressive disclosure) *lowers* parent context by a small,
  measured amount (~700 tokens) but a larger amount per-child (avoids
  inlining the same ~470-token rubric into each of up to six prompts).
- Phase 8 (model/thinking tiering) *lowers* dollars per token for children,
  independent of how many tokens they use.

One asymmetry the rest of the plan does not otherwise account for: Pi
children run `context: fresh` / `inheritSkills: false`, which is a
guaranteed cache miss on every child, while the parent's long-running
context is a cache hit at a fraction of list price. That inverts "children
are cheap relative to parent context" when the currency is dollars rather
than tokens, and Phase 7 should record uncached-input, cached-read-input,
and output+thinking tokens separately rather than one blended total.

## Implementation Phases

1. Fix the Codex export and frontmatter breakage — `catalog.py`/`agents.py`.
2. Portable fan-out contract — one shared block, five skills.
3. Self-contained child prompts and a single finding schema.
4. Cost: named agents, file handoff, delegated verification.
5. Progressive disclosure — move child-only rubrics into `references/`.
6. Ship `agents/` definitions and teach `agentic-hub` to install them.
7. Evals.
8. Tune the Pi host setup so the above actually pays off.

Phases 1-5 are skill/installer edits against the current design. Phase 6 is a
new installer capability and is the only phase that changes the repo's data
model. Phase 7 measures whether any of it worked. Phase 8 is host
configuration outside this repo; it is listed last but is the cheapest phase
here, and Phase 4's cost claim is muted without it.

---

## Phase 1 — Fix the Codex export and frontmatter breakage

### Overview

Two live defects that make two skills degrade silently on Codex. Smallest,
highest-certainty change; everything later depends on `references/` surviving
the export.

### Changes

- `skills/code-quality-audit/SKILL.md:3-9` — replace the `description: >`
  folded block with a single-line single-quoted scalar, matching
  `remove-comment-slop/SKILL.md:3` and `testing-strategy/SKILL.md:3`. Keep the
  routing to `ponytail-review`/`ponytail-audit` (they are installed on Pi) but
  compress it; it currently spends roughly 40% of an always-in-context budget
  on negative routing.
- `src/agentic_hub/catalog.py:14-27` — leave the parser flat, but on a value
  that starts with `>` or `|`: `parse_frontmatter` **warns and returns the raw
  scalar** (so `tui.py`'s row-highlight path, which only catches `OSError`,
  never sees a raised exception and keeps rendering); the *export* path in
  `agents.py` **raises**, so a broken description fails the install loudly
  instead of shipping a blank/blockquote description to Codex. Also strip a
  single layer of matching `'...'`/`"..."` quoting from scalar values —
  today's single-quoted descriptions (e.g. `testing-strategy/SKILL.md:3`)
  already ship their literal quote characters into the Codex prompt file.
  The `catalog.py:15-16` comment already anticipates the folded-block case;
  make it enforce rather than predict.
- `src/agentic_hub/tui.py:132-137` — broaden `_update_detail`'s
  `except OSError` to also catch the new `ValueError`, so a folded/malformed
  description in *any* skill — including a third-party one dropped into
  `skills/` — warns in the detail pane instead of crashing the TUI on row
  highlight.
- `src/agentic_hub/agents.py:70-77` — in `codex` mode, walk `**/*.md`
  **recursively** under the skill directory (not just direct siblings of
  `SKILL.md`), excluding `SKILL.md` itself and anything under `scripts/` or
  `assets/`, and append each to the generated prompt file under a
  `## Bundled reference: <relative-path>` heading, sorted by relative POSIX
  path for deterministic ordering. Recursive, not flat: Phase 5 puts
  reference files in a `references/` subdirectory, and a sibling-only glob
  would silently drop them from the Codex export — reintroducing the exact
  defect this phase exists to fix. Read each file `encoding="utf-8"`
  explicitly and skip (with a warning) any file that isn't valid UTF-8,
  rather than letting the install crash on one bad reference.
- `src/agentic_hub/agents.py:CODEX_MARKER`/`is_our_codex_file`/`status()` —
  embed a short content hash in the marker line (e.g. `<!-- agentic-hub:
  generated sha256:<12-hex> -->`) and have `status()` compare it against a
  hash of the content that would be (re)generated now. Today the marker is a
  fixed string, so `status()` returns `linked` forever once it exists, even
  after the source `SKILL.md` changes — the exact drift already visible in
  this repo's own `~/.codex/prompts/` (see Gap 8). Mismatch → `stale`,
  reusing the value symlink mode already returns for the equivalent case.
- `skills/testing-strategy/SKILL.md:10-13` — reword the reference pointer so it
  works both ways: read the sibling file if present, otherwise use the inlined
  `## Bundled reference` section in this same document.
- `skills/review-plan/SKILL.md:13` — split the two jammed `find` commands
  onto separate lines and fix "plans  or reviews".

### Tests

Written first, in the existing pytest layout:

- `tests/test_catalog.py::test_parse_frontmatter_warns_on_folded_scalar` — a
  `description: >` block warns and returns the raw `">"` scalar rather than
  silently yielding a value that looks like a normal description.
- `tests/test_agents.py::test_codex_flatten_inlines_sibling_markdown` — a skill
  dir with `SKILL.md` + `REFERENCE.md` produces one prompt file containing both,
  under the expected heading.
- `tests/test_agents.py::test_codex_flatten_inlines_nested_references_dir` — a
  skill with `references/a.md` and `references/b.md` (Phase 5's shape) both
  appear in the generated prompt file. This is PR 1's contract with PR 4;
  land it before Phase 5 depends on it.
- `tests/test_agents.py::test_codex_flatten_skips_scripts_and_assets` — files
  under `scripts/` and `assets/` are not inlined.
- `tests/test_agents.py::test_codex_flatten_unchanged_without_siblings` — pins
  the existing single-file behaviour so
  `test_install_flattens_codex_prompt` stays meaningful.
- `tests/test_agents.py::test_codex_install_raises_on_folded_description` —
  the export path raises on the same folded-scalar input the parse path
  merely warned on.
- `tests/test_tui.py::test_detail_pane_survives_folded_description` — a skill
  with a folded/malformed description does not crash `_update_detail`.
- `tests/test_catalog.py::test_real_skills_corpus_has_valid_frontmatter` —
  runs `catalog.discover_skills()` against the actual `skills/` directory,
  **no monkeypatch, no synthetic fixture**. Every existing test builds a
  skill in `tmp_path`; that is why the `description: >` bug shipped green in
  the first place, and a synthetic-fixture test for this phase would not
  have caught it either. Highest value-per-line test in this plan.
- `tests/test_agents.py::test_codex_status_detects_stale_after_source_edit` —
  install, edit the source `SKILL.md` body, assert `status()` returns
  `stale` (not `linked`), and that `install_one` regenerates the file on the
  next sync.

Edge cases pinned: skill with no siblings; sibling that is not markdown;
sibling large enough to matter (assert ordering is deterministic, sorted by
relative POSIX path); a reference file that itself starts with `---`; a
non-UTF-8 sibling (skipped with a warning, not a crash); re-running install
is idempotent; single-quoted scalars are unquoted in the export.

### Success criteria

**Automated**
- `uv run pytest -q`
- `uv run ruff check` / `uv run ruff format --check` if configured

**Manual**
- `agentic-hub install code-quality-audit --agent codex`, then confirm
  `~/.codex/prompts/code-quality-audit.md` has a non-empty description line.
- `agentic-hub install testing-strategy --agent codex`, then confirm the
  prompt file contains the AUDIT_STRATEGY content.
- Edit an installed skill's `SKILL.md` body directly, then confirm
  `status()`/the TUI report its Codex entry as `stale`, not `linked`.

### What we're NOT doing

- Not adopting a real YAML parser. Flat `key: value` plus a loud failure is
  enough, and keeps the zero-dependency parse.
- Not changing the symlink strategy for Pi/Claude/OpenCode — those already see
  the whole directory.

---

## Phase 2 — Portable fan-out contract

### Overview

Replace the Pi-only `subagent` wording with one identical block, used verbatim
in all five fan-out skills, that names the best mechanism per host and states
what to do when there is none. Identical text across skills so it is one thing
to maintain and one thing for the model to learn.

### Changes

Add to each of `research-codebase`, `review-plan`, `create-plan`,
`code-quality-audit`, `testing-strategy` a short `### Fanning out` block
replacing the current one-line `subagent` sentence. Content:

- **Pi** — one `subagent` call with a `workflowScript` using
  `runs.all([...])`; name the packaged agent per child (`scout` for locate,
  `reviewer` for judge, `researcher` for external). Note: whether Pi's
  `runs.all([...])` children run truly concurrently or are pool-throttled
  has not been verified — if throttled, un-capping buys nothing in
  wall-clock for strictly more tokens. Spot-check before leaning on this in
  Phase 7.
- **Claude Code** — one message containing N `Agent` (historically
  `Task`/`subagent_type`) calls; `Explore` for locate, `general-purpose`
  otherwise. Children cannot spawn further children on this host.
- **OpenCode** — unverified: `~/.config/opencode/agent/` has not been
  confirmed to exist on any machine this plan was written against. Until
  someone checks, treat OpenCode as the no-mechanism arm below rather than
  shipping a "use its subagent mechanism if present" sentence that tells the
  model nothing actionable.
- **No mechanism available (Codex, and OpenCode until verified)** — run the
  same investigations serially and say so in one line. Verification stays
  capability-conditional, not host-conditional: nothing at install time
  stamps which host is running, so a rule gated on "am I Codex" is
  unenforceable. Instead: *if you read a cited file yourself, in this same
  session, skip re-reading it; if a child (or a serial sub-pass whose output
  you didn't personally verify) reported it, do the tiered check from
  Phase 4.* That is correct on every host without knowing which one it is,
  and does not assume a serial reader always opened every file — skills
  explicitly permit grep-shaped discovery (`research-codebase:26-27`, "just
  grep and read"), and long serial runs compact early reads out of context
  anyway.

Also replace the arbitrary caps at `code-quality-audit:46-48` and
`testing-strategy:76-79` with a cost rule: one child per question answerable
independently; do not split a question whose halves would read the same
files (Pi children start from a cold, uncached context each, so two children
reading the same domain files is not free just because it is parallel); if
six dimensions genuinely apply, spawn six. The justification is wall-clock,
not token cost — total tokens rise when six children run instead of merging
into fewer, and this plan says so plainly rather than implying the
un-capped version is also cheaper.

### Tests

Not unit-testable — this is prompt content. Verification is Phase 7's evals
plus manual runs. Structural tests assert **content contracts, not raw byte
equality** — a byte-equality test passes vacuously if the block were reduced
to one word in all five, and asserts sameness, never presence:

- `tests/test_skills.py::test_fanout_block_present_and_complete` — each of
  the five skills' `### Fanning out` section names all four host branches
  (Pi/Claude Code/OpenCode/no-mechanism) and the capability-conditional
  verification rule, deriving the skill list from frontmatter
  (`catalog.discover_skills()`) rather than a literal list in the test, so a
  sixth fan-out skill is covered automatically.
- `tests/test_skills.py::test_fanout_shared_prose_identical_across_skills` —
  the specific sentences that are meant to be copy-identical (the ladder
  logic, not any per-skill agent name from Phase 6) match byte-for-byte.
  Keep this one, narrowed to what's actually invariant — it is the one thing
  that will drift silently otherwise.

Worth reconsidering before Phase 6 turns this into three separate
byte-identity invariants across overlapping skill subsets: keep one
`shared/fanout.md` snippet in the repo and expand it into each SKILL.md at
**authoring** time (a small script, run manually or in CI, that re-expands
and diffs). Checked-in skills stay full-text — the install-time symlink
strategy is unaffected — and "edit once" is preserved without hand-copying
prose five times or a test that can report drift but not repair it. Not
built in this phase; flagged here because Phase 3 and Phase 6 add two more
shared blocks on top of this one and the maintenance cost compounds.

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- Run `research-codebase` on this repo under Pi; confirm it issues one
  `subagent` call with `runs.all`, not a loop.
- Run the same under Codex; confirm it states it is running serially, and
  that it still applies the tiered (not skipped) verification from Phase 4
  to anything it didn't personally read.

### What we're NOT doing

- Not templating the block per agent at install time. That would mean
  generating copies instead of symlinks, and the symlink (edit once, live
  everywhere) is the repo's core value. One block covering all hosts is the
  cheaper trade.
- Not removing the fan-out sizing judgement entirely — `research-codebase:24-32`
  narrow-vs-broad triage is good and stays.

---

## Phase 3 — Self-contained child prompts and one finding schema

### Overview

Close the `inheritSkills: false` defect: every child prompt must carry
everything the child needs, because the child cannot see the skill. Then give
all four fan-out skills the same child output contract, so there is one
aggregation format.

### Changes

- `code-quality-audit/SKILL.md:42-48` — the child prompt must inline (or point
  at by absolute path) that dimension's rubric, plus the step-2 domain map. It
  currently assumes the child can read §3.
- `testing-strategy/SKILL.md:72-79` — same: inline the level's questions and
  pass the absolute path of `AUDIT_STRATEGY.md`, since the child has `read` but
  no skill context.
- `create-plan/SKILL.md:14-21` — same fix, and the bigger one: give the
  research fan-out a return format, an evidence bar (`file:line`, not
  recollection) and an empty-result rule, matching the other three. Also drop
  "read every file the research turns up FULLY… don't plan off a subagent's
  summary alone" as an unconditional rule — that is the parent-pays-twice
  pattern Phase 4 removes elsewhere; replace it with the same tiered
  verification this phase and Phase 4 give everyone else.
- `research-codebase/SKILL.md:42-48` — change "a 1-2 line quote **or
  paraphrase**" to require a **verbatim excerpt with its line numbers**. The
  paraphrase option is what forces the parent to re-read in Phase 4.
- `implement-plan/SKILL.md:49-50` ("Use subagents sparingly here") is a
  single sentence, not a fan-out — no schema or contract change needed, but
  note it exists so a future reader doesn't assume it was missed.
- Add one shared ~12-line fenced finding schema to `code-quality-audit`,
  `testing-strategy`, `research-codebase` and `create-plan`: severity
  (P0/P1/P2, matching pi-subagents' `prompts/parallel-review.md` rather than
  inventing a third vocabulary), confidence, `path:line`, verbatim excerpt,
  one-paragraph body, and an optional `strengths:` list (what's solid, not
  just what's wrong — see below). `review-plan` keeps its existing
  critical/major/minor/suggestion vocabulary for its own children (it already
  has a working contract); add one explicit mapping line instead of a second
  vocabulary: P0 → critical, P1 → major, P2 → minor/suggestion (child's
  judgement which), so the two schemas translate at the one place they meet —
  a shared aggregation step, if one is ever built.
- Propagate `review-plan:60-62`'s parse-failure fallback ("keep the raw text as
  a single major finding under its lens name") to the other three. It is the
  only skill that handles a malformed child today.
- Adopt the packaged prompts' explicit empty-result sentence, but keep it
  structured rather than a bare string: a child with nothing to report for a
  dimension/level/lens/question says `No issues found. Checked: <what>.
  Solid because: <one line>.` — not just `No issues found.` A bare string
  can't feed `code-quality-audit:125-126`'s "Explicitly fine" section,
  `testing-strategy:151-152`'s "Explicitly not recommended", or
  `review-plan:52-57`'s request for strengths; the structured version, plus
  the optional `strengths:` field above, keeps those honesty mechanisms fed
  by the same child that used to defeat them.

### Tests

- `tests/test_skills.py::test_finding_schema_present_and_parseable` — each
  of `code-quality-audit`, `testing-strategy`, `research-codebase`,
  `create-plan` declares all required schema fields (severity, confidence,
  `path:line`, verbatim excerpt, body) and the structured empty-result
  sentence — content contract, not raw byte equality, so a legitimate
  per-skill wording tweak doesn't fail the test.
- `tests/test_skills.py::test_empty_result_sentence_is_structured` — the
  empty-result rule includes both `Checked:` and `Solid because:`, not just
  the bare `No issues found.` string.
- `tests/test_skills.py::test_create_plan_child_prompt_has_contract` —
  `create-plan`'s fan-out block states a return format and an empty-result
  rule, closing the gap this phase adds it to fix.
- Behavioural coverage is Phase 7.

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- Run `code-quality-audit` on `src/` under Pi with a deliberately narrow
  dimension; confirm from the run transcript that the child's task text
  contains the rubric, and that the child never asks for missing context.

### What we're NOT doing

- Not switching to `inheritSkills: true` on children. It would load the whole
  skills catalog into every child — the opposite of the cost goal. Phase 6's
  `skills: <name>` targeting is the precise version of this.
- Not inventing a severity vocabulary. P0/P1/P2 matches the host package, and
  `review-plan` keeps its own with one mapping line rather than a rewrite of
  a contract that already works.

---

## Phase 4 — Cost: named agents, file handoff, delegated verification

### Overview

The three levers that actually reduce tokens, all of which exist on Pi today
and none of which the skills use.

### Changes

This phase has a **portable core**, stated once in host-neutral terms and
required everywhere, and a **Pi appendix** that names concrete agents behind
one guarded line. Three of four hosts cannot act on the appendix's detail, so
it does not belong inlined five times.

**Portable core — tiered verification (all hosts).** Replace the blanket
"open each cited file yourself" at `research-codebase:62-67`,
`code-quality-audit:116-118` and `testing-strategy:134-136` with:

- **Findings a top-line recommendation rests on** → read the full file. A
  `sed -n 'X,Yp'` window confirms the quote is real, not that the finding is
  correct — judging an SRP or DDD claim needs the surrounding contract
  (`code-quality-audit:52-54`), which a line-range extract cuts away. This is
  where the parent is supposed to pay.
- **Corroborating findings** (support a recommendation but aren't the reason
  for it) → targeted `sed -n 'X,Yp'` / `grep -n` against the cited lines is
  enough.
- **Everything else** → spot-check on any host; on Pi, may be handed to
  `evidence-auditor` in bulk (see appendix).
- State which tier each finding is in, so the reader knows what was checked
  and at what depth. Keep the principle intact — a child's `path:line` is a
  lead, not evidence — while removing the requirement that the parent
  full-read every single one regardless of weight.

**Portable core — child return contract under file handoff.** Wherever a
child writes findings to a file (see appendix), its final message is a
**pointer only** — file path plus a one-line count of findings by severity —
not a prose restatement. On hosts where the child's final message still
surfaces to the parent regardless of `output:`, a full prose return defeats
the point: the parent would pay for the file *and* the prose. The parent then
reads selectively: greps severity headers across all child output files,
`sed -n`-extracts the findings it will act on per the tiering above, and only
full-reads the file behind a load-bearing finding.

**Pi appendix — named agents (gate: `subagent` tool with these packaged
agents present).** `scout` (`thinking: low`) for locate/inventory work in
`research-codebase` §3 and `testing-strategy` §2; `reviewer` (read-only
tools, `thinking: high`) for every `review-plan` lens and every
`code-quality-audit` dimension; `researcher` only where the skill already
permits web access (`research-codebase:57-58`). `reviewer`'s toolset has no
write capability, which is what actually enforces the "audit, don't rewrite"
rules at `code-quality-audit:18-19` and `testing-strategy:20-21` — note this
in each skill. Children use `output: <path>` (`scout` already defaults to
`output: context.md`); bulk-verification of a finding set may be handed to
`evidence-auditor` instead of the parent doing every targeted read itself.
On hosts without these agents (Codex, Claude Code, unverified OpenCode): same
tiered-verification and pointer-return behaviour, done by the parent/generic
child directly — no capability is lost, only the specific agent name.

### Tests

- `tests/test_skills.py::test_no_skill_requires_full_reread` — asserts the
  *positive* tiering contract is present (three named tiers, each with its
  own verification depth), not just the absence of one banned phrase. The
  current unconditional phrasing ("open each cited file yourself" /
  "open the key files yourself") differs from a naive "read every cited file
  fully" search string — match the real text so the test isn't vacuous.
- `tests/test_skills.py::test_child_return_is_pointer_only` — each fan-out
  skill's child prompt, where `output:` is used, states the pointer-only
  return contract.
- Real measurement is Phase 7: token cost per run, with-skill vs baseline,
  and false-positive rate on the seeded-defect fixture (a finding that
  survives sed-tier verification but wouldn't survive a full read).

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- Run `review-plan` under Pi against
  `meta/plans/2026-09-19-modernize-tui.md`; confirm children are dispatched as
  `reviewer`, and compare total tokens against a pre-Phase-4 run of the same
  plan.

### What we're NOT doing

- Not dropping verification. The discipline is the best thing about these
  skills; this phase makes it cheaper, not optional.
- Not hard-pinning child models in the skill text. Model choice belongs in the
  agent definition (Phase 6) or the user's Pi config, not in prose that has to
  stay portable.

---

## Phase 5 — Progressive disclosure for child-only content

### Overview

Move the rubrics out of SKILL.md into `references/`, so the parent stops
loading content only a child needs. Depends on Phase 1's recursive walk
(references must survive the Codex export — the sibling-only version of
Phase 1 would have missed this directory entirely; the fix already lands in
Phase 1).

Cite by section boundary below, not raw line numbers: Phases 1 and 3 both
edit these files first, so any line range would already have shifted by the
time this phase runs.

One host this phase does not help: Phase 1's recursive walk inlines every
`references/*.md` straight back into the generated Codex prompt, so the
words this phase moves out of `SKILL.md` are not saved on Codex, only
relocated — plus one `## Bundled reference:` heading per file. Codex is a
wash here, not a win; say so rather than letting Phase 5's "drops from
~1046 to under ~750" success criterion imply savings on every host.

### Changes

- `skills/code-quality-audit/references/` — one file per dimension (`solid.md`,
  `dry.md`, `kiss.md`, `typing.md`, `errors.md`, `ddd.md`) — the six
  `**Dimension** — ...` paragraphs between the "## 3. Check each dimension"
  intro and "## 4. Report" (currently `SKILL.md:80-112`; re-locate by those
  headings, not the line numbers, since Phase 3 shifts them first). SKILL.md
  keeps a one-line-per-dimension index and the selection logic; each child is
  pointed at its own file by absolute path.
- `skills/review-plan/references/lenses.md` — the lens table, from the
  `| Lens | Focus |` header through its last row (`| Safety | ... |`),
  currently `SKILL.md:23-37`; stop before the "Architecture, Code Quality..."
  selection-rule paragraph, which SKILL.md keeps ("aim for 4-5") along with
  the child getting the lens definitions.
- `skills/remove-comment-slop/references/examples.md` — the `## Examples`
  section up to (not including) `## Procedure`, currently `SKILL.md:45-79`.
  This skill does not fan out, so the win is smaller; do it only if the body
  is still awkward after the other phases — which, per the Context section's
  close reading, it currently is (one ~90-word paragraph carrying roughly a
  dozen separate directives), so treat this as a real "only if" rather than
  an undecidable one.
- Every reference file over ~300 lines gets a table of contents.

### Tests

- `tests/test_agents.py` coverage from Phase 1 already proves references reach
  Codex; extend it with a multi-reference skill fixture (six dimension files)
  to confirm deterministic ordering.
- `tests/test_skills.py::test_every_reference_is_linked_from_skill_md` —
  exact bidirectional set comparison between `references/*.md` on disk and
  the `references/<file>.md` paths named in SKILL.md — no orphan file, no
  dangling pointer. State the convention explicitly first: SKILL.md always
  writes the path as `references/<file>.md` even though a symlinked SKILL.md
  can't itself contain an absolute path; the Phase 2/3 fan-out block
  absolutises it against the child's own filesystem view at dispatch time.

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- `code-quality-audit` SKILL.md body drops from ~1046 words to under ~750
  without losing any rubric content.
- A Codex run of `code-quality-audit` still applies the SOLID rubric correctly
  from the inlined section.
- Measure the generated `~/.codex/prompts/code-quality-audit.md` size before
  and after this phase: it should not grow beyond the six added
  `## Bundled reference:` headings' overhead (a few dozen words). A larger
  jump means the recursive walk is duplicating content, not just relocating
  it.

### What we're NOT doing

- Not splitting `research-codebase`'s open-question harvest (§5) out. The
  parent is the one that uses it, at write time — moving it saves nothing.
- Not creating a shared cross-skill references directory. Skills are
  independent symlinked directories; a shared parent would not survive the
  symlink into `~/.pi/agent/skills/<name>`.
- Not building selective Codex inlining (a `codex-bundle:` allow-list to skip
  some reference files). The measured overhead above is header-sized, not
  content-sized; revisit only if the manual size check finds otherwise.

---

## Phase 6 — Ship `agents/` definitions and install them

### Overview

The highest-ceiling change, and the only one that extends `agentic-hub` itself.
Pi discovers user agents from `~/.pi/agent/agents/**/*.md` and supports
`model:`, `thinking:`, `tools:`, `output:` and `skills: <name>` — so a
purpose-built agent can load exactly one of these skills, with a pinned cheap
model and a read-only toolset, without touching the parent's context.

**Scoped to Pi for this phase.** Claude Code's agent frontmatter has not been
verified against `thinking:`/`output:`/`skills:`/`defaultReads:` — those are
pi-subagents fields, Claude Code's schema is known to be smaller, and its
`model:` takes aliases (`haiku`/`sonnet`/`inherit`) rather than provider ids.
Symlinking one file into both risks Claude Code silently ignoring every field
that matters (toolset, model, skill attachment — the entire point of this
phase) rather than erroring. Claude Code subagents also cannot spawn further
subagents, so the "prefer the bundled agent, fall back to a packaged one"
ladder can never compose there the way it does on Pi. **Gate this phase
behind the Phase 8 item 3 spike** (`agentScanDirs` pointed at this repo's
`agents/`): if that config line gives Pi the agents with no installer code at
all, this phase shrinks to "generate a Claude-Code-schema subset of the same
definitions" rather than building a second target table from scratch.

This turns Phases 3-5 from prose conventions into enforced configuration
(on Pi; other hosts keep the Phase 2/4 prose ladder).

### Changes

- New top-level `agents/` directory in this repo, Pi-schema first, e.g.:
  - `agents/cq-dimension.md` — `tools: read, grep, find, ls, contact_supervisor`,
    `thinking: high`, `skills: code-quality-audit`, `output: findings.md`.
  - `agents/test-level.md` — same shape, `skills: testing-strategy`.
  - `agents/plan-lens.md` — read-only, `skills: review-plan`.
  - `agents/repo-scout.md` — `model: claude-haiku-4-5`, `thinking: low`,
    read-only, for locate-shaped work.
  Keep `contact_supervisor` on every new agent — the packaged `scout` and
  `reviewer` both have it, and it is a child's only escalation path when it
  hits missing context, which is exactly the failure Phase 3's manual
  criterion watches for.
- `src/agentic_hub/catalog.py` — a `discover_agents()` alongside
  `discover_skills()`, reading `agents/*.md`.
- `src/agentic_hub/agents.py` — a second target table for agent definitions,
  `pi -> ~/.pi/agent/agents/` first (Claude Code added only once the schema
  question above is resolved). Symlink mode, same `is_ours` / conflict /
  stale logic as skills, exposed through the **same monkeypatchable seam**
  (`agents.AGENTS`-shaped) the skills table uses — the existing TUI tests
  drive real installs via `pilot.press("i")`, and without that seam they
  would symlink into the developer's real `~/.pi/agent/agents/` during
  pytest. Codex and OpenCode: skip with a logged reason (OpenCode's agent
  directory is unverified, same caveat as Phase 2).
- `src/agentic_hub/cli.py` and `tui.py` — surface agents as a second section
  or a second row-kind, reusing the existing status grid. This needs real
  changes, not just reuse: `tui.py:79-80,91` iterate a single host table and
  will go ragged with no glyph for agent-only hosts in `STATUS_GLYPHS`;
  `_update_detail` hardcodes `SKILLS_DIR / name / "SKILL.md"` (`tui.py:133`)
  and needs an agent-vs-skill branch; `_run` resolves install targets via
  `list(agents.AGENTS)` (`tui.py:151`) and needs the second table too. Fix
  the row-key collision before this ships: `_selected: set[str]` and
  `add_row(key=name)` key by bare name only, so a skill and an agent sharing
  a name (e.g. a future `code-quality-audit` agent) collide silently in both
  selection and row lookup — a wrong-action bug, not cosmetic. Key rows by
  `(kind, name)` instead.
- Each skill's Phase 2 fan-out block gains a per-skill roster line naming its
  own bundled agent (e.g. `code-quality-audit` prefers `cq-dimension`,
  `review-plan` prefers `plan-lens`) with the same fallback ladder
  (bundled → packaged `scout`/`reviewer` → generic child). This roster is
  **not** part of the byte-identical `### Fanning out` block from Phase 2/3 —
  a per-skill agent name cannot live in a section asserted identical across
  five skills. Keep the ladder logic ("prefer bundled, then packaged, then
  generic") in the shared invariant block; declare each skill's specific
  agent name in one line immediately below it, tested separately.
- Note for later, not built here: `agentOverrides.<agent>.skills` (Phase 8
  item 2) cannot substitute for named per-skill agents, because Phase 4
  routes *both* `review-plan` lenses and `code-quality-audit` dimensions
  through `reviewer` — `agentOverrides` is keyed by agent name, so binding
  `reviewer` to `skills: review-plan` would load the wrong skill into every
  `code-quality-audit` dimension child. Phase 6's distinct-agents-per-purpose
  design is the fix for that, not a simplification of it.

### Tests

- `tests/test_catalog.py::test_discover_agents_finds_md_files`
- `tests/test_agents.py::test_install_agent_symlinks_pi` (Claude Code deferred
  per the gate above)
- `tests/test_agents.py::test_install_agent_skips_codex_and_opencode`
- `tests/test_agents.py::test_install_agent_respects_monkeypatched_table` —
  proves the seam exists before any TUI test can rely on it.
- `tests/test_agents.py::test_install_agent_conflict_stale_missing_dir` — the
  conflict / stale-symlink / missing-target-dir cases the skills path already
  covers, mirrored for agents.
- `tests/test_agents.py::test_agent_and_skill_name_collision_is_distinct` —
  an agent and a skill sharing a name install and remove independently.
- `tests/test_agents.py::test_remove_agent_only_deletes_our_own` — mirrors the
  existing `test_remove_only_deletes_our_own` ownership guarantee, which is the
  safety property that matters most here.
- `tests/test_tui.py::test_agents_appear_as_rows` — extends the existing grid
  tests, and asserts row keys survive a same-name skill/agent pair.
- `tests/test_skills.py::test_fanout_roster_line_present_per_skill` — each
  fan-out skill declares its own bundled-agent name once, outside the
  byte-identical block.

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- `agentic-hub sync`, then `ls -l ~/.pi/agent/agents/` shows the symlinks.
- In Pi, `subagent` with `{action: "list"}` shows the new agents.
- A `code-quality-audit` run dispatches to `cq-dimension` and the child has the
  rubric without the parent inlining it.
- A skill and an agent sharing a name each install/remove correctly in the
  TUI without cross-selecting.

### What we're NOT doing

- Not porting agents to Codex. It has no subagent mechanism; the Phase 2
  serial fallback is the answer there.
- Not shipping Claude Code agent files until its frontmatter schema is
  verified — see gate above.
- Not building a model-selection UI. Model lives in the agent file.
- Not making agents mandatory. Every skill still works with zero agents
  installed, via the Phase 2 ladder.

---

## Phase 7 — Evals

### Overview

Nothing in Phases 2-6 is verifiable by unit test. Without evals this is all
plausible-sounding prompt churn — and the plan never defines "quality" until
now, which is why this phase comes first in sequencing (see PR Strategy),
even though it's numbered last for narrative reasons.

**Quality, defined.** Three checkable properties, not one gameable one.
"Every `path:line` resolves to a real line" is citation *integrity*, and a
report of twenty resolvable citations of twenty non-issues scores 100% on it,
as does a report with zero findings — it is precision-only with no recall
counterpart. Replace it with:

- **Precision** — fraction of reported findings a human reviewer would act on.
- **Recall** — against a small seeded-defect fixture (a repo/plan with known,
  planted issues per skill), fraction the skill actually surfaces.
- **Calibration** — does the report populate its own honesty sections
  ("Explicitly fine", "Explicitly not recommended", strengths) rather than
  reading as either all-findings or all-clear.

Upgrade the mechanical check from "line resolves" to "verbatim excerpt
matches the cited line" — Phase 3's verbatim-excerpt requirement makes this
free. Record raw finding counts alongside the above so a collapse in output
volume (e.g. from Phase 3's `No issues found.` rule going wrong) is visible
rather than hidden inside a precision score.

### Changes

- `evals/<skill>/evals.json` per skill, 2-3 realistic prompts each, following
  the `skill-creator` schema (`id`, `prompt`, `expected_output`, `files`).
- **Baseline capture happens before PR 2, not here** — see PR Strategy; this
  phase's job is to define and run the comparison, not to remember to
  snapshot the pre-change skill after it's already changed.
- Run with-skill and baseline in the same batch, **≥3 repeats each**, report
  median and range, not a single run — a fan-out with a variable number of
  children cannot otherwise distinguish a real delta from noise (one flaky
  citation moves a 3-prompt score by 33 points). Pin model and thinking level
  across both arms so Phase 8 changes don't leak into the Phase 4 comparison.
  Pre-register the pass/fail rule before running, not after seeing results.
- Record per run: uncached-input tokens, cached-read-input tokens,
  output+thinking tokens, wall-clock, and precision/recall/calibration from
  above — split parent vs children, priced by resolved model. A single
  blended token count can't show Phase 8's benefit (it changes price per
  token, not token count) or the caching asymmetry from the Cost model
  section. Prefer, as the cheapest per-run proxy, **count of files fully
  re-read by the parent** — low-variance and directly tracks Phase 4's claim.
- Start with `code-quality-audit` and `testing-strategy` — both give their
  fan-out an unconditional "read every cited file" rule today, so both have a
  real before/after delta once Phase 4 lands. `research-codebase` already
  hedges its verification step ("the **key files**", "read **enough of**
  each cited file") and would show the weakest signal as the first eval; add
  it once the harness is proven on the other two.

### Tests

- `tests/test_evals.py::test_eval_files_parse_and_reference_real_skills` — the
  JSON is well-formed, every eval's referenced skill exists in
  `skills/` (derived from `catalog.discover_skills()`, not a literal in the
  test), fixture files referenced actually exist, ids are unique, prompts are
  non-empty, and any `path:line` in `expected_output` resolves.

### Success criteria

**Automated**
- `uv run pytest -q`

**Manual**
- A with-skill vs baseline comparison exists for `code-quality-audit` and
  `testing-strategy`, ≥3 repeats per arm, showing the token delta from
  Phase 4 (split by cache status) and precision/recall/calibration with no
  regression.

### What we're NOT doing

- Not building an eval runner. Use the host's existing one; this repo stores
  the cases, not the harness.
- Not eval-gating CI. These runs cost money and are run deliberately.

---

## Phase 8 — Tune the Pi host setup

### Overview

Outside this repo (`~/.pi/agent/settings.json`), but the skills' cost
behaviour depends on it. The current settings are:

```json
{
  "packages": ["npm:pi-subagents", "git:github.com/DietrichGebert/ponytail"],
  "theme": "light",
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-5",
  "defaultThinkingLevel": "high"
}
```

There is **no `subagents` block at all**. Two consequences matter, one real
today and one that only bites once Phase 6 ships:

- Every child runs on `claude-sonnet-5`. `docs/models.md:85` — `defaultModel`
  fills any agent without a frontmatter `model`, and none of the packaged
  agents pins one. So `scout`, whose whole purpose is cheap grep-shaped recon
  at `thinking: low`, runs on the same model as `oracle`. Phase 4 routes work
  to `scout`; without this phase, routing to `scout` saves thinking tokens but
  not model cost. **This is the real lever** — see the corrected changes
  below, `agentOverrides.<name>.model` is the field with no frontmatter
  default to compete with.
- Every packaged agent already pins its own `thinking:` in frontmatter
  (`scout` low, `researcher` medium, `reviewer`/`evidence-auditor`/`oracle`/
  `worker` high), so `defaultThinkingLevel: high` at the top level does not
  currently reach any of them undesirably. `subagents.defaultThinking`
  matters once Phase 6 adds custom agents that *don't* pin their own
  `thinking:` — set it then, mapped to the tier the new agent actually
  needs, rather than assuming it changes anything for the packaged six today.

### Changes

**1. Add a `subagents` block with model tiering.** Following the four-tier
routing at `docs/models.md:95-103`, mapped onto the Anthropic provider already
configured:

```json
"subagents": {
  "defaultThinking": "medium",
  "maxThinking": "high",
  "agentOverrides": {
    "scout":            { "model": "claude-haiku-4-5" },
    "evidence-auditor": { "model": "claude-haiku-4-5" }
  }
}
```

`scout` on Haiku 4.5 is the single biggest lever: recon is IO-bound, and it is
the most frequently spawned child across `research-codebase`,
`testing-strategy` and `create-plan`. `maxThinking: "high"` is a cost ceiling —
nothing spawned by these skills should need `xhigh`/`max`. `defaultThinking`
and a `reviewer`/`oracle` thinking override are both dropped from this
example: every packaged agent already pins its own `thinking` in frontmatter
(`scout` low, `researcher` medium, `reviewer`/`evidence-auditor`/`oracle`/
`worker` high), and `docs/models.md:108` scopes `defaultThinking` to agents
*without* a frontmatter value — so it only affects a future Phase 6 agent
that doesn't set its own `thinking:`, not any packaged agent. Setting
`reviewer`/`oracle` to `thinking: high` here would technically replace the
frontmatter value with an identical one — a no-op in outcome. Only the two
`model:` overrides above change anything measurable, because model is the
one field none of the packaged agents pins.

**2. Attach skills to builtin agents instead of writing custom ones.**
`docs/models.md:85` notes `agentOverrides` can set `skills` as well as `model`:

```json
"agentOverrides": {
  "reviewer": { "skills": "review-plan" }
}
```

This does **not** substitute for Phase 6's distinct-per-purpose agents,
though — `agentOverrides` is keyed by agent *name*, and Phase 4 routes both
`review-plan` lenses and every `code-quality-audit` dimension through
`reviewer`. Binding `reviewer` to `skills: review-plan` here would load the
wrong skill into every `code-quality-audit` dimension child. It stays useful
for a 1:1 pairing (e.g. `researcher` ↔ a skill that only ever uses it), just
not as a blanket replacement for Phase 6.

**3. Use `subagents.agentScanDirs` to point Pi at this repo's `agents/`.**
`docs/agents.md:18-24` lists the four agent scopes (builtin, installed
package, user `~/.pi/agent/agents/**/*.md`, project `agents/**/*.md`), and
`docs/agents.md:30` notes extra recursive scan roots are configurable via
`subagents.agentScanDirs`, with fixed user/project agent directories
outranking same-name agents from scan roots. Pointing a scan root at
`~/code/agentic-hub/agents/` gives Pi the Phase 6 agents with one config
line, no symlinks and no installer changes — always current, because it
reads the working tree. **This is the Phase 6 gate**, not just a nice-to-have
(see Phase 6's Overview): evaluate it first, before writing PR 5, since it
may reduce Phase 6 to "Claude Code only" or to nothing at all. Caveat: a
hardcoded `~/code/agentic-hub/agents/` scan root breaks on a clone at a
different path or from a worktree, with no error — either resolve it
relative to wherever this repo actually is, or accept that it is a
personal-machine convenience, not something `agentic-hub sync` can set up
portably.

**4. Enable Pi's native `grep` / `find` / `ls` tools.** `pi --help` lists all
three as "read-only, off by default" — **verify this is actually the current
state before applying anything**, the same scepticism this plan already
applies to OpenCode's unverified agent directory. If the tools are already
on, applying this item shifts the Phase 4 before/after baseline for nothing
and the shift will look like signal. Do this check first, ahead of the
"apply items 1 and 4 early" note below, not as part of it. If genuinely off:
today the parent has only `read`, `bash`, `edit`, `write` — and every search
in these skills goes through `bash`. Native tools are cheaper to call and
return cleaner output than shelled `grep`. Verify the persistent settings key
(the CLI exposes `--tools`; confirm the equivalent in
`docs/configuration.md`) and enable them. This also matters for children:
`scout` and `reviewer` already declare `tools: read, grep, find, ls`, so they
are asking for tools the host may not be surfacing.

**5. Add a `~/.pi/agent/AGENTS.md`.** It does not exist. Global operator
instructions currently live in `~/.claude/CLAUDE.md` (which loads `RTK.md`),
and Pi never reads it. Pi's mechanical RTK rewriting is already covered by
`~/.pi/agent/extensions/rtk.ts`, so nothing is broken — but any *non-RTK*
global preference is silently Claude-only today. Builtin agents set
`inheritGlobalContext: false` (`docs/agents.md:278`), so this affects the
parent only, which is the right scope.

### Tests

Host configuration, so no pytest coverage. Verification is behavioural:

- `subagent` with `{action: "list", capabilities: true}` reports the resolved
  model per agent — confirm `scout` shows Haiku and `reviewer` shows high
  thinking.
- Call `{action: "models"}` first and copy exact `provider/id` strings rather
  than guessing; `docs/tool-reference.md` warns that bare ids resolve only when
  unique.

### Success criteria

**Automated**
- None. This phase touches no repo file.

**Manual**
- `{action: "list", capabilities: true}` shows the intended per-agent model and
  thinking level.
- Re-run the Phase 4 `review-plan` measurement with tiering on; the
  `scout`-heavy skills (`research-codebase`, `testing-strategy`) should show
  the largest drop.
- Settings file still parses and Pi starts cleanly after each edit.

### What we're NOT doing

- Not enabling `fast: true`. `docs/models.md:89-91` restricts the allowlist to
  two OpenAI Codex models; it does nothing on an Anthropic default provider.
- Not changing `defaultModel` for the parent. Sonnet 5 at high thinking is the
  right parent default for synthesis work; only children get tiered down.
- Not adopting the doc's literal example models (`gpt-5.6-luna` and friends).
  The tier *shapes* transfer; the specific ids assume a provider that is not
  configured here.
- Not versioning `~/.pi/agent/settings.json` into this repo. Tempting, but it
  also holds `theme` and changelog state (including e.g.
  `"lastChangelogVersion"`) and is not this tool's concern. **Do** version
  just the `subagents` fragment, e.g. `hosts/pi/settings.subagents.json` in
  this repo, and either merge it into the real settings file on
  `agentic-hub sync` or document the manual merge step — a fresh machine
  running `sync` today gets seven skills correctly linked and a Pi that has
  never heard of the tiering this phase describes, with no error and no
  signal that anything is missing. This is the only mechanism by which this
  phase's changes are detectable or reproducible on a second machine.
---

## PR Strategy

- **PR 1 — Phase 1.** Self-contained bug fix, own tests, no prompt changes.
  Merge first; Phases 5 and 6 depend on references surviving the export.
- **PR 1.5 — Baseline snapshot (hard requirement, not optional).** Before any
  prompt content changes, commit `evals/baseline/<skill>/` — a copy of
  `code-quality-audit` and `testing-strategy` at their current text, plus the
  git SHA they were copied at. Once PR 2 merges, the pre-change prose is
  git-history-only, and a with-skill/baseline comparison is only valid if
  both arms run in the same batch under Phase 7. Write the eval prompts now
  too, even though they don't run for real until PR 6.
- **PR 2 — Phases 2 and 3.** Both are the fan-out contract; splitting them
  would ship a half-contract. Prompt-only plus the content-contract tests.
- **PR 3 — Phase 4.** Prompt-only, but it is the cost claim and deserves its
  own before/after measurement in the description.
- **PR 4 — Phase 5.** Mechanical content move; easy to review as a diff once
  PR 1 has landed.
- **PR 5 — Phase 6.** The only PR touching the data model and the TUI. Largest
  and riskiest; independently revertable without losing Phases 1-5. Do not
  start writing this PR before Phase 8 item 3 (the `agentScanDirs` spike) has
  been evaluated — it may shrink this PR to "Claude Code only", if Claude
  Code's schema even supports it.
- **PR 6 — Phase 7.** Runs the PR-1.5 baseline against the finished state.
- **Phase 8 is not a PR** — it edits `~/.pi/agent/settings.json`, outside this
  repo. Apply items 1 and 4 early: they are two config edits, they make the
  Phase 4 before/after measurement meaningful. Apply item 3 (the
  `agentScanDirs` spike) **before writing PR 5**, not after — it is the gate
  above, not a nice-to-have. Drop the two no-op `agentOverrides.thinking`
  entries from item 1's example block (`reviewer` and `oracle` already pin
  `thinking: high` in their own frontmatter; per `docs/models.md:108`, an
  override only takes effect where it differs from a value already set, so
  these two are inert and would make the measured saving harder to diagnose,
  not larger). Keep the two `model:` overrides (`scout`, `evidence-auditor`
  onto Haiku) — those have no frontmatter default to compete with.

Ordering constraints: 1 before 1.5 before 2 (baseline must predate the first
prompt change). 1 before 5 and 6. 2 before 3, 4 and 6 (they all extend the
fan-out block). Phase 8 item 3 before PR 5 is written (see above). 6 (PR 6,
Phase 7) last, so it measures the finished state against the PR-1.5 baseline
captured up front — not "worth doing", a hard dependency now that baseline
capture has its own PR.


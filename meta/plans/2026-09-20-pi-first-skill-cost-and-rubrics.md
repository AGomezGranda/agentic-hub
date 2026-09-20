---
date: 2026-09-20
title: Four-host skill tuning — host truth, per-host prose, real serial path, better rubrics
status: draft
---

## Context

Follow-on to `meta/plans/2026-09-19-skills-quality-cost-and-subagents.md`
(Phases 1-6 in the working tree, uncommitted; Phases 7-8 unshipped). That
plan's prompt-side work landed. This plan covers what it left, what its open
questions can now answer, and a change of direction on host handling.

### Verification method

There are no evals and there will not be. `evals/` was deleted
deliberately: the feedback loop is the author's own use of the skills, plus
reviewing the cost and quality of the code they generate.

This constrains the plan's shape more than its content. Automated tests here
assert that an edit happened — never that output improved. So:

- **One lever per PR.** A phase that bundles two changes makes the loop
  unusable, because a regression can't be attributed.
- **Every phase states what to notice**, in terms observable from ordinary
  use: cost per run, whether findings got sharper, whether a host stopped
  doing something dumb. These replace the quality claims evals would carry.
- **Every phase states its revert condition** in the same terms.

### Hosts — capability matrix (verified here unless noted)

| Host | Skills | Subagents | Custom agents | State |
|---|---|---|---|---|
| **Pi** (primary) | `~/.pi/agent/skills/` | `subagent` tool, `runs.all`, concurrent (cap 20, 64/run) | 4 scopes, incl. `~/.pi/agent/agents/` | fully capable |
| **Claude Code** | `~/.claude/skills/` | `Agent` tool; children cannot nest (unverified here, same tag as OpenCode) | `~/.claude/agents/` — **does not exist** | built-in agents only |
| **Codex** | `~/.codex/prompts/` (flattened) | none | none | serial only |
| **OpenCode** | `~/.config/opencode/skill/` | unverified | `agent/` dir absent here | installed on other machines |

`which opencode` returns nothing **on this machine**, and
`~/.config/opencode/` holds only the `skill/` directory `agents.py:20`
creates. OpenCode is a live target on the author's other machines, so it
stays in scope — but its subagent capability cannot be verified from here.
This plan therefore treats OpenCode as serial-capable-only until someone
checks on a machine where it runs, and Phase 3 gives it the serial branch
rather than guessing at a fan-out mechanism. Upgrading it later is a
one-file change under Phase 2's structure.

### What the prior plan's open questions now answer

- `runs.all([...])` children run **concurrently**, capped by
  `globalConcurrencyLimit` (default 20), `maxSubagentSpawnsPerRun` 64 —
  `pi-subagents/docs/configuration.md:298-306, 318-326`. The prose says
  "has not been verified".
- OpenCode's agent directory does not exist on this machine. The prose's
  "unverified" is accurate and stays — but it becomes a scoping statement
  in the OpenCode branch rather than a hedge shown to every host.

Re-checked and *not* problems: `scout`, `reviewer`, `researcher`,
`evidence-auditor` all exist under `pi-subagents/agents/`;
`ponytail-review`/`ponytail-audit` exist under the installed ponytail
package. Every agent name the skills reference resolves on Pi.

### Change of direction from the prior plan

Prior Phase 2 made the fan-out block byte-identical across four hosts, so
every host carries all four branches. With all four as live targets that is
the wrong trade in both directions: Pi pays for three branches it cannot
use, and the three weaker hosts get a single apologetic bullet where they
need actual instructions.

**This plan injects the host's branch at install time instead.**
`agents.py` already transforms content per host — `_codex_body` (`:66-96`)
inlines references and prepends a hash marker. Extending that to splice one
host branch is the same machinery, and it is the only approach that serves
four hosts without dead text on any of them.

### The gaps this plan closes

1. **Author's unknowns ship as runtime instructions.** Both hedges above,
   in all five fan-out skills (e.g. `code-quality-audit/SKILL.md:64-67`,
   `:72-74`) — ~60 words × 5, instructing the model to doubt its own
   dispatch mid-task. Both are now answerable.

2. **Recon runs on Sonnet, and the bundled agents are unreachable.**
   `agents/repo-scout.md` pins `model: claude-haiku-4-5`, but
   `tests/test_skills.py:170-177` records the decision to rely on Pi
   *project* discovery — which only reaches `agents/**/*.md` inside this
   repo. That "inside this repo" half is itself unverified: project
   discovery resolves from the nearest parent directory containing `.pi`
   or `.agents` (`pi-subagents/docs/configuration.md:9`), and this repo
   has neither. Phase 1's success criteria settle it with a runtime check
   rather than asserting it here. Everywhere else the ladder falls to
   packaged `scout`, which pins no `model:` and therefore inherits
   whatever `subagents.defaultModel` (or the plain Pi default model) is
   set to — `claude-sonnet-5` on this machine's
   `~/.pi/agent/settings.json`, per the inheritance rule at
   `pi-subagents/docs/agents.md:37`, not a value Pi hardcodes. Prior Phase
   8 never shipped; `~/.pi/agent/settings.json` still has no `subagents`
   block.

3. **The serial path is an apology, not a design.** Codex and OpenCode get
   one bullet: "run the same investigations serially yourself and say so in
   one line." For a six-dimension audit that is the entire instruction.
   Both are real targets and both currently receive the worst version of
   every fan-out skill.

4. **The parent does recon itself, at Sonnet high.**
   `testing-strategy/SKILL.md:27-50` and `code-quality-audit/SKILL.md:110-126`
   are locate-and-inventory work — `repo-scout`'s job — held in the
   parent's context before any fan-out.

5. **`output: findings.md` saves nothing.** Three skills say "treat its
   final message as a pointer only" (`tests/test_skills.py:159-164`), but
   the parent then reads the whole file. The rule is never tied to the
   verification tiers that would make it pay.

6. **Rubrics are too thin; the testing reference is too fat.**
   `code-quality-audit/references/*.md` are 6-8 lines each — and with
   `inheritSkills: false` they are a child's *entire* rubric.
   `testing-strategy/AUDIT_STRATEGY.md` is 450 lines that `SKILL.md:12-16`
   calls mandatory, loaded whole by parent and by every level child needing
   one-sixth of it, and inlined permanently into the Codex prompt.

7. **Severity is meaningless for recon, doubled for review.**
   `research-codebase/SKILL.md:67-83` makes recon children emit P0/P1/P2 for
   "where is X defined", then apologises at `:80-83`.
   `review-plan/SKILL.md:52-56` runs a second vocabulary plus a mapping
   paragraph.

8. **Six of seven descriptions have no anti-trigger**, and `create-plan`
   §1 reimplements `research-codebase`'s fan-out rather than delegating.

## What we're NOT doing

- **No evals, no eval harness, no `evals/` directory.** Deleted
  deliberately; this plan does not reintroduce it under another name.
- **Not pinning models on `cq-dimension`/`test-level`/`plan-lens`.** They
  inherit `claude-sonnet-5` at `thinking: high` already; pinning the same
  value is a no-op. Judgement stays on Sonnet high.
- **Not building the Phase 6 installer for agent definitions** (second
  target table, agent rows in the TUI, `(kind, name)` row keys). The prior
  spike decided against it; Phase 1 closes the gap with one config line.
- **Not reversing the single finding schema for judgement skills.**
  `code-quality-audit`, `testing-strategy`, `review-plan` keep P0/P1/P2.
- **Not shipping Claude Code agent definitions.** `~/.claude/agents/` does
  not exist and Claude Code's frontmatter schema is still unverified
  against `thinking:`/`output:`/`skills:`. Claude Code uses its built-ins.
- **Not dropping OpenCode, and not guessing at its fan-out.** It stays a
  target on all four host tables. Its branch is written serial because that
  is what can be verified from here, not because the host is being retired.
- **Not a blanket prose trim.** Only the blocks named per phase.

---

## Phase 1 — Host truth

### Overview

Configuration and one scope decision. No repo code. Cheapest phase, largest
measurable effect, and Phase 5 is conditional on it.

### Changes

**1a — Pi settings.** `~/.pi/agent/settings.json`, add alongside the
existing keys:

```json
"subagents": {
  "maxThinking": "high",
  "agentScanDirs": ["~/code/agentic-hub/agents"],
  "agentOverrides": {
    "scout":            { "model": "claude-haiku-4-5" },
    "evidence-auditor": { "model": "claude-haiku-4-5" }
  }
}
```

- `agentScanDirs` makes this repo's `agents/*.md` resolve in **every**
  directory, not just this one. Fixed user/project dirs still outrank scan
  roots (`docs/agents.md:30`), so nothing is shadowed.
- `agentOverrides.scout.model` is the one dollar lever: `scout` is the
  most-spawned child, pins no model, and does grep-shaped work at
  `thinking: low` on Sonnet today.
- `defaultThinking` is deliberately omitted — every packaged agent pins its
  own `thinking:`, so it would reach only a future agent that forgets to.

Record the block in `README.md` under a "Pi host setup" heading; the file
itself is outside the repo.

**1b — record what each host can do, in the repo.** OpenCode stays a
target; it runs on other machines and only its subagent capability is
unknown from here. Add a short "Hosts" table to `README.md` carrying the
capability matrix from this plan's Context, so the next person editing a
skill knows which hosts have children and which do not without re-deriving
it. This is the standing answer to the question that produced two hedges in
the prose.

One open item to settle on a machine where OpenCode is installed: whether
it has any subagent mechanism, and whether `~/.config/opencode/agent/` is
read. Until then Phase 3 hands it the serial branch.

### Tests

- None. 1a is outside the repo; 1b is README prose. Existing
  `tests/test_agents.py` coverage of all four hosts stays unchanged.

### Success criteria

**Automated**
- [x] `python3 -c "import json;json.load(open('$HOME/.pi/agent/settings.json'))"`
- [x] `uv run pytest -q`

**Manual**
- [x] `subagent({action:"list"})` run from **outside** this repo lists
      `cq-dimension`, `test-level`, `plan-lens`, `repo-scout`.
- [x] `subagent({action:"list"})` run from **inside** this repo also lists
      them — settling Gap 2's other half: this repo has no `.pi`/`.agents`
      marker, so project-agent discovery reaching `agents/**/*.md` from
      inside the repo is unverified, not assumed.
- [x] `subagent({action:"doctor"})` reports no config errors.
- [x] A `scout` child's run metadata shows `claude-haiku-4-5`.

**What to notice in normal use**
- Research-heavy runs (`research-codebase`, `create-plan`) get cheaper with
  no visible change in answer quality. That is the whole point of this
  phase — recon moving from Sonnet to Haiku.

**Revert if**
- Scout answers get vaguer or start missing files you know exist. Drop the
  `scout` override, keep `agentScanDirs`.

---

## Phase 2 — Per-host prose at install time

### Overview

Replace the four-branch block every host carries with the one branch that
host can act on, spliced by the installer. Serves all four hosts properly
and removes ~186 resident words per skill on Pi.

### Changes

- New `skills/_shared/fanning-out/{pi,claude,codex,opencode}.md` — one file
  per host, each a complete instruction for that host, not a bullet.
  `opencode.md` starts as a copy of `codex.md` (serial) plus a one-line note
  that its subagent capability is unconfirmed; it becomes a real fan-out
  branch the day someone checks on a machine where OpenCode runs. Keeping it
  a separate file rather than aliasing `codex.md` is the point — the upgrade
  is then a one-file edit with no installer change.
- `skills/<name>/SKILL.md` carries a marker where the block goes:

```markdown
### Fanning out

Bundled agent for this skill: `cq-dimension`; fall back to the packaged
`reviewer`, then a generic child, if it isn't installed.

<!-- agentic-hub: fanout -->
```

**Install-mode decision (resolved before this PR is written, not during it).**
`agents.py` today has exactly two modes: `symlink` (one `Path.symlink_to`
for the whole skill directory) and `codex` (one flattened generated file).
Neither represents "part generated, part symlinked." Two ways to get
there:

(a) copy the skill directory per host, then overwrite `SKILL.md` inside
the copy; or
(b) generate only `SKILL.md` as a real file inside the target directory,
and symlink every sibling (`references/*.md`, `scripts/`, `assets/`)
individually into that same directory.

Taking (b): it reuses the Codex marker/hash machinery that already exists
(`is_our_codex_file` / `_codex_marker`) unchanged — just pointed at one
file inside a directory instead of a flat prompt file — instead of
building a second staleness mechanism for (a)'s directory copies (every
reference file would need its own hash check, and a reference edit would
need re-copying, not just re-linking). (b) also keeps references/scripts
truly live for these hosts, with zero divergence possible, since they're
real symlinks, not copies.

- `Mode` gains a third value: `Mode = Literal["symlink", "spliced", "codex"]`.
  Mode is no longer purely a per-host property: it's per `(agent, skill)`.
  A skill without a `<!-- agentic-hub: fanout -->` marker (`implement-plan`,
  `remove-comment-slop`) stays plain `symlink` on every host; one of the
  five fan-out skills is `spliced` on `pi`/`claude`/`opencode` and stays
  `codex` on codex. Add `_effective_mode(agent, name) -> Mode` and route
  `status()`/`install_one()`/`remove_one()` through it instead of the raw
  `AGENTS[agent]` mode.
- `target_path()` is unchanged for `spliced` — it's still the directory
  path; only what's inside differs.
- `install_one()`, `spliced` branch: `tp.mkdir()` (a real directory, not a
  symlink), write `tp / "SKILL.md"` with the marker/hash convention
  (spliced host body, no reference-inlining — Pi/Claude/OpenCode have
  filesystem access to open `references/` themselves; only Codex needs
  everything flattened into one prompt), then symlink every sibling entry
  of `sp` other than `SKILL.md` into `tp` individually.
- `status()`, `spliced` branch: `tp` must be a real directory (not a
  symlink) containing a marker-bearing `SKILL.md` whose hash matches the
  current spliced body (`linked`/`stale`, same rule as Codex); additionally
  check each sibling is still a live symlink to `sp`'s matching entry —
  a missing or non-symlink sibling reports `stale` too, since silently
  serving stale/absent references is exactly the failure Phase 2 exists to
  prevent.
- `remove_one()`, `spliced` branch: unlink `tp / "SKILL.md"` if
  `is_our_codex_file`, unlink every sibling symlink that resolves back into
  `sp`, then `tp.rmdir()` if now empty. Today's `remove_one()` only has
  `symlink`/else branches and would silently no-op on a spliced directory,
  orphaning the generated file — this is the gap the review flagged as the
  most load-bearing finding in this plan.
- `AGENTS` (`:17-22`) gains a per-host fan-out key, one per entry. A
  missing or unreadable branch file is a hard error at install time, not a
  silent fallback — a host installing with no fan-out instructions at all
  is the failure this phase exists to prevent.
- The roster line stays in `SKILL.md`, above the marker — it is per-skill,
  not per-host.

Pi's spliced branch, after Phase 1's answers. A single top-level call that
the parent needs synthesized in the same turn blocks rather than
backgrounds — `async: true` with no `bg_wait`/poll step would return a
receipt before `runs.all([...])` resolves, so this branch omits `async`
entirely (default blocking) rather than asking the model to remember a
wait step that nothing else in the prose mentions:

```markdown
- **Pi** — one `subagent` call with a `workflowScript` dispatching every
  child in a single `await runs.all([...])`, not a loop; the call blocks
  until every child returns, so the result is ready to synthesize in this
  turn. Children run concurrently up to `globalConcurrencyLimit` (default
  20), 64 spawns per run. Packaged fallbacks: `scout` (locate/inventory),
  `reviewer` (read-only judgement), `researcher` (web).
```

### Tests

- `tests/test_skills.py::test_fanout_block_present_and_complete` — rewrite:
  assert the marker and roster line in `SKILL.md`, and that each
  `_shared/fanning-out/*.md` contains the verification rule
  ("lead, not evidence").
- `test_fanout_shared_prose_identical_across_skills` — **delete**. The
  invariant it protected (one wording everywhere) is now structural: there
  is one file per host. Replace with
  `test_every_skill_has_fanout_marker`.
- `FANOUT_START_MARKER`/`FANOUT_END_MARKER` (`:26-27`) — delete; brittle
  substring slicing goes away with them.
- `test_fanout_roster_line_present_per_skill` (`:76`) — keep unchanged.
- New `tests/test_agents.py::test_splice_injects_only_host_branch` — the
  generated Pi body contains the Pi branch and **not** the Codex branch,
  and vice versa.
- New `tests/test_agents.py::test_symlink_host_detects_stale_after_source_edit`
  — the staleness hole this phase opens, closed by test.
- New `tests/test_agents.py::test_mixed_host_directory_status_and_remove`
  — a fixture host directory containing **both** a plain-symlinked skill
  (`implement-plan`, no fanout marker) and a spliced skill
  (`code-quality-audit`) side by side: `status()` reports `linked` for the
  first as a symlink and `linked` for the second as a generated-directory,
  and `remove_one()` on the spliced skill removes its generated `SKILL.md`
  and sibling symlinks, `rmdir`s its now-empty directory, and leaves the
  plain-symlinked skill's symlink completely untouched.

### Success criteria

**Automated**
- [x] `uv run pytest -q`
- [ ] `agentic-hub list` shows `linked` for all skills on all hosts after
      `agentic-hub sync` — true for claude/pi/opencode on this machine;
      codex still shows `conflict` for 5/7 skills, but that predates this
      phase (an older `<!-- agentic-hub: generated, do not edit -->` marker
      with no sha256, present even on `implement-plan`/`remove-comment-slop`,
      which this phase never touches) — not a regression, left unchecked
      because the literal criterion isn't met on this host.
- [x] Editing a `SKILL.md` flips its status to `stale` on every host
- [x] Editing a reference file under a spliced skill flips its status to
      `stale` too (the sibling-symlink check, not just the `SKILL.md` hash)
- [x] `agentic-hub remove <fanout-skill>` leaves no directory behind for
      any host, and leaves a plain-symlinked skill's symlink untouched

**Manual**
- [ ] `grep -c "Claude Code" ~/.pi/agent/skills/code-quality-audit/SKILL.md`
      returns 0 — actually returns 1: `code-quality-audit/SKILL.md:41`
      ("no skill mechanism at all on Claude Code/Codex") is prose outside
      the `### Fanning out` block Phase 2 spliced, in the §1 scope-resolution
      paragraph explaining why a child needs the map pasted in verbatim.
      Accurate, orthogonal to fan-out mechanics, and out of this phase's
      stated scope ("only the blocks named per phase") — left unchecked
      rather than silently rewording prose Phase 2 didn't own.
- [x] The Codex prompt for the same skill contains no `runs.all` reference

**What to notice in normal use**
- Pi stops mentioning other harnesses when deciding how to fan out.
- Codex stops describing machinery it doesn't have.

**Revert if**
- Staleness detection proves unreliable on symlink hosts. Fall back to
  keeping `SKILL.md` symlinked and shipping the host branches as a
  `references/fanning-out.md` read on demand.

---

## Phase 3 — A real serial path

### Overview

Codex has no subagent mechanism and OpenCode's is unconfirmed; both are
live targets, and today each receives one sentence. This phase writes the
serial branch as an actual method. Depends on Phase 2 for somewhere to put
it.

### Changes

`skills/_shared/fanning-out/codex.md` becomes a genuine procedure rather
than a fallback note, and `opencode.md` takes the same content. It must
answer what the Pi branch answers for Pi:

- **Ordering** — which dimension/level first, and why. Cheapest-to-read
  first so early findings inform later reads, rather than the declaration
  order in §3.
- **Context budget** — a serial reader accumulates everything in one
  context. State an explicit budget: finish and record a dimension before
  opening the next one's files, and never hold two dimensions' file sets at
  once.
- **Where verification collapses** — the tiered verification in §4 exists
  because a child's claim is second-hand. Serially, the reader *is* the
  first-hand source. The branch must say so: record evidence as you read,
  and do not re-open files at report time. This is the largest waste on
  Codex today, since the tiers are written for a parent that didn't do the
  reading.
- **What to drop** — a serial run of six dimensions at full depth may not
  fit. Name the degradation order (DDD first where no domain layer exists,
  then KISS, …) rather than letting the model silently truncate.

`claude.md` gets a smaller version of the same treatment: state as
unverified-here, same tag as OpenCode, that children cannot nest, so a
Claude Code parent must not plan a two-level fan-out; and
`Explore` vs `general-purpose` selection should be stated per sub-question
shape. Claude Code keeps its built-in agents — no agent definitions are
shipped for it, per "What we're NOT doing".

`opencode.md` additionally carries the one open question in a form its own
reader can act on: if a subagent mechanism does exist, prefer it and report
back, otherwise proceed serially. That is a scoping instruction for one
host, not the repo-wide hedge Phase 1 removed.

### Tests

- New `tests/test_skills.py::test_serial_branch_states_ordering_and_budget`
  — parametrised over `codex.md` and `opencode.md`: each names an ordering
  rule, a context budget, and the verification collapse.
- New `tests/test_skills.py::test_every_host_has_a_fanout_branch` — every
  key in `agents.AGENTS` has a readable branch file, so adding a host
  cannot silently ship without one.
- New `tests/test_skills.py::test_claude_branch_forbids_nesting`.

### Success criteria

**Automated**
- [x] `uv run pytest -q`

**Manual** (deferred to normal use, per this plan's own no-evals stance —
not fabricated during implementation)
- [ ] A `code-quality-audit` run in Codex on a mid-size repo completes
      without truncating, and states which dimensions it dropped if any.
- [ ] It does not re-open files at report time.
- [ ] Same check in OpenCode, on a machine where it is installed. If that
      run reveals a subagent mechanism, `opencode.md` is rewritten as a
      fan-out branch and this criterion is retired.

**What to notice in normal use**
- Codex and OpenCode output stops being a visibly worse version of the Pi
  output. If a host still feels second-class after this, the limit is the
  host's capability, not the prose — more words will not close it.

**Revert if**
- Nothing to revert; this phase only adds content to one host's branch.

---

## Phase 4 — Rubric quality

### Overview

The phase most likely to change the quality of what the skills produce, on
every host. Independent of Phases 1-3.

### Changes

**4a — fatten the dimension rubrics.** Each of
`skills/code-quality-audit/references/{solid,dry,kiss,typing,errors,ddd}.md`
grows from 6-8 lines to roughly 40-60: the existing definition as the
opening paragraph, then two or three worked pairs in the shape
`remove-comment-slop/references/examples.md` already uses — a short bad
example, a short good one, one line on the consequence that makes it a
finding rather than a preference.

Fold in the severity rule currently only at `code-quality-audit:185-188`
("a DIP violation with one concrete dependency that will never change is a
non-issue"). On Pi that text never reaches a child; on Codex the parent has
it but the rubric file is where it belongs.

Codex-side tradeoff, not a defect: `_bundled_references` inlines every
reference file into the one generated prompt regardless of size, and
Codex has no fan-out to hand a subset to. Growing six files 5-8x roughly
multiplies what that prompt carries (~40-50 → ~240-360 lines). Real cost
on the one host paying it in full every run; worth stating rather than
discovering later.

On Pi/Claude/OpenCode, where a `cq-dimension` child is handed only its own
file, the same growth is pure gain with no matching cost.

**4b's Codex claim, corrected.** `_bundled_references` walks
`skill_dir.rglob("*.md")` and inlines *every* markdown file regardless of
how many files a reference is split into — splitting `AUDIT_STRATEGY.md`
into `overview.md` plus six level files doesn't shrink what a generated
Codex prompt inlines; `_codex_body` still concatenates all seven, at
roughly the same total length plus new per-file headers. The split's real
value is Pi/Claude/OpenCode, where a `test-level` child gets only its own
file — Codex has no fan-out to hand a subset to, so it sees no benefit
from this phase at all beyond the file itself being easier for a human to
edit.

**4b — split the testing reference.**
`skills/testing-strategy/AUDIT_STRATEGY.md` (450 lines) becomes
`skills/testing-strategy/references/`:

| File | Content |
|---|---|
| `overview.md` | §1 anatomy, §7 criticality, vocabulary — ~40 lines, parent reads this |
| `unit.md` … `async.md` | one level each |

`SKILL.md:12-16` changes to read `references/overview.md`; §3 hands each
child the path to its own file. See the corrected Codex claim above —
this split benefits Pi/Claude/OpenCode's fan-out, not Codex's flattened
prompt.

Ship 4a and 4b as separate commits so a quality change is attributable to
one of them.

### Tests

- `tests/test_skills.py::test_every_reference_is_linked_from_skill_md`
  (`:193`) — does the structural work free: every new file linked,
  `AUDIT_STRATEGY.md` gone from the prose once deleted.
- New `test_dimension_rubrics_are_substantive` — each file ≥30 lines with a
  bad and a good example marker.
- New `test_no_reference_file_exceeds_budget` — none over ~120 lines, so
  the 450-line case cannot reappear.
- `tests/test_agents.py` — the Codex prompt for `testing-strategy` still
  contains all six level sections after the split.

### Success criteria

**Automated**
- [x] `uv run pytest -q`
- [x] `test -f skills/testing-strategy/references/overview.md`
- [x] `! test -f skills/testing-strategy/AUDIT_STRATEGY.md`

**Manual**
- [ ] A `cq-dimension` child handed only `solid.md` produces findings with
      concrete consequences, not restated principles.
- [ ] A `test-level` child for `contract` never reads unit or e2e material.

**What to notice in normal use**
- Findings stop reading like textbook definitions and start naming what
  breaks. This is the phase to judge by the quality of the generated
  code review, not by cost.

**Revert if**
- Findings get longer without getting sharper — a sign the examples are
  being pattern-matched rather than reasoned from. Trim to one pair each.

---

## Phase 5 — Move recon off the parent

### Overview

Delegate the mapping steps to `repo-scout`, which Phase 1 has made both
reachable and cheap. **Pi only** — Claude Code has no equivalent cheap
agent, and Codex has no children at all. Conditional on Phase 1; without it
these resolve to Sonnet and the phase saves nothing.

### Changes

`skills/testing-strategy/SKILL.md` before §1's bullets, and
`skills/code-quality-audit/SKILL.md` before §2's:

```markdown
On Pi, dispatch the map before judging it: one `runs.all([...])` of
`repo-scout` children — one per layer, one per boundary class, one for the
test inventory — each returning the evidence schema below. Assemble their
output into the map yourself. Judge nothing at this stage; a scout that
volunteers a verdict is out of contract. Then fan out the level children
with that map pasted into each task.
```

Both keep the existing small-scope escape hatch (`testing-strategy:85-86`).
Never applies to the diff/PR branch, where the parent reads the changed
files regardless.

No change to `agents/repo-scout.md`. An earlier draft of this plan added
`defaultReads: context.md` there; dropped, not fixed — `defaultReads`
reads a *different*, already-written agent's output before this agent
starts (the `worker.md` pattern), and `repo-scout.md` already declares
`output: context.md` as its own artifact. A cold-context scout dispatched
by this phase has nothing upstream to read first; the field would either
no-op or, worse, pick up a stale `context.md` from an unrelated prior run.
Nothing in this flow needs it.

### Tests

- New `test_map_phase_delegates_to_scout` — both skills name `repo-scout`
  in their mapping section, with the judge-nothing constraint, in the text
  inserted before §1's/§2's bullets. This is a new test with its own slice
  of the file, not a change to `test_fanout_roster_line_present_per_skill`
  or `FANOUT_ROSTER`: that test's `_fanout_section`/roster slice starts at
  the `### Fanning out` heading and reads only as far as the `**Pi**`
  bullet immediately under it — well below where this phase inserts text
  — and it names the bundled *judgement* agent (`test-level`,
  `cq-dimension`), a different concept from the *recon* delegation this
  phase adds. Extending `FANOUT_ROSTER` would not be visible to that test
  and would conflate two unrelated rosters.

### Success criteria

**Automated**
- [x] `uv run pytest -q`

**Manual**
- [ ] Recon children run on `claude-haiku-4-5`, level children on Sonnet 5.
- [ ] The resulting service map is no worse than before.

**What to notice in normal use**
- A `testing-strategy` run on a real service costs noticeably less, and the
  map is as good. If the map degrades, this phase loses.

**Revert if**
- The map misses a boundary or misclassifies a layer. Recon quality gates
  this phase outright — revert, don't tune.

---

## Phase 6 — Child return contract

### Overview

Tie the `output:` file rule to the verification tiers, so a finding the
parent will only spot-check never costs a body read. **Pi only in
practice**: the mechanism below is `output:`/`outputMode:` frontmatter on
`agents/*.md`, which only Pi's dispatch reads. Claude Code's children are
its generic built-in `Agent`/`Task` type with no `output:`-file convention
and no shipped agent definitions to attach one to — so this phase has no
enforcement mechanism there, whatever the prose says. Inert on Codex,
which has no children.

**Mechanism fix.** The three target agents
(`cq-dimension`/`test-level`/`plan-lens`) declare `tools: read, grep, find,
ls, contact_supervisor` — no write tool. Per
`pi-subagents/docs/tool-reference.md:174`, a read-only-tool child's
`output:` file *is* its final message, persisted verbatim by the runtime —
there is no channel split available where the file gets the full body and
chat gets a separate short index; whichever text the child writes becomes
both, unless output routing itself changes. Two ways to fix it: give the
three agents a write tool plus explicit "don't touch the repo" scoping, or
keep them read-only and change how output is *dispatched and read*. Taking
the latter — no new tool, no new scoping prompt to get wrong:

- The child's single final message is the whole artifact, ordered index
  first, bodies after — no separate index message. It still goes entirely
  to the `output:` file.
- Whatever dispatches these three agents (Phase 2's Pi branch, or a direct
  `runs.run`/`runs.all`) sets `outputMode: "file-only"`. Per
  `pi-subagents/docs/tool-reference.md:172`, this makes the run's chat
  return a compact pointer (`Output saved to: <path> (N KB, M lines). Read
  this file if needed.`) instead of the full body inline — the actual
  saving this phase is after.
- The parent does its own bounded reads rather than expecting two
  channels: the index is a fixed short prefix of the file (first N lines,
  one per finding), so a spot-check-tier finding is judged from a small
  head-of-file read, never the whole document; a top-tier finding is
  looked up by its heading and only that section is read.

`agents/{cq-dimension,test-level,plan-lens}.md` — replace the reporting
paragraph:

```markdown
Structure your `output:` file as one `## Index` section — one line per
finding, `<severity> <location> — <summary of twelve words or fewer>` —
followed by `## Findings`, one `### <same location>` heading per finding
with the full body, excerpt, and rationale underneath. Write nothing
else; the whole file is your single final message.
```

`skills/{code-quality-audit,testing-strategy,research-codebase}/SKILL.md` —
in the verification sections (`:160-164`, `:209-212`, `:138-141`):

```markdown
Dispatch these children with `outputMode: "file-only"`. Their chat
response is a pointer, not their findings. For a spot-check-tier finding,
read only the `## Index` line — never open the file for it. For a
top-two-tier finding, or one you're carrying into the report, open just
its `### <location>` section by heading, never the file whole. If an
index line is too thin to judge on its own, that is itself the finding.
```

### Tests

- `test_child_return_is_pointer_only` (`:159`) — extend: require
  `outputMode: "file-only"` and a tier reference in the same section.
- New `test_agents_declare_index_then_findings_structure` — each of the
  three agent files' reporting paragraph names both `## Index` and
  `## Findings`.

### Success criteria

**Automated**
- [x] `uv run pytest -q`

**Manual**
- [ ] The parent's chat context shows only the `outputMode: "file-only"`
      pointer for these three agents, never their full output inline.
- [ ] The parent transcript opens the findings file's `### <location>`
      section for top-tier findings, and only the `## Index` prefix for
      spot-check-tier ones — never the file whole either way.

**What to notice in normal use**
- Long audits stop ballooning the parent context mid-run.

**Revert if**
- Index lines prove too thin to act on and the parent ends up opening
  full files for spot-check-tier findings anyway — then this phase is
  pure overhead over just reading the whole file inline as before.

---

## Phase 7 — Schema, severity, descriptions

### Overview

Three prompt corrections sharing a test surface. Last; independent of
everything above.

### Changes

**7a — recon schema.** `research-codebase/SKILL.md:67-83` and the
equivalent in `create-plan` replace P0/P1/P2 with:

```markdown
### Child evidence schema

location: path:line
excerpt: verbatim quoted line(s) with line numbers, not a paraphrase
answer: one paragraph — what this evidence establishes

If a child cannot resolve its sub-question, it says exactly:
`Not found. Searched: <what>. Expected to find: <what>.`
```

Deletes the apology at `:80-83`, aligns with `agents/repo-scout.md`. The
absence line feeds `research-codebase` §5's open-questions harvest, which
needs "what was searched" and cannot use `Solid because:`.

**7b — one severity vocabulary.** `review-plan/SKILL.md` moves children to
P0/P1/P2, deletes the mapping paragraph at `:52-56`. The output template
(`:108-123`) keeps 🔴/🟡/🔵 and critical/major/minor for the reader. Verdict
rule: `REVISE` on any P0 or 2+ P1, `COMMENT` on P2 only, `APPROVE` on none.

**7c — anti-triggers.** A closing "Not …" clause on the six descriptions
lacking one. With boundaries sharp, `create-plan` §1's research fan-out
reduces to one line pointing at `research-codebase` — removing a sixth copy
of the fan-out block.

### Tests

- `SCHEMA_SKILLS` (`:92-97`) splits into `FINDING_SCHEMA_SKILLS` and
  `EVIDENCE_SCHEMA_SKILLS`, each with its own required fields.
- `test_empty_result_sentence_is_structured` (`:110`) splits the same way.
- `test_create_plan_child_prompt_has_contract` (`:126`) — evidence schema.
- New `test_single_severity_vocabulary`, `test_descriptions_have_anti_triggers`.
- `tests/test_catalog.py` — descriptions stay single-line scalars.

### Success criteria

**Automated**
- [x] `uv run pytest -q`
- [x] `agentic-hub list` renders every description with no parse warning

**Manual**
- [ ] "plan a refactor" selects `create-plan`; "how does X work" selects
      `research-codebase`.

**What to notice in normal use**
- The right skill fires more often without you naming it.

**Revert if**
- Nothing; these are independently revertable one-liners.

---

## PR Strategy

One lever per PR, since the feedback loop is use rather than tests.

- **PR 1 — Phase 1.** Pi config plus the README host matrix. Do first: only
  phase with an immediately measurable cost effect, and Phase 5 depends on
  it. Live with it a few days before PR 2 so the cost change is attributable.
- **PR 2 — Phase 2.** Installer change; the only PR that touches
  `agents.py` staleness logic. Alone, because a regression here is silent.
- **PR 3 — Phase 3.** Content-only, on top of PR 2's structure.
- **PR 4 — Phase 4a**, then **PR 5 — Phase 4b.** Separate, so a change in
  finding quality is attributable to rubrics or to the split.
- **PR 6 — Phase 5.** Depends on PR 1.
- **PR 7 — Phase 6.**
- **PR 8 — Phase 7.**

Dependencies: PR 1 → PR 6. PR 2 → PR 3. PR 2 → PR 8 (7c removes a fan-out
block PR 2 restructures). PRs 4, 5, 7 independent.

Judge PR 1 and PR 6 on cost; PRs 4 and 5 on the quality of generated
reviews; PRs 2, 3, 8 on whether a host stopped doing something visibly
dumb. Nothing here is judged by a test passing.

## References

- Prior plan: `meta/plans/2026-09-19-skills-quality-cost-and-subagents.md`
- Prior cost work: `meta/plans/2026-09-19-token-cost-reduction.md`
- Pi docs: `~/.pi/agent/npm/node_modules/pi-subagents/docs/`
- Concurrency: `pi-subagents/docs/configuration.md:298-306, 318-326`
- Agent scopes and model inheritance: `docs/agents.md:18-38`, `docs/models.md`
- Host config: `~/.pi/agent/settings.json`
- Contract tests: `tests/test_skills.py`

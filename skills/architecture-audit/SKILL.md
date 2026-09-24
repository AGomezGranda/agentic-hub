---
name: architecture-audit
description: 'Audit software architecture through two lenses — boundaries (who may talk to whom) and responsibilities (who should own what) — for a repo, a module/bounded context, or a git diff/PR. Use when asked to review architecture, layering, module boundaries, coupling, DDD structure, or whether a change lands in the right place. Not class/function-level design such as SOLID, DRY, typing or error handling inside one module (code-quality-audit), over-engineering (ponytail-review/audit), tests (testing-strategy), security or performance.'
argument-hint: '[repo | path/bounded context | diff/PR ref]'
---

# Architecture Audit

Two questions, one lens each:

- **Boundaries** — *who may talk to whom?* `references/boundaries.md`
- **Responsibilities** — *who should own what?* `references/responsibilities.md`

Testability, drift and ADR compliance are not lenses: testability is a
*consequence* used for severity; declared rules (ADRs, import contracts)
are an *input* both lenses judge against.

**Audit, don't rewrite.** Produce a report. Only change code if the user asks
for that after seeing it.

## Boundary — read this before starting

**Routing rule:** if the correction stays inside one module, it belongs to
`code-quality-audit`, not here. If it moves code between modules, changes
what may import what, or changes who owns a piece of data or an invariant,
it's here. A long class is SRP (there); a package every feature edits is a
god module (here). A swallowed exception is error handling (there); an
ORM exception surfacing in the domain API is a boundary leak (here).

- "More layers/abstraction than it needs" → `ponytail-review`/`ponytail-audit`.
- Test coverage → `testing-strategy`. Security, performance → out of scope.

## 1. Resolve scope

- **Full repo** — build the evidence in step 2, then judge both lenses
  across the module graph. A small repo (a handful of modules) is judged by
  you directly; a large one delegates by module/bounded context when that
  minimises duplicate reads. A repository label alone does not justify
  delegation.
- **Path / bounded context** — judge one area in depth, plus every edge in
  and out of it; don't map the whole repo.
- **Diff / PR** — judge only edges and ownership the change adds, removes,
  or moves: new imports, new cross-module calls, logic landing in a module
  that shouldn't own it. Skip the co-change analysis unless the PR claims to
  fix coupling.

### Fanning out

Bundled agent for this skill: `arch-lens` (takes an explicit bounded scope,
the evidence from step 2, and one or both lenses — see `agents/arch-lens.md`);
if it isn't installed, use a host-native child or do the check yourself.
Each child's task text must carry everything it needs — don't depend on
inherited context: the declared rules, import graph and co-change table from
step 2, the lens rubric pasted verbatim from its `references/<lens>.md` file
(absolute path, not just the lens name), the output/evidence rules from
"Child finding schema" below, and a read-only restriction. Children cannot
run commands, so you compute the graph and co-change data and paste them.
Cross-module edges between two delegated areas belong to you, not either
child. Wait for all before synthesizing the report.

<!-- agentic-hub: fanout -->

### Child finding schema

Every child — and every lens you check yourself — reports findings in this
shape, one block per finding:

```
finding ID: <stable ID, unique per finding even at the same location>
severity: P0 | P1 | P2
confidence: high | medium | low
lens: boundaries | responsibilities
location: path:line
excerpt: verbatim quoted line(s), not a paraphrase
evidence: the graph edge, co-change stat, or declared rule it rests on
violated contract: the declared or inferred rule broken
consequence: concrete change/correctness effect if left as-is
counterevidence considered: what was checked that could disprove it
correction: smallest sufficient change
finding: one paragraph — what's wrong and why it matters
strengths: optional — what's solid here, not just what's wrong
```

Keep each block compact. If a child has nothing to report, it says exactly:
`No issues found. Checked: <what>. Solid because: <one line>.` If a child's
output doesn't parse into this shape, normalise recoverable fields; request
one targeted correction if needed. If still unusable, report an
investigation failure with its uncovered scope. Never manufacture a defect
or severity from missing formatting. Do not retry in a loop.

## 2. Gather evidence before judging

Judge nothing at this stage — record, don't rank. Ask a `repo-scout` for the locate-shaped parts
(where declared rules live, what the top-level modules are), or gather them
yourself for a small scope. Then collect, running commands yourself:

1. **Declared architecture** — ADRs (`docs/adr/`, `adr/`, `decisions/`),
   import contracts (`.importlinter`, `[tool.importlinter]`,
   `.dependency-cruiser.*`, ArchUnit tests, Nx/eslint boundary rules),
   README/CONTRIBUTING layering sections. Record each rule verbatim with
   `file:line`. If a checker is configured, run it — its failures are
   pre-confirmed boundary findings. None found → say so; you'll infer rules
   from the dominant structure and mark those findings lower confidence.
2. **Import graph** — module-level edges, using an installed tool when
   present (`import-linter`, `pydeps`, `madge`, `dependency-cruiser`,
   `go list -deps`) or a grep of import statements otherwise — normalised to
   the module level, keeping only internal edges (drop stdlib and
   third-party imports). Summarise as module → module edges with counts;
   list cycles.
3. **Co-change table** (full repo or bounded context only) — which module
   pairs change together:

   ```bash
   git log --since=12.months --no-merges --name-only --pretty=format:@@ -- <scope> \
     | awk -v d=1 'function flush(a,b){for(a in m)for(b in m)if(a<b)c[a" <-> "b]++; split("",m)}
       /^@@/{flush();next} NF{k=$0; if(split($0,p,"/")>d){k=p[1]; for(i=2;i<=d;i++)k=k"/"p[i]} m[k]=1}
       END{flush(); for(k in c)print c[k], k}' | sort -rn
   ```

   Prints `<commits> <module> <-> <module>`; set `d` to the path depth of
   the repo's modules (e.g. `d=2` for `src/<module>/`). A pair co-changing in a large share of either
   module's commits is a change-locality lead; a pair that never co-changes
   despite a dependency edge is evidence the boundary holds.
4. **Domain vocabulary** — what the core concepts are called in code vs.
   docs/tests, and whether a domain layer exists at all. A CRUD app with no
   invariants has no aggregate findings; say so.

For a diff/PR, this step is just: the declared rules, and the imports and
calls the diff adds or removes.

## 3. Judge each lens

Read the lens rubric (or paste it to a child per §1) and apply it to the
evidence. Declared-rule violations first — they are highest confidence and
don't depend on taste. Inferred-rule findings must name the dominant pattern
they deviate from and how many modules follow it.

## 4. Report

Verify before writing — a child's `path:line` claim is a lead, not evidence:

- **A finding a top-line recommendation rests on** — read the full files on
  both sides of the edge; a boundary claim needs both modules' contracts.
- **A corroborating finding** — a targeted `sed -n 'X,Yp'` / `grep -n`.
- **Everything else** — spot-check.

State the tier per finding. Candidate summaries and indexes are a
navigation aid only; before publishing, inspect the rationale and enough code, config
or history to establish the claim. Expand reads when the contract is
unclear; whole-file rereads are not automatically required. A checked
quotation alone is insufficient. Keep an internal disposition per candidate:
confirmed, rejected, or unresolved. Only confirmed findings enter the list;
unresolved ones name the missing evidence and next probe; don't publish
rejected candidates.

1. **Scope and declared architecture** — what was audited, which rules were
   declared vs. inferred, whether a domain layer exists.
2. **Findings** — confirmed findings ranked by severity, then
   consequence/confidence, each with finding ID, lens, severity, confidence,
   location and evidence, violated contract, consequence, counterevidence
   considered, and smallest sufficient correction. State effort separately.
3. **Explicitly fine** — boundaries/ownership checked and found solid, one
   bounded line each with evidence (e.g. "domain has zero imports from
   infra: graph shows no edge").
4. **Out of scope, flagged anyway** — code-level, security, performance or
   over-engineering issues spotted along the way; point at the right skill.
5. **Coverage ledger and unresolved** — each in-scope module × lens as
   checked, not applicable (with reason), or unverified (with reason). An
   unverified area is never described as clean. Say what was sampled or
   excluded (e.g. co-change skipped for a PR).

## Judgement rules

- **Every finding rests on evidence a second auditor would reproduce**: a
  graph edge, a co-change count, a declared rule, a `path:line`. Advice that
  would read the same for any repo is not a finding.
- **Severity is consequence-based.** P0 = rare: an invariant bypass or
  ownership break causing incorrect data or behaviour in production now
  (a cycle or layering break alone is never P0); P1 = boundary or ownership break that makes the affected
  change non-local or lets an invariant be bypassed; P2 = material,
  nonblocking structural improvement. A layering "violation" with no
  consequence is not a finding. Confidence is independent of severity.
- **One finding per defect**, filed under the lens its correction belongs
  to: reading another module's internals/storage = boundaries; writing
  another module's state = responsibilities.
- **Systemic problems are grouped once** with representative instances and
  scope. Consistency does not excuse a harmful pattern.
- **Don't invent a violation to fill a lens.** A small service with three
  modules and clean edges gets an empty findings list and says why.

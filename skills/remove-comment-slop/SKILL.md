---
name: remove-comment-slop
description: 'Compress verbose comments and docstrings in Python code under src/ and tests/: turn multi-line explanations into one concise line wherever possible, while deleting narration and preserving essential rationale. Use when asked to simplify, shorten, de-verbose, or remove noisy comments or docstrings, including PR, Jira, ticket, or work-item references such as ABC-XXX. Not general code quality review (code-quality-audit) or changes to logic/behavior.'
argument-hint: '[optional paths or cleanup constraints]'
---

# Remove Comment Slop

Clean comments in `src/` and `tests/` while preserving program behavior exactly.

## Scope

- Work only in `src/` and `tests/` unless the user explicitly names other paths via `$ARGUMENTS`.
- If `src/` or `tests/` do not exist, list top-level directories (`ls -1`) and adapt to the repo's actual layout (e.g. `app/src`, `services/*/src`, `packages/*/src`); ask the user to confirm when ambiguous.
- Target Python comments and prose docstrings, including trailing comments and comments inside tests.
- Do not edit ordinary string literals, identifiers, configuration, generated files, or documentation unless explicitly requested.
- Treat user-provided paths or constraints as narrower overrides of the default scope.

## Comment Standard

The primary goal is **compression**: preserve useful meaning while reducing
comment prose to the fewest clear words. A necessary five-line explanation
should usually become one line, not survive unchanged merely because its
rationale is valid. Delete comments only when they add no durable information.

For every comment or prose docstring, choose in this order:

1. **Delete** it if the code already says it.
2. **Compress** it if it contains useful rationale, constraints, or contract
	information. Target one line; use two only when one line would lose a
	distinct necessary fact.
3. **Keep unchanged** only when it is already concise or its exact text is a
	required directive, legal notice, protocol quotation, or externally defined
	contract.

Compression is substantive editing, not line joining. Remove scene-setting,
history, examples, repetition, hedging, and justification scaffolding; retain
the single fact a future maintainer needs. Prefer a direct sentence or phrase,
not headings, bullet lists, notes, or paragraphs.

Ticket/PR references are one common form of slop, not the target. Apply the
same compression to all verbose comments, including technically valid and
necessary ones.

Ticket pattern (used throughout): `[A-Z]+-[0-9]+`, `PR #[0-9]+`, `GH-[0-9]+`.

Keep a comment only when it adds information the code cannot express clearly:

- why a non-obvious constraint or workaround exists
- an external invariant, protocol rule, or operational hazard
- a necessary type-checker, linter, coverage, or tooling directive
- a concise explanation of intentionally surprising behavior
- legal, copyright, license, or `SPDX-License-Identifier` headers at the top of files — never remove these, even if they contain a ticket-like string; if unsure whether a header is legal, keep it and flag it
- a concise contract docstring for a public module, class, function, or method describing its responsibility, contract, or usage — prefer one sentence; keep a short paragraph only when the contract has multiple irreducible parts

Remove or simplify comments that:

- narrate the next statement or restate names and control flow
- use headings, filler, conversational phrasing, rhetorical asides, or implementation diary language
- over-explain straightforward setup, assertions, mocks, fixtures, or data transformations
- describe what was changed rather than why the current code exists
- refer to a PR, Jira ticket, work item, branch, review, migration task, or temporary implementation history, or contain a ticket pattern match
- speculate, make unsupported claims, or promise future cleanup
- use `TODO`/`FIXME` for vague, stale-looking, or unactionable prose (keep concise ones describing a concrete, still-actionable task with no ticket-history dependency)
- are commented-out code (`# x = foo()`) where git history already preserves the previous implementation — remove unless it's an intentional illustrative example in documentation or a test fixture

Do not treat "necessary" as "already concise." Rewrite long rationale even
when every sentence is accurate. Preserve the conclusion, constraint, or
hazard; discard the argument used to arrive there unless that argument is
itself required to apply the code safely.

When a ticket-linked comment contains essential rationale, drop the ticket/history reference and keep only the durable technical reason, worded as short as possible.

## Examples

Worked good/bad pairs for each rule above: `references/examples.md`.

### Fanning out

For a scope spanning enough independent files to justify the overhead,
partition the inventory into disjoint file groups and dispatch all groups
together. Never assign the same file to multiple children. Keep a small scope
in the parent.

Bundled agent for this skill: `comment-compressor` (takes an explicit disjoint
file set and returns exact read-only proposals; see
`agents/comment-compressor.md`); if it isn't installed, use a host-native
read-only judgement child or do the review yourself.

Each child's task must include its exact file list, the Comment Standard above,
the absolute path to `references/examples.md`, and the Child proposal schema
below. Children inspect and propose; they never edit. The parent remains the
sole writer, verifies every proposal against nearby code, applies accepted
changes, and checks complete coverage after collecting all results. A child's
proposal is a lead, not authority.

<!-- agentic-hub: fanout -->

### Child proposal schema

Group proposals by file and return one block per change:

```
path:line
action: delete | compress
before: <verbatim complete comment or docstring>
after: <exact replacement, or empty for deletion>
reason: <one sentence naming the redundancy and retained fact>
```

End with `## Coverage`: files inspected, before/after prose line counts, and
any retained multi-line prose with the specific reason it cannot be shorter.
If no changes are needed, say `No changes proposed. Checked: <files and
counts>.` Never omit a scoped file silently.

## Procedure

1. Check the worktree and preserve all pre-existing user changes. Run `git status --porcelain` and `git diff --stat` to record the baseline; do not stash, discard, or overwrite untracked changes. If the worktree is dirty, report the dirty paths and proceed only on scoped files without touching unrelated edits. Do not create a branch or commit; leave all cleanup unstaged for user review.

2. Inventory all comments and prose docstrings in scope, not only ticket or
	`TODO` matches. Use language-aware tooling where available; for Python,
	combine `tokenize` for comments with `ast` for docstrings. Search ticket and
	verbosity markers as an additional signal, e.g. `grep -rnE
	'([A-Z]+-[0-9]+|TODO|FIXME|PR #[0-9]+|GH-[0-9]+)' src/ tests/`. Read nearby
	code before deciding whether prose is redundant, and do not mistake `#`
	inside strings for comments.

3. If the inventory is large and naturally separable by file, fan out the
	read-only review as described above. Dispatch all disjoint groups together,
	wait for every result, and reconcile their coverage before editing. Otherwise
	review directly.

4. Review every candidate in nearby context and classify it as delete,
	compress, or keep per the Comment Standard. Pay special attention to blocks
	of two or more comment lines and multi-paragraph docstrings: if useful, first
	state their essential fact in one sentence, then verify that removing the
	remaining prose loses no operationally relevant information. For docstrings,
	keep only the contract sentence(s), not an implementation walkthrough. When
	using child proposals, verify the complete `before` text and nearby code
	before accepting the proposed `after` text.

5. Make comment- and docstring-prose-only edits. Do not reorder code, rename symbols, change imports, refactor, or modify executable expressions. If removing a comment leaves a double blank line, collapse to one; if a docstring becomes empty, remove the `"""` block and leave a single blank line. Preserve functional directives (`# noqa`, `# type: ignore`, `# pyright: ignore`, `# isort: skip`, `# pragma`, `# fmt:`, `# pragma: no cover`, `# nocov`), shebangs (`#!`), encoding cookies (`# -*- coding:`), and legal headers — remove prose attached to a directive only when the directive stays valid and unambiguous.

6. Re-run the step-2 inventory and inspect the full diff: every changed line
	must be comment/docstring prose, its deletion, or the blank-line collapse
	from step 5. Compare before/after prose line counts and review every retained
	multi-line comment block: each must contain multiple irreducible facts, not
	merely readable prose. Restore any accidental code or formatting change
	without disturbing pre-existing edits. If a change can't be proven
	prose-only, stop and flag it instead of proceeding.

7. Run validation scoped to the edit: comment/docstring-prose changes need
only the project's lint/format checks (e.g. `uv run ruff check`, `uv run ruff
format --check`). Run the broader test suite only when the cleanup touches
docstrings consumed at runtime, unusually broad areas, or the user requests
full validation. Discover commands from `CLAUDE.md`, `Makefile`,
`pyproject.toml`, `package.json`, or `./go`; run only those that exist and
note any that are missing.

8. Report the paths cleaned, before/after comment and docstring prose line
	counts, validation results, and any intentionally retained verbose or
	flagged comments with their reason (required exact text,
	stale-but-unverifiable, ticket text inside executable data/test
	expectations, generated/vendored code skipped, etc.). If more than ~50
	files were touched, summarize by directory/count with notable examples.

## Decision Rules

- If removing a comment makes intent unclear, compress it to the shortest
	statement that preserves the non-obvious fact — do not leave the original
	paragraph or refactor code to avoid the comment.
- Never touch a ticket reference that is part of executable data, a test expectation, or a user-visible value.
- Skip generated or vendored code under the scoped directories and report the exclusion.

## Completion Criteria

- No removable or compressible slop remains in scope. Necessary comments and
	docstrings are concise, usually one line, and retained multi-line prose has a
	specific reason it cannot be shorter. Legal headers and public-API contracts
	are intact.
- Program logic and test behavior are unchanged, and the diff has been inspected to confirm it.
- Selected validation commands pass, or failures are reported separated from pre-existing issues.

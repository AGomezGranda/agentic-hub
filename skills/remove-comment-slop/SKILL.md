---
name: remove-comment-slop
description: 'Remove AI-generated comment and docstring slop from Python code in src/ and tests/. Use when asked to clean up, simplify, de-verbose, or remove noisy comments or docstrings; eliminate PR, Jira, ticket, or work-item references such as ABC-XXX from prose; or make comments concise without changing logic. Not general code quality review (code-quality-audit) or changes to logic/behavior.'
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

Ticket pattern (used throughout): `[A-Z]+-[0-9]+`, `PR #[0-9]+`, `GH-[0-9]+`.

Keep a comment only when it adds information the code cannot express clearly:

- why a non-obvious constraint or workaround exists
- an external invariant, protocol rule, or operational hazard
- a necessary type-checker, linter, coverage, or tooling directive
- a concise explanation of intentionally surprising behavior
- legal, copyright, license, or `SPDX-License-Identifier` headers at the top of files — never remove these, even if they contain a ticket-like string; if unsure whether a header is legal, keep it and flag it
- a concise contract docstring for a public module, class, function, or method describing its responsibility, contract, or usage (one short paragraph) — trim verbosity but keep the contract

Remove or simplify comments that:

- narrate the next statement or restate names and control flow
- use headings, filler, conversational phrasing, rhetorical asides, or implementation diary language
- over-explain straightforward setup, assertions, mocks, fixtures, or data transformations
- describe what was changed rather than why the current code exists
- refer to a PR, Jira ticket, work item, branch, review, migration task, or temporary implementation history, or contain a ticket pattern match
- speculate, make unsupported claims, or promise future cleanup
- use `TODO`/`FIXME` for vague, stale-looking, or unactionable prose (keep concise ones describing a concrete, still-actionable task with no ticket-history dependency)
- are commented-out code (`# x = foo()`) where git history already preserves the previous implementation — remove unless it's an intentional illustrative example in documentation or a test fixture

When a ticket-linked comment contains essential rationale, drop the ticket/history reference and keep only the durable technical reason, worded as short as possible.

## Examples

Worked good/bad pairs for each rule above: `references/examples.md`.

## Procedure

1. Check the worktree and preserve all pre-existing user changes. Run `git status --porcelain` and `git diff --stat` to record the baseline; do not stash, discard, or overwrite untracked changes. If the worktree is dirty, report the dirty paths and proceed only on scoped files without touching unrelated edits. Do not create a branch or commit; leave all cleanup unstaged for user review.

2. Search the scoped paths for comments, docstrings, ticket patterns, and verbosity markers, e.g. `grep -rnE '([A-Z]+-[0-9]+|TODO|FIXME|PR #[0-9]+|GH-[0-9]+)' src/ tests/` (adjusted for the adapted scope). Read each file to distinguish real `#` comments and trailing comments from `#` inside strings; when ambiguous, use `python -m tokenize` / `ast` to verify.

3. Review each candidate in nearby context before editing. Classify it as remove, simplify, or keep per the Comment Standard. For docstrings, keep the contract sentence(s) and trim narration.

4. Make comment- and docstring-prose-only edits. Do not reorder code, rename symbols, change imports, refactor, or modify executable expressions. If removing a comment leaves a double blank line, collapse to one; if a docstring becomes empty, remove the `"""` block and leave a single blank line. Preserve functional directives (`# noqa`, `# type: ignore`, `# pyright: ignore`, `# isort: skip`, `# pragma`, `# fmt:`, `# pragma: no cover`, `# nocov`), shebangs (`#!`), encoding cookies (`# -*- coding:`), and legal headers — remove prose attached to a directive only when the directive stays valid and unambiguous.

5. Re-run the step-2 search and inspect the full diff: every changed line must be comment/docstring prose, its deletion, or the blank-line collapse from step 4. Restore any accidental code or formatting change without disturbing pre-existing edits. If a change can't be proven prose-only, stop and flag it instead of proceeding.

6. Discover and run validation per project: check `CLAUDE.md`, `Makefile`, `pyproject.toml`, `package.json`, and `./go` for lint/format/type-check/test commands (e.g. `uv run ruff check`, `uv run ruff format --check`, `uv run mypy`, `uv run pytest`, `./go app.lint.check`, `make lint`). Run only those that exist; note any that are missing. Run broader repository tests when the cleanup touches unusually broad areas or the user requests full validation.

7. Report the paths cleaned, validation results, and any intentionally retained or flagged comments with their reason (stale-but-unverifiable, ticket text inside executable data/test expectations, generated/vendored code skipped, etc.). If more than ~50 files were touched, summarize by directory/count with notable examples.

## Decision Rules

- If removing a comment makes intent unclear, shorten it instead — do not refactor code to avoid the comment.
- Never touch a ticket reference that is part of executable data, a test expectation, or a user-visible value.
- Skip generated or vendored code under the scoped directories and report the exclusion.

## Completion Criteria

- No removable slop remains in scope; retained comments/docstrings are concise, durable, and non-obvious; legal headers and public-API contracts are intact.
- Program logic and test behavior are unchanged, and the diff has been inspected to confirm it.
- Selected validation commands pass, or failures are reported separated from pre-existing issues.

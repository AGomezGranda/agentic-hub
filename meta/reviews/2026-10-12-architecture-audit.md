# Architecture audit — 2026-10-12

One confirmed P1 responsibility finding: source validity is checked by the CLI rather than guaranteed by the shared installer. A stale TUI selection can therefore produce a dangling skill link while reporting success. No boundary findings were confirmed.

## Scope and declared architecture

Audited the current working tree, including staged and unstaged changes, against HEAD `d20335b`. Read every production Python file in full: `catalog`, `agents`, `coach`, `cli`, `tui`, and the empty package initializer. Checked the Markdown installation pipeline, packaged coaching profile, configuration, relevant tests, and twelve months of available history. This is a repository audit, not just a review of the pending coach changes. No application code was changed.

Declared rules:

- [README.md:192](../../README.md#L192): “Skills live in `skills/<name>/SKILL.md` (optional YAML-ish frontmatter, flat `key: value` pairs only).”
- [README.md:193](../../README.md#L193): “`agentic_hub/catalog.py` reads sources, `agentic_hub/agents.py` writes agent targets, `agentic_hub/cli.py` wires the CLI, `agentic_hub/tui.py` is the Textual status grid.”
- [README.md:178](../../README.md#L178): “Shared workflow contracts stay in the skill body; host dispatch and output mechanics stay in `skills/_shared/fanning-out/<host>.md` and are spliced in at install time — common prose carries no host-specific commands.”
- [README.md:71](../../README.md#L71): “Install and sync finish all targets, then exit 1 if any requested installation fails, including unknown skill names.”
- [README.md:93](../../README.md#L93): “Coaching is independent of skills: install, remove, and sync never toggle or refresh it.”
- [Coach plan:54](../plans/2026-10-12-coding-coach-toggle.md#L54): “Add `src/agentic_hub/profiles/coding-coach.md` as the single authored source, and `src/agentic_hub/coach.py` for target resolution, owned-block updates, and status inspection.”
- [Coach plan:60](../plans/2026-10-12-coding-coach-toggle.md#L60): “Both frontends call `coach.inspect()` and `coach.set_enabled(enabled)`. Each returns a dictionary keyed by the existing `agents.AGENTS` names.”

No ADR directory, import-linter contract, or other architecture checker was found. Ruff and Pyrefly are configured, but neither declares an application layering contract here.

The dominant direction is presentation → filesystem operations/source catalog, with no dependency back into presentation. Both of the two frontends delegate skill and coach writes to their respective owners. The inferred ownership rule is that successful installation must be validated by the shared operation that mutates targets, rather than depend on each frontend's earlier discovery snapshot.

There is no separate domain layer. The core vocabulary is skill names, host/agent names, installation modes and statuses, owned generated content, instruction candidates, coaching profiles, and effective versus shadowed instruction files. This is a filesystem utility; rich domain entities or aggregate layers are not warranted. Its relevant invariants concern valid installation sources and ownership of persisted files.

## Import graph

AST inspection included function-local imports. Counts are import occurrences per internal module edge, not call counts.

| Importing module | Imported module | Count | Location |
|---|---|---:|---|
| `agents` | `catalog` | 1 | `agents.py:6` |
| `coach` | `agents` | 1 | `coach.py:11` |
| `cli` | `agents` | 1 | `cli.py:9` |
| `cli` | `catalog` | 1 | `cli.py:9` |
| `cli` | `coach` | 1 | `cli.py:9` |
| `cli` | `tui` | 1 | `cli.py:138`, function-local launch import |
| `tui` | `agents` | 1 | `tui.py:23` |
| `tui` | `catalog` | 1 | `tui.py:23` |
| `tui` | `coach` | 1 | `tui.py:23` |

Nine edges; no cycles, including function-local or annotation-only cycles. `catalog` has zero internal imports. Neither `agents` nor `coach` imports a frontend or Textual. Production callers do not use another module's underscore-prefixed functions or `_File` representation.

## Co-change evidence

Only three non-merge commits touched Python production modules in the twelve-month window. Per-module commit counts: `agents` 3; `catalog`, `cli`, and `tui` 2 each; empty `__init__` 1. `coach` is new in the working tree and has no committed history.

| Pair | Shared commits | Share of each module's commits |
|---|---:|---|
| `agents` ↔ `catalog` | 2 | 2/3; 2/2 |
| `agents` ↔ `cli` | 2 | 2/3; 2/2 |
| `agents` ↔ `tui` | 2 | 2/3; 2/2 |
| `catalog` ↔ `tui` | 2 | 2/2; 2/2 |
| `catalog` ↔ `cli` | 1 | 1/2; 1/2 |
| `cli` ↔ `tui` | 1 | 1/2; 1/2 |
| `__init__` ↔ each other historical module | 1 per pair | 1/1; 1/3 for `agents`, otherwise 1/2 |

Sampled `63a57e3` (initial application setup), `427cd9c` (host-specific skill generation, frontmatter handling, and grid presentation), and `4d67abb` (Codex native-skill target migration and formatting). The latter two explain their shared changes without demonstrating repeated misplaced ownership. These counts are too sparse and dominated by initial setup to establish shotgun surgery or a god module. The finding below rests on an executed caller scenario, not on co-change percentages.

## Confirmed finding

### ARCH-001 — installer validity depends on the frontend

- **Severity:** P1.
- **Confidence:** high for the reproduced failure and its cross-module ownership cause. The general ownership rule is inferred, supported by the declared separation and installation-failure contract.
- **Lens:** responsibilities.
- **Primary location:** [cli.py:63](../../src/agentic_hub/cli.py#L63); affected owner [agents.py:312](../../src/agentic_hub/agents.py#L312) and alternate caller [tui.py:444](../../src/agentic_hub/tui.py#L444).
- **Verification tier:** top-line recommendation; full files on all sides read, followed by an assertion-based reproduction through the actual headless TUI.
- **Effort:** small; a shared installer precondition and focused regression checks. No new layer or dependency is needed.

Verbatim evidence:

```python
# cli.py:63, 68–70
known = catalog.discover_skills()
if name not in known:
    log.warning("skip: unknown skill '%s'", name)
    continue

# agents.py:130–132
except FileNotFoundError:
    has_marker = False
return "spliced" if has_marker else "symlink"

# agents.py:329, 333
tp.symlink_to(sp, target_is_directory=True)
return True

# tui.py:444
names = sorted(self._selected) if self._selected else [name]
```

**Finding:** The CLI owns the decision that a requested skill must exist in the source catalog, while `agents.install_one()` owns the target mutation without enforcing that precondition. The TUI uses retained selections instead of the CLI's membership check. If a selected source disappears, `_effective_mode()` treats its missing `SKILL.md` as a plain symlink installation and the installer can create a link to a nonexistent directory. The result is counted as a successful installation. Adding checks separately to each frontend leaves the same operation with different guarantees depending on its caller.

**Evidence and violated contract:** `cli → agents` and `tui → agents` each have one import edge and both invoke `install_one`. The declared contract treats unknown-source installations as failures; the inferred shared-operation contract is that the writer guarantees the validity of a successful installation. That guarantee currently resides in one caller's discovery snapshot. All four current hosts use the symlink base mode and can take the missing-source fallback.

**Reproduction:** With two uninstalled skills, `alpha` and `beta`, select `alpha` with Space. Move `skills/alpha` outside the source catalog while the TUI remains open. Refresh with Ctrl+R, leaving `beta` visible. Press `i`. The retained selection still contains `alpha`, so the TUI installs that vanished skill.

An isolated temporary-directory probe executed this sequence with one temporary symlink-mode host and asserted all four observations:

1. Refresh leaves `beta` visible and `alpha` selected.
2. The installer creates `targets/alpha` as a symlink whose target does not exist.
3. `agents.status(host, "alpha")` returns `linked`.
4. The TUI reports `installed (1/1)`.

**Consequence:** A user receives success for an unusable skill installation. Source validity changes require coordinating caller behavior because the mutation owner does not guarantee it. P1 reflects a presently bypassable installation precondition; there is no evidence of a P0 data-loss consequence.

**Counterevidence considered:** CLI install rejects unknown names and normal TUI selection starts from discovered skills. Those facts prevent the ordinary unknown-name case but do not invalidate the reproduction: `refresh_grid()` updates visible names without pruning `_selected`, and the source can also disappear after a CLI discovery snapshot. Valid-source symlink installation works as intended. Missing-source removal serves a different purpose and does not justify successful missing-source installation.

**Smallest sufficient correction:** Make `agents.install_one()` validate that the requested name is a current catalog skill before creating directories or changing targets. Reuse `catalog.discover_skills()` and the existing failure/exception contract. Frontends can keep early checks for useful messages, but correctness must come from the shared operation. Verify that a vanished source fails without creating a target and that a batch still processes valid skills. A TUI-only selection cleanup would fix this sequence without repairing the operation's ownership contract.

## Explicitly fine

- **Dependency direction:** all nine internal edges follow the source/operation/presentation split; no operation module imports UI code.
- **Coach ownership:** candidate selection, physical-file deduplication, marker validation, cleanup, and writes remain in `coach`; CLI and TUI use its public inspection/mutation functions. The planned `coach → agents` host-name dependency is intentional.
- **Separate persisted state:** skill installation writes live in `agents`; coaching instruction writes live in `coach`; theme persistence lives in `tui`, which owns that presentation preference. Neither frontend directly writes another owner's installation targets.
- **Frontend contracts:** `CoachStatus`, skill status strings, paths, and ordinary Python exceptions suffice for this utility. No Textual widgets or private file records escape into the operation APIs. TUI edits to returned diagnostic details are presentation data, not writes to persisted coach state.
- **Content ownership:** common workflow prose and host dispatch branches have separate sources; rendering stays in `agents`. Corpus contract tests check the splice marker, host branch coverage, and absence of specified host mechanics from common bodies.
- **Catalog cohesion:** the catalog is a small source-discovery/frontmatter module with no internal imports. Its public root and parser are used intentionally; their use alone is not evidence of an internal-storage boundary violation.
- **Package initialization:** the empty initializer introduces no hidden registration, ownership, or startup dependency.

## Validation, coverage, and unresolved areas

Ran `uv run pytest -q tests/test_agents.py tests/test_coach.py tests/test_cli.py tests/test_skills.py`: **164 passed**. The separate temporary-directory TUI probe reproduced ARCH-001. No import-contract checker exists to run.

| In-scope module or seam | Boundaries | Responsibilities |
|---|---|---|
| `catalog` | Checked: zero outgoing internal edges and all incoming callers | Checked: discovery/parser ownership and installer handoff |
| `agents` | Checked: catalog dependency, public API, rendering and filesystem seams | Checked: target mutations, ownership checks, source-validity defect |
| `coach` | Checked: host-name dependency, frontend API and private records | Checked: candidate selection, shared physical targets, markers and writes |
| `cli` | Checked: all imports, including lazy TUI launcher | Checked: all command orchestration and validation placement |
| `tui` | Checked: all imports and source/operation calls | Checked: selection, refresh, mutations, coach worker and theme state |
| `__init__` | Not applicable: empty, no edges | Not applicable: empty, no state or behavior |
| Skills, references, shared host branches | Checked at the content-source/rendering seam; corpus contract tests and manual host-branch reads | Checked: workflow versus host-mechanic ownership; individual workflow quality is outside this audit |
| Packaged coach profile | Checked: package-local resource consumed by `coach` | Checked: one authored profile; installation/reconciliation belongs to `coach` |
| Tests, fixtures, packaging, CI | Checked as evidence of runtime and content seams | Checked as evidence of the declared contracts; suite strategy is outside this audit |

No unresolved architecture candidate remains. Long-term change-locality confidence is limited by three runtime commits, and the new coach module has no committed history. Historical patches were sampled around their shared reasons to change, not exhaustively reviewed line by line.

No separate out-of-scope finding is reported. Per-function design belongs to `code-quality-audit`; over-engineering belongs to `ponytail-review`/`ponytail-audit`; test-suite strategy belongs to `testing-strategy`. Security and performance were not audited. The full TUI suite and live host behavior were not rerun; this report establishes repository ownership and the isolated reproduction, not harness compliance or activation.

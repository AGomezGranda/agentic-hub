# Behavior mode acceptance — 2026-10-22

This record separates persistence/UI verification from observed model behavior.
No live user instruction files were changed. Runtime probes use fresh chats,
isolated global instruction roots, and tiny disposable Python fixtures.
Authenticated CLI credentials were copied privately into temporary roots and
removed after each run; transcripts contain only disposable fixture content.
The CLI defaults choose the model; no model override was supplied.

On 23 October 2026, the Skeptic profile was expanded to build an explicit case
against plans and documents, rank objections, and state how to resolve them.
The runtime observations below predate that wording change; they do not verify
the expanded critique behavior.

## Automated and visual verification

- Baseline: 217 tests passed; Ruff and Pyrefly passed.
- Final implementation: 313 tests passed, Ruff passed, Pyrefly passed (two
  existing suppressions), and formatting passed for all changed Python files.
- Built wheel contains all four packaged Markdown profiles. uv warns that its
  version 0.13.0 is outside the declared backend range; packaging still succeeds.
- Separate CLI processes under disposable roots verified set/status/switch,
  legacy aliases, off, and byte restoration. A readable but unwritable Codex
  target retained its previous mode while other hosts switched; repair/retry
  converged. No private instruction contents appeared in output.
- Native Textual pilot checks cover preview without I/O, all choices, menu
  arrows/search/Escape, shortcut isolation, refresh retention, remount, partial
  failure, pending workers, focus, mouse/keyboard actions, and Skills isolation.
- Inspected headless renders of Skills, Behavior, open selector, and long
  diagnostics at 120×30, 40×24, and 40×16 in saved tactical and nord themes.
  Selector, both buttons, and reminder fit at 40×16; descriptions/status scroll.
  Native menu scrolling reaches every option. These are headless layout checks,
  not proof of terminal emulator color fidelity.
- Visual artifacts: `/tmp/agentic-hub-behavior-visuals/` (30 SVG/PNG pairs,
  including empty Skills, mixed state, and disabled pending-write controls).

## Harness availability

| Host | Version/access | Result |
|---|---|---|
| Claude Code | Executable absent from PATH | Unavailable; all four conversational probes remain unverified. |
| Pi | Executable absent from PATH | Unavailable; all four conversational probes remain unverified. |
| Codex | codex-cli 0.162.1; ChatGPT authentication | 28-turn run completed. Restricted-network attempt failed during workspace routing; network-enabled isolated retry succeeded. |
| OpenCode | 1.18.35; isolated copied credentials; `--pure` | Initial 28-turn run and affected-probe repeats completed. Restricted-network attempt timed out; network-enabled isolated retry succeeded. |

## Runtime evidence

Codex root:
`/var/folders/xd/7s_kfv8d21s3dhwl5z5rlztm0000gp/T/behavior-codex-acceptance-1ry0pitt/`.
Its selected instruction path is `.codex/AGENTS.md` inside that root.
Codex runs with the CLI read-only sandbox; tool-attempt records complement file
hashes because absence of a write alone cannot establish behavioral restraint.

OpenCode root:
`/var/folders/xd/7s_kfv8d21s3dhwl5z5rlztm0000gp/T/behavior-opencode-acceptance-m1n6q6xf/`.
Its selected instruction path is `.config/opencode/AGENTS.md` inside that root.
External plugins were disabled with `--pure`; no model or permissions override
was used. The initial capability probe selected a Copilot-backed default.

Each root contains `records.json` and per-mode numbered JSONL turn transcripts.
The record includes the prompt, response, tool evidence, exit code, and whether
project file hashes remained unchanged. The driver supplied an actual revised
attempt between turns; model edits were not needed. Persistent mode identity is
checked after each chat-local exit, then another frontend runs `mode off` before
a fresh chat checks normal collaboration with no queued implementation.

| Host / mode | Observed behavior | Result |
|---|---|---|
| Codex / Coach | Read the actual attempt, proposed one step, reviewed the revision, left execution to the user, and honored an explicit exit. | Pass |
| Codex / Rubber Duck | Reflected and asked one focused question; no tools until requested inspection of bug.py. A direct fix request surfaced the conflict; bounded exception resumed the role; explicit exit proceeded. | Pass |
| Codex / Skeptic | Inspected queue_demo.py, separated demonstrated response-contract change from risks, accepted resolved concerns, suggested measurements without running them, and preserved the edit boundary. Exception/resumption/exit worked. | Pass |
| Codex / Interviewer | One constrained challenge, clarifications without the approach, labeled hint, actual-attempt assessment with hint attribution, requested checks (4 passed), no early reference read, and correct exception/exit behavior. | Pass |
| OpenCode / Coach | Read and reviewed the actual attempt, preserved implementation ownership, declined to run checks, and honored exit. Its mixed-case expected result was verified as correct. | Pass |
| OpenCode / Rubber Duck | Initial direct fix request caused an unauthorized patch and execution in the disposable fixture. After profile clarification, two fresh repeats preserved the boundary and file hashes; requested inspection, bounded exception/resumption, and exit worked. | Initial failure; repeats pass |
| OpenCode / Skeptic | Initial direct implementation request was incorrectly called an exception and caused a patch/check. After clarification, a fresh repeat surfaced the conflict without tools or edits; evidence review, bounded exception/resumption, and exit worked. | Initial failure; repeat passes |
| OpenCode / Interviewer | Challenge, clarification, labeled hint, actual-attempt assessment, requested checks (4 passed), edit conflict, exception/resumption, and exit worked without early reference access. One manual trace miscounted B while producing the correct result. | Role/tool contracts pass; explanation accuracy caveat |

## Refinement and limitations

The initial OpenCode run changed only disposable `bug.py` and `queue_demo.py`
on conflicting implementation requests. This was a profile compliance failure,
not a persistence bug. The new profiles now explicitly distinguish direct edit
requests from a role exit or bounded exception. The affected fresh-chat probes
were repeated; no model edits occurred in either repeat:

- First repeat (Rubber Duck + Skeptic + Off, 14 turns):
  `/var/folders/xd/7s_kfv8d21s3dhwl5z5rlztm0000gp/T/behavior-opencode-refined-jffwgio4/`.
- Final repeat (Rubber Duck + Interviewer + Off, 17 turns), after tightening
  premature-advice and manually traced-example wording:
  `/var/folders/xd/7s_kfv8d21s3dhwl5z5rlztm0000gp/T/behavior-opencode-final-5t1zwgeq/`.

The final Interviewer trace listed B once in `aAbBABac`; it actually occurs twice.
The expected/result character b and the four executed checks were correct.
The added manual-trace instruction did not eliminate that explanation error;
this remains a recorded accuracy limitation. An earlier concern about the
Coach example's expected result was retracted after directly counting it.
Coach's packaged source remains unchanged.

Codex's complete run tested the original contracts before the wording refinement;
only the affected OpenCode probes were repeated afterward. Codex project hashes
remained unchanged on all 28 turns. OpenCode's initial 28-turn run had the two
recorded unauthorized edits; all 31 repeated turns kept project hashes unchanged.
Both hosts retained installed mode identity after chat-local exits. CLI off
removed the installed block before fresh normal-collaboration chats, with no
queued work or tools executed. Credential copies were removed from all roots.

Actual disposable CLI/TUI alternation also verified externally changed installed
modes, preserved pending selection, explicit off, and remount initialization.
No live user defaults or project files participated in runtime probes.

## Follow-up

Run the plan's multi-turn probes on authenticated Claude Code and Pi installations.
Repeat affected probes after profile changes, model changes, or harness upgrades.
A passing local probe is evidence for that session, not enforced tool permissions
or a guarantee of future compliance. OpenCode's initial failures demonstrate why
these profiles must not be treated as a permission boundary.

# Standing orders

## Subagent delegation is pre-authorized
The operator authorizes delegation, without being asked, in exactly these cases. Otherwise work directly.

| Trigger | Action |
|---|---|
| You finish a non-trivial code change (3+ files, or new logic, auth, money, parsing, concurrency) | Run the audit swarm on the diff before reporting done |
| User asks to audit, review or check quality of a repo, module or PR | Run the swarm with that scope |
| Unknown area spanning many modules, or "how does X work" | 1-3 `scout`s in parallel, then answer yourself |
| Independent read-only sub-questions | At most 3 read-only children total |

Swarm call (async, then yield; completion wakes you):
`subagent({ workflow: "./pi/workflows/swarm.js", args: { scope: "diff vs main" | "<path>", round: 1 }, async: true })`
The parent first maps the exact diff, governing rules, callers and check commands.
Use this workflow only when all three child-creation slots remain; otherwise
reuse existing children where supported or complete the audit directly.
Optional `lenses`: correctness, architecture, quality, tests, simplicity, security. Narrow them for small changes.

## Rules
- At most three subagents total across the task, excluding the parent. Completed children still count. Scouts, reviewers and workers share this budget; only the parent delegates.
- Group related lenses without dropping checks or weakening standards. Incomplete coverage stays incomplete; fewer agents never means a lower quality bar.
- Workflow reports require parent verification: open cited source, check counterevidence, merge duplicate root causes and verify coverage. Failed or uncovered lenses remain incomplete.
- You are the triage authority: classify each verified finding (blocker, non-blocker, stale, invalid, speculative). Never apply findings blindly.
- Fix accepted batches in the parent or an existing worker, with one writer per worktree. Recheck fixes and affected callers using existing reviewers where supported, otherwise directly. Never start another workflow to evade the lifetime cap. Max 3 review rounds; report remaining blockers or incomplete coverage.
- Trivial edits (typos, renames, docs, one-liners): no swarm.
- Children never spawn children. Never push, merge or release without an explicit ask.
- Apply the governing architecture contract and strict DDD/DI criteria; existing patterns do not excuse violations. Preserve required ports and invariant ownership when simplifying.
- Final report: lenses run, findings accepted and rejected, rounds, what was not checked.

## Jira
When given a Jira URL or key (e.g. ABC-123, take the key from `/browse/ABC-123`), fetch it with the `acli` CLI, not web fetch (auth required):
- `acli jira workitem view ABC-123 --fields '*navigable'` (add `--json` for structured output)
- Comments: `acli jira workitem comment list --key ABC-123`
- Search: `acli jira workitem search --help`
Read-only unless asked: never transition, comment, edit or assign without an explicit request.

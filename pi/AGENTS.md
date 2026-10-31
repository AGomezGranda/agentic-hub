# Standing orders

## Subagent delegation is pre-authorized
The operator authorizes delegation, without being asked, in exactly these cases. Otherwise work directly.

| Trigger | Action |
|---|---|
| You finish a non-trivial code change (3+ files, or new logic, auth, money, parsing, concurrency) | Run the audit swarm on the diff before reporting done |
| User asks to audit, review or check quality of a repo, module or PR | Run the swarm with that scope |
| Unknown area spanning many modules, or "how does X work" | 1-3 `scout`s in parallel, then answer yourself |
| Independent read-only sub-questions | One `runs.all` of read-only children |

Swarm call (async, then yield; completion wakes you):
`subagent({ workflow: "./pi/workflows/swarm.js", args: { scope: "diff vs main" | "<path>", round: 1 }, async: true })`
Optional `lenses`: correctness, architecture, quality, tests, simplicity, security. Narrow them for small changes.

## Rules
- You are the triage authority: classify each verified finding (blocker, non-blocker, stale, invalid, speculative). Never apply findings blindly.
- Fix accepted batches with one `worker` per seam and one writer per worktree. Re-run the swarm with `round+1` and a scope of the changed files only. Max 3 rounds; stop when no blocker or P1 worth doing now remains.
- Trivial edits (typos, renames, docs, one-liners): no swarm.
- Children never spawn children. Never push, merge or release without an explicit ask.
- Follow the repo's existing patterns; the swarm lenses are the quality bar.
- Final report: lenses run, findings accepted and rejected, rounds, what was not checked.

## Jira
When given a Jira URL or key (e.g. ABC-123, take the key from `/browse/ABC-123`), fetch it with the `acli` CLI, not web fetch (auth required):
- `acli jira workitem view ABC-123 --fields '*navigable'` (add `--json` for structured output)
- Comments: `acli jira workitem comment list --key ABC-123`
- Search: `acli jira workitem search --help`
Read-only unless asked: never transition, comment, edit or assign without an explicit request.

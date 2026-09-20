**Codex** — when this skill calls for independent parallel work, spawn one
subagent per bounded question, dimension, or review lens. Dispatch independent
children before waiting, then collect all results and synthesize them in the
parent. Use the available subagent tools; do not assume a particular tool name
or a fixed concurrency cap. Give each child the relevant scope, expected
output, and read-only constraint when appropriate.
The bundled `agents/*.md` definitions in this repository are for Pi, so
use generic Codex subagents unless matching Codex custom agents are configured.

One child per question answerable independently; avoid splitting questions
that would read the same files. Parallel work can reduce elapsed time but
uses more total tokens. Treat a child's `path:line` claim as a
lead, not evidence, and verify it according to this skill's verification
steps before reporting it.

If no subagent dispatch is available in this session, do the work yourself
serially: order checks by risk and dependency, reuse nearby evidence, keep
compact notes, and revisit source when evidence is stale or insufficient.
If a real budget prevents completion, mark the remaining coverage
unverified and name the next work.

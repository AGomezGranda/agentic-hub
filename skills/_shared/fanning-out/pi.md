**Pi** — one `subagent` call with a `workflowScript` dispatching every
child in a single `await runs.all([...])`, not a loop of sequential
`runs.run` calls. Omit `async` entirely — default blocking. A single
top-level call that this turn needs to synthesize from must block until
`runs.all([...])` resolves; `async: true` would return a background-run
receipt before the children finish, and nothing else in this flow tells
the model to `bg_wait`/poll afterward. Children run concurrently up to
`globalConcurrencyLimit` (default 20), capped at 64 spawns per run. Name
the packaged fallback agent per child if this skill's own bundled agent
isn't installed: `scout` for locate/inventory work, `reviewer` for
read-only judgement, `evidence-auditor` for bulk evidence checks,
`researcher` where web access is allowed.

One child per question answerable independently; don't split a question
whose halves would read the same files — a child starts from a cold
context each time, so two children reading the same files is not free
just because it runs in parallel. Spawn as many as genuinely apply; there
is no arbitrary cap. Fanning out wider buys wall-clock, not lower total
tokens — more children cost more tokens in total, in exchange for running
at once instead of in sequence. A child's `path:line` claim is
a lead, not evidence: verify it per this skill's own verification tiers
before writing anything down.

Dispatch children with `outputMode: "file-only"` and read results from
their `output:` files: the chat response is a pointer, not the findings.
For a spot-check-tier claim the short answer at the top of the file is
enough; for a load-bearing claim — anything a top-line recommendation or
the document's answer rests on — read the whole file. A child's output
file is its single final message verbatim. If a short answer is too thin
to judge on its own, treat that as the finding and probe it yourself.

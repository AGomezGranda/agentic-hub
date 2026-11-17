**Pi** — dispatch up to three children total in one `subagent` call with a
`workflowScript` using `await runs.all([...])`. Count earlier task children
against this budget; completed children still count. Reuse existing children
only if the host supports it; otherwise do follow-up work in the parent.
Pass `async: false` explicitly: workflow calls default to background,
returning a receipt instead of findings. The host's higher concurrency limit
does not override the shared three-subagent limit.
Name the packaged fallback agent per child if this skill's own bundled agent
isn't installed: `scout` for locate/inventory work, `reviewer` for
read-only judgement, `evidence-auditor` for bulk evidence checks,
`researcher` where web access is allowed.

One child per question answerable independently; don't split a question
whose halves would read the same files — a child starts from a cold
context each time, so two children reading the same files is not free
just because it runs in parallel. A child's `path:line` claim is
a lead, not evidence: verify material findings against source and the
applicable review contract before reporting them.

Dispatch children with outputMode: "file-only" and read their output files;
the chat response is a pointer. Read the evidence supporting findings you
publish; summaries alone do not establish correctness.

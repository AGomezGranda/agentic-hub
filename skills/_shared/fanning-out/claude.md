**Claude Code** — one message containing N `Agent` (historically
`Task`/`subagent_type`) calls, dispatched together, never a loop of
one-at-a-time calls. Pick the agent per sub-question shape: `Explore` for
locate/inventory work, `general-purpose` for judgement or synthesis.
Unverified here, same tag as OpenCode below: children cannot spawn
further children on this host. Treat that as a hard constraint, not a gap
to route around — plan one level of fan-out only. A Claude Code parent
must never dispatch a child whose own task asks it to fan out again; do
that decomposition yourself, one level up, before dispatching. Claude
Code has no shipped agent definitions here — it uses only its built-ins.

One child per question answerable independently; don't split a question
whose halves would read the same files — a child starts from a cold
context each time, so two children reading the same files is not free
just because it runs in parallel. Spawn as many as genuinely apply; there
is no arbitrary cap. Fanning out wider buys wall-clock, not lower total
tokens — more children cost more tokens in total, in exchange for running
at once instead of in sequence. A child's `path:line` claim is
a lead, not evidence: verify it per this skill's own verification tiers
before writing anything down.

If no child dispatch is available in this session, do the checks yourself
serially, highest-risk first, and mark any uncovered scope explicitly.

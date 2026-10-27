## Plan Review: Swarm viewer — standalone read-only Node dashboard for pi-subagents swarm runs
**Verdict:** REVISE

The security design holds: report paths come only from the receipt, a realpath allowlist guards reads, the Host guard is sound, and the surface is read-only. The plan was written from memory of the artifact layout, though. Checked against a real run, it has three confirmed P1 defects: the default artifacts path is one level too high, so the default dashboard lists zero swarms; several field paths disagree with the real `status.json` and event shapes; and `buildSwarm` copies tool arguments and tool output into the UI, bypassing the redaction gate. Fixtures built from the plan's own shapes would pass while the real run fails.

### Coverage

Ran directly, with no child reviewers. The plan is one document, and the claims needed direct checks against local artifacts.

- **Correctness**: checked field paths against real root, child, receipt, and event files (51 run dirs locally). Ran the stage algorithm on a real 8-child swarm (`23fc2b9b…`): it reproduces `[0, 1×6, 2]`. Unverified: failed, stopped, and paused step shapes (none locally; step statuses seen were `complete`, `completed`, `running`). Polling cost under large runs was not measured.
- **Security**: checked Host, method, header, path, report, and redaction design against real `recentTools` and `recentOutput` content. Not checked: a live browser run, since no code exists yet.
- **Architecture**: checked layering against the plan's own rules, the repo README, the 2026-10-12 architecture audit, and the staged tree. Not checked: `docs/payo/` (the plan says it is independent; its "Bun host" claim was not verified).
- **Tests**: checked feasibility of the test plan: `fetch` Host override, `port: 0`, fixture layout, `node --test` discovery on Node 24.
- **Simplicity / code quality**: checked scope against seven phases, two PRs, and the layer count. Final LOC not estimated.
- **Not applicable**: a separate UX/accessibility lens (one page; the manual checklist covers it). Performance was folded into Correctness and Simplicity.

### Cross-Cutting Themes

- **The artifact layout was assumed, not read** (findings 1, 2, 5). Correctness and Tests both flag it. A1 and A2 are marked validated, yet the default path and several field paths disagree with the real tree. The fixtures are "built from the observed shapes" of the plan itself, so they would encode the same errors and pass.
- **Redaction is designed for events only** (finding 3). Security and Correctness both flag it. The single-gate design and canary tests exercise `summarizeEvent`. `buildSwarm` reads `status.json` directly, and the canaries are planted only in thinking and system-prompt content, so they never reach that path.

### Findings

#### Critical (P1)

1. 🔴 **Correctness**: Default artifacts root is one level too high — **Location**: Phase 4 `bin/swarm-viewer.js` flags; Current State. Real run dirs sit at `<tmp>/pi-subagents-uid-502/async-subagent-runs/<runId>/` (`pi-subagents/src/shared/types.js:111`). The plan's default is the scope dir itself, so `listRunIds()` returns five entries: `async-subagent-results`, `async-subagent-runs`, `nested-subagent-events`, `run-fanout-budgets`, `supervisor-channels`. None of the four non-run entries contains a `status.json`, and the plan's `listSwarms` drops every non-workflow entry, so the default shows zero swarms. The plan also ignores `PI_SUBAGENTS_TEMP_ROOT` (`types.js:106-109`). The manual check passes an explicit `--artifacts-dir`, which hides the bug. PR 1's "usable through `curl`" claim fails by default.

2. 🔴 **Correctness**: Field paths disagree with real artifacts (systemic; five instances) — **Location**: Current State bullets; Phase 1 `buildSwarm`; A2. Checked on `23fc2b9b…` and its children:
   - `resolvedModel` is an object `{provider, model}`. `requestedModel` is the string `"provider/model"`. `model = resolvedModel ?? requestedModel` therefore yields an object, and `modelMismatch` (object vs. string) fires on every step that has both. 47 of 70 child steps have `resolvedModel`; 36 have `requestedModel`.
   - `lifecycleArtifactVersion` is absent from the root status. It appears on child statuses and `subagent.*` events (value `3`). The plan says "a run with `lifecycleArtifactVersion !== 3`" is unsupported. If the check runs on the root, every swarm is flagged and no node is shown.
   - `pid` is top-level on the child status, not on `steps[]`. No step carries `pid`. Reading it from the step means stale detection never fires, and A4 fails silently.
   - `workflowChildren.children[]` carries `agent, childId, runId, sessionName, state`. There is no `totalCost`.
   - Tool events carry `toolName` (and `result` on end), not `tool`.

   Confirmed as matching: root `totalTokens.total` and `totalCost.costUsd`; receipt `outputReference`; `turn_end.message.usage` including `cost.total` and `reasoning`; child `workflowKey` and `parentWorkflowRunId`; the `subagent.*` event names observed.

3. 🔴 **Security**: `buildSwarm` bypasses the redaction gate — **Location**: Phase 1 `buildSwarm` (`recentTools`, `recentOutput`); Design Decisions "Single redaction point". Each child's step in `status.json` carries `recentTools` with `args` (file paths, and `watchdog_diff` arguments) and `recentOutput` (up to 50 lines of tool output, such as repo source lines). The plan copies both into nodes, and the UI shows them by default. That contradicts "single redaction point", "tool arguments only with `--show-args`", and "never tool result bodies". The canary tests do not reach this path, as noted above.

#### Major (P2)

4. 🟡 **Tests**: Host-guard tests cannot be written as specified — **Location**: Phase 4 tests. `fetch` silently ignores a `Host` header override. On Node 24.19 the request went out as `Host: 127.0.0.1:<port>`. With `port: 0`, the expected `Host: …:<port>` is also unknown to the guard. Use `node:http` requests with an explicit Host header, and have the guard compare against the bound port (`server.address().port`).

5. 🟡 **Simplicity / Architecture**: Child discovery scans every run directory — **Location**: Phase 2 `getSwarm`, `listSwarms`; Phase 4 SSE. `getSwarm` finds children by `parentWorkflowRunId === id` across all run dirs on every poll. The root already lists its members in `workflowChildren.children[].runId` (`inventoryComplete: true`), and the receipt lists them again. Use those. Phase 4 also never says where SSE cursors live. They should be per-connection state in the handler.

6. 🟡 **Architecture / Simplicity**: Hexagonal layering is not marked decided, and it cuts against the repo's own stance — **Location**: Design Decisions (ports, use-cases, boundary test). The plan adds ports typedefs, a use-case layer, `compose.js`, and a boundary test for a five-route, read-only viewer. The repo's 2026-10-12 architecture audit concluded that a filesystem utility does not warrant layered domain structure. For: fake-based tests, and an enforced rule that the redaction gate stays in core. Against: a smaller diff if use-cases fold into the handler. Value-dependent; see Decisions.

#### Minor (🔵)

7. 🔵 **Docs**: Dirty-tree list is wrong — **Location**: Risks "Dirty working tree"; PR Strategy. `pi/AGENTS.md`, `pi/workflows/swarm.js`, and this plan are staged (`A`), not untracked. The other listed files are staged `M` entries. Commit-or-stash still applies; the wording should say "staged".

8. 🔵 **Security**: CSP has no `frame-ancestors` — **Location**: Phase 4 headers. Add `frame-ancestors 'none'` alongside `default-src 'self'`. Low impact on a local read-only page.

### Strengths

- ✅ Report paths come only from the receipt, guarded by a `realpath` allowlist and a symlink test. The receipt `outputReference` paths exist on disk.
- ✅ Host allowlist, GET/HEAD only, `nosniff`, `textContent`-only UI, and CSP `default-src 'self'` form a coherent localhost threat model.
- ✅ The stage rule (`startedAt >= max endedAt` of the current stage) reproduces the real 8-child swarm exactly.
- ✅ Citations check out: README.md:180 and :207, ci.yml:7-22, types.js:64-69 and :109, chunk-5LFLVSTM.js:54-58, observability.md:201, and `pi/manifest.json` as the file `pi apply` reads.

### Recommended Changes

1. Set the default to `<tmp>/pi-subagents-uid-<uid>/async-subagent-runs`. Honour `PI_SUBAGENTS_TEMP_ROOT` by appending `async-subagent-runs`. Add a Phase 3 test on a temp tree shaped like the real one. (finding 1)
2. Rewrite Current State and the Phase 1 field map from real artifacts: `model` as `provider/model` from `resolvedModel`, with `requestedModel` as fallback, compared after normalisation; version read from child statuses and `subagent.*` events; `pid` from the child top-level; drop `totalCost` from `workflowChildren`; `toolName` and `result` for tool events. Then fix A2's wording so it says what was checked. (finding 2)
3. Gate `recentTools` and `recentOutput` in `buildSwarm`: tool name and timing by default; `args` only with `showArgs`; `recentOutput` per the decision below. Add canary tests over a `status.json` fixture, not only events. (finding 3)
4. Build fixtures by copying a real swarm's full tree (root and child `status.json`, receipt, `events.jsonl`), scrubbed of content but keeping canaries in status fields too. Assert field paths against it. (themes 1 and 2)
5. Write Host-guard tests with `node:http` and an explicit Host, comparing against the bound port. (finding 4)
6. Enumerate members from `workflowChildren.children[].runId` and the receipt. State that SSE cursors are per-connection state in the handler. (finding 5)
7. Decide the layering question below. Either keep ports and the boundary test, or fold use-cases into the service module. (finding 6)
8. Change the dirty-tree wording to "staged". (finding 7)
9. Optional: add `frame-ancestors 'none'` to the CSP. (finding 8)

### Decisions Needed

- **Show `recentOutput` in the UI?** Live tool output helps monitoring. The plan's privacy stance says no. My recommendation: hide it by default, and show it only behind an explicit flag. Your call.
- **Hexagonal layering** (finding 6): keep the ports and boundary test, or collapse them. Your call.

### Unresolved

- Stage inference for failed, stopped, or paused steps. No such step exists in local runs, so how `endedAt` behaves for them is unknown. Needs one failed-run sample.
- The payo "Bun host" claim was not verified. It is not load-bearing for this plan.

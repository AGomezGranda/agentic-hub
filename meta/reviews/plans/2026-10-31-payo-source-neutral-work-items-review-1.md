## Plan Review: Payo source-neutral work items and direct prompts
**Verdict:** REVISE

The plan is well scoped around the existing server composition boundary, and its legacy-read and persistence strategy is generally supported by the current architecture. One important security claim is not met by artifact indirection alone: agent telemetry can echo prompt text into persisted and API-visible events. Two smaller gaps concern a CLI edge case and an untested startup wiring change.

### Coverage

| Lens | Status |
|---|---|
| Architecture | Checked |
| Security | Checked |
| Test Coverage | Checked |
| Code Quality | Checked |
| Correctness | Checked |
| Simplicity | Checked |
| Standards | Checked |
| Usability | Checked |
| Documentation | Checked |
| Compatibility | Checked |
| Database | Checked |
| Performance, Portability, Safety | Not applicable: no material design change in these areas beyond the persistence/compatibility concerns covered above. |

Plan areas checked: current-state assumptions; design decisions and risks; both implementation phases, including tests and acceptance criteria; rollback and compatibility. The listed Payo docs and relevant source/test files were inspected. No prior review for this plan was found. No plan area was left unverified.

### Cross-Cutting Themes

No finding was independently raised by multiple lens groups. The event-confidentiality issue does intersect the security promise and the proposed HTTP test: checking that a fixture does not echo the prompt would not establish that agent-generated events cannot contain it.

### Findings

#### Critical / Major

- 🔴 **Security — Artifact-only input persistence does not prevent prompt text in run events (RP-SEC-01, P1, confidence: high)** — **Location**: Design Decisions, prompt artifact decision; Risks & Mitigations, “Prompt text could leak through run events”; Phase 2, `http.test.ts` and documentation requirements (plan lines 26, 34, 114, 117) — **Summary**: The plan promises that prompt plaintext will not appear in run events, but the event contract records free-form agent messages/results and the authenticated events API returns those events. Persisting the original request as an artifact only prevents its direct serialization in `run.created.config`.

  **Violated contract:** Prompt text is to be excluded as plaintext from run events and event-stream consumers.

  **Concrete consequence:** The factory passes the prompt-derived work item to the planner/reviser (Phase 1, line 62). An agent can repeat or quote that text in a `message`, `result`, or `error` event. The kernel persists normalized `AgentEvent`s (`payo/packages/contracts/src/agent.ts:25-41`; `payo/packages/kernel/src/agent-step.ts:277-286`), and the server returns stored events from the events endpoint and stream (`payo/apps/server/src/http.ts:123-140`). Thus an authenticated event consumer can see prompt text despite the artifact reference in config.

  **Counterevidence considered:** The request is not directly placed in `run.created.config`, the events API requires authentication, and there is no evidence here of an artifact-download endpoint. These controls do not prevent agent output from echoing the request into an event.

  **Smallest sufficient correction:** Resolve the confidentiality contract explicitly. If the promise is that no prompt text may appear in events, plan an enforcement mechanism for prompt-source runs (including `message`, `result`, and `error` events) and a test runner that deliberately echoes the full prompt. If the intended guarantee is only “the original request is not copied directly into config or a source-input event,” narrow the risk mitigation, documentation, and test assertion accordingly, and state that generated agent telemetry may echo the prompt. Simple substring redaction is not a reliable general guarantee.

  **Body:** Artifact indirection protects the serialized request, not text generated after the request is supplied to an agent. The proposed HTTP test, as written, could pass with a non-echoing fake while production runner events still disclose the prompt. The current event model intentionally persists textual agent telemetry, so either the plan must bound and enforce a stronger privacy guarantee or make the documented guarantee precise enough to match the behavior.

#### Minor

- 🔵 **Usability / Correctness — No escape for a prompt that is itself an option token (RP-CLI-01, P2, confidence: medium)** — **Location**: Design Decisions, prompt CLI syntax; Risks & Mitigations, “Variadic prompt parsing can confuse text with options”; Phase 2, `args.ts` and parser tests (plan lines 25, 37, 107, 111) — **Summary**: The option-token parsing rule leaves no way to pass a prompt consisting solely of `--repo` or `--base` while preserving the stated verbatim prompt behavior.

  **Violated contract:** Direct prompt input is passed verbatim, while exact `--repo` and `--base` tokens remain options.

  **Concrete consequence:** Quoting a one-token prompt such as `payo start --prompt "--repo"` still delivers the argument value `--repo`; quoting does not disambiguate it from the option. The parser must either consume it as an option/value or reject it, so this prompt cannot be represented under the specified rules.

  **Counterevidence considered:** Quoting the whole prompt correctly protects option tokens embedded in multiword text, and the plan explicitly calls out that convention. It does not resolve the sole-token case.

  **Smallest sufficient correction:** Specify and test an escape convention for option-like prompt content, such as an end-of-options marker after `--prompt` or a `--prompt=<text>` form, including a prompt consisting only of `--repo`.

  **Body:** The ambiguity is narrow and non-blocking, but it contradicts “passed verbatim” for a valid direct prompt. Make the escape syntax explicit in CLI parsing, docs, and the parser tests rather than relying on shell quoting, which does not change the argument token.

- 🔵 **Test Coverage — Startup exception is not tested through the actual startup path (RP-TEST-01, P2, confidence: high)** — **Location**: Phase 2, `doctor.ts`/`main.ts` change, `doctor.test.ts` test bullet, and automated success criteria (plan lines 109, 115, 127) — **Summary**: The plan tests the helper’s filtering behavior but does not pin that `main` uses it to decide readiness.

  **Violated contract:** A failed `acli` check alone must not prevent real-mode server startup, while failures for `pi`, `git`, or skills still must.

  **Concrete consequence:** `startupBlockingFailures` can pass its unit tests while `main` continues to gate on `report.ok`, leaving prompt-only starts blocked by an unavailable Jira CLI. The existing `main.test.ts` case fails both `pi` and `acli`, so it cannot detect that wiring regression (`payo/apps/server/src/main.ts:22-29`; `payo/apps/server/src/main.test.ts:59-99`).

  **Counterevidence considered:** The plan includes a manual real-environment startup check with a missing `acli` binary and separates startup readiness from `payo doctor`; that is useful but not a repeatable automated regression test.

  **Smallest sufficient correction:** Add a `main.test.ts` real-mode case where only `acli` is unavailable and assert that readiness is reached, plus a blocking-check failure case if existing coverage does not already distinguish it.

  **Body:** The behavior change crosses the readiness boundary in `main`, not just the pure doctor helper. An automated startup test can catch a missed call-site update and prevent a future regression without requiring the manual full real environment described in the plan.

### Strengths

- ✅ Source selection and provider wiring stay in the server composition root; the factory consumes a port and the CLI remains a thin contracts-only client.
- ✅ Legacy API/config/checkpoint shapes and the old stage are explicitly retained for reading and resume, with SQLite reopen coverage planned.
- ✅ Tests are allocated at sensible levels: contract/parser units, adapter and resolver coverage, HTTP component behavior, and SQLite persistence integration.
- ✅ The plan resists speculative provider infrastructure and distinguishes server startup requirements from the full diagnostic report.

### Recommended Changes

1. Decide and specify the actual prompt/event confidentiality guarantee; align implementation requirements, the echoing-event test, and docs with that guarantee. (addresses: RP-SEC-01)
2. Define an escape syntax for prompt content equal to or beginning with option tokens and add parser coverage. (addresses: RP-CLI-01)
3. Add an automated `main` startup test where only `acli` is unavailable. (addresses: RP-TEST-01)

## Plan Review: Payo unified TOML configuration
**Verdict:** COMMENT

The plan preserves the server-owned composition boundary, makes the CLI’s shared-config dependency narrow, and gives good compatibility and parser-level coverage. I found no blocking P0/P1 issues, but the plan should close a timeout-range mismatch and align the process-test claims with the overrides it actually uses; the docs should also identify tool paths as executable trust inputs.

### Coverage
- **Checked:** Architecture, Code Quality, Simplicity, Correctness, Test Coverage, Security, Safety, Compatibility, Usability, Documentation, and Portability. Reviewed shared config ownership and package boundaries; defaults/env/TOML precedence; role model and timeout resolution; doctor behavior; loopback and test-only controls; planned parser, boundary, CLI, server, composition, and process tests; and the documentation scope.
- **Not applicable:** Database (no database/schema changes); Performance (local startup configuration with no stated throughput target); accessibility and UI standards (no UI change). Public configuration ergonomics were checked under Usability and Compatibility.
- **Unverified:** No implementation exists to test. This review does not assess the unrelated uncommitted web UI changes or run the proposed test commands.

### Cross-Cutting Themes
No defect was independently raised by two lens groups, and no material lens tradeoff was identified. The process-test finding is a verification-claim mismatch: the proposed overrides are appropriate for dynamic-port isolation, but bypass the normal configured-port path the test is supposed to verify.

### Findings
#### Critical / Major
None.

#### Minor

- 🔵 **Correctness (P2, high confidence; effort: low): CFG-001 — Bound role timeouts to the AgentSpec limit** — **Location:** Phase 2, Changes (role schema and timeout defaults); Phase 2, Tests (timeout coverage). The plan requires positive `timeout_ms` values but does not specify the upper bound. `FactoryRunConfig.RoleSettings` accepts any positive integer, while `AgentSpec.timeoutMs` is capped at `2,147,483,647` (`payo/packages/contracts/src/agent.ts`) and the kernel constructs `AbortSignal.timeout(timeoutMs)`. A larger TOML value can therefore be accepted and recorded for a run but rejected when converted into an agent spec. **Counterevidence:** The default is safely `300000` ms and the plan includes timeout override tests, but neither constrains large overrides. **Smallest sufficient correction:** Validate `timeout_ms` in `1..2,147,483,647` and test rejection of `2,147,483,648`.

- 🔵 **Test Coverage / Architecture (P2, high confidence; effort: low): CFG-002 — Process acceptance bypasses configured-port parity** — **Location:** Phase 3, Changes (process-level `e2e.test.ts` bullet); Phase 3, Tests (claim that the test proves token location and port parity). The planned server uses `PAYO_TEST_PORT=0`, which supersedes the TOML port, and the CLI uses `PAYO_TEST_SERVER_URL`, which supersedes normal URL resolution. The test can demonstrate data-directory/token parity, but cannot demonstrate that a real CLI and server independently resolve the same configured port. **Counterevidence:** Phase 1 unit tests separately check TOML port resolution, but they do not prove the normal resolution path works across processes. **Smallest sufficient correction:** Either narrow the process-test claim to data-directory/token parity, or add a process scenario with a nonzero TOML port and no test server URL override (keeping a dynamic-port case separately if needed).

- 🔵 **Security / Documentation (P2, high confidence; effort: low): CFG-003 — Document that `[tools]` selects executables** — **Location:** Design Decisions (`[tools]`); Phase 3, Changes (documentation checklist). The documentation checklist covers secrets, credentials, and loopback behavior but not that `pi`, `acli`, and `git` values select programs Payo executes. The current adapters invoke the configured binary directly (`execFile` with `shell: false`), so strict TOML validation does not prevent a valid but untrusted tool path from choosing an unintended executable. **Counterevidence:** The config is per-user, explicit `PAYO_CONFIG_FILE` selection is operator-controlled, and execution is shell-free; this is an operational trust warning, not a shell-injection finding. **Smallest sufficient correction:** Document that the config file is trusted input and that users should not run Payo with an untrusted file or `[tools]` values.

### Strengths
- ✅ `@payo/config` is a narrow shared bootstrap dependency; the server remains the composition root, the CLI does not import server internals, and the web app remains outside local-file configuration.
- ✅ Strict schema validation, unsafe-key rejection, actionable parse errors, and explicit precedence make configuration failures visible rather than silently changing behavior.
- ✅ The plan preserves existing environment aliases and persisted role settings while snapshotting effective per-role model/timeout choices for new runs.
- ✅ Test coverage is planned at the right boundaries: parser and package rules as unit/boundary tests, with a focused process-level acceptance test.

### Recommended Changes
1. Bound `timeout_ms` to `1..2,147,483,647` and add the first-out-of-range rejection case (CFG-001).
2. Align the process acceptance assertion with its test-only overrides: narrow it to data-directory parity or add a no-override configured-port process case (CFG-002).
3. Add a short trusted-config warning for `[tools]` executable paths to the usage documentation (CFG-003).

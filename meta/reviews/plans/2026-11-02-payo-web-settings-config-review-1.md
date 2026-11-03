## Plan Review: Payo web settings and config editor
**Verdict:** REVISE
The plan has a solid boundary model and carries forward the previous unified-config review’s timeout-range and trusted-tool warnings. However, the browser’s planned `PUT` save cannot pass the current CORS preflight, so the central save flow is blocked as written. The persistence guarantees also need clearer handling of external edits, symlinks, and platform-specific permissions; several planned UX and failure-path assertions should be made explicit.

### Coverage
- **Checked:** Architecture, Code Quality, Simplicity, Security, Safety, Correctness, Compatibility, Portability, Test Coverage, Usability, Standards, and Documentation. Reviewed Design Decisions and Phases 1–4, including package boundaries, config resolution and persistence, API routes, browser port selection, draft handling, planned tests, and documentation. Checked relevant current config, auth/CORS, HTTP, web navigation, tests, manifests, lockfile, and the related unified-config plan/review.
- **Not applicable:** Database (no database/schema change); Performance (no throughput-sensitive behavior or stated performance target).
- **Unverified:** This is a plan-only review; no implementation or proposed test suite exists to execute. Existing staged/unrelated changes were not reviewed as implementation of this plan. Windows file-permission behavior was not run; the permission finding is based on the plan’s unqualified guarantee and the current platform-specific token-permission handling.

### Cross-Cutting Themes
- **Browser save viability:** Security and Correctness independently identify the missing `PUT` CORS allow-method; without it, the intended authenticated browser save is blocked before reaching the API.
- **Persistence guarantees:** Architecture and Security both identify the check-then-rename window for external edits. Atomic replacement prevents partial files, but not every lost-update race. Security also identifies the separate symlink replacement behavior.
- **Cross-platform contract:** The plan’s POSIX permission test is narrower than its unqualified permission and documentation claims.

### Findings
#### Critical / Major
- 🔴 **Security / Correctness (P1, high confidence; effort: low): PUT preflight is not allowed** — **Location:** Phase 2 — Authenticated config settings API, Changes; Phase 3 — Tactical web settings editor, Changes and Tests. The plan adds a JSON `PUT` client and route, but the existing `payo/apps/server/src/auth.ts` advertises only `GET, POST, OPTIONS` in `Access-Control-Allow-Methods`. A browser preflight therefore rejects the save before sending the authorized request. **Counterevidence:** Existing Host/Origin checks and a general preflight test are retained, but neither permits nor asserts `PUT`. **Correction:** Add `PUT` to the CORS methods and test an allowed-origin preflight requesting `PUT`, while retaining hostile-origin rejection.

#### Minor
- 🔵 **Safety / Correctness (P2, high confidence; effort: low to medium): Revision check does not cover the external-write race** — **Location:** Risks & Mitigations — stale browser tab; Phase 1 — `writePayoConfigDocument`. The plan checks the expected raw-byte revision and then atomically renames a temp file, with only in-process write serialization. An external editor or second process can write after the revision check but before rename, and that newer change can be replaced without a conflict. **Counterevidence:** Edits completed before the check and concurrent saves through this server are detected/serialized. **Correction:** Narrow the no-clobber claim to edits visible at the revision check and document the remaining race, or specify a coordination mechanism if preventing it is a requirement.

- 🔵 **Security / Compatibility (P2, high confidence; effort: low): Atomic rename replaces a selected symlink** — **Location:** Design Decisions — “Write only the process-selected file”; Phase 1 — safe config-file persistence. Startup reads a selected symlink by following it, but atomic rename to that path replaces the symlink itself rather than updating its target. A successful save can silently detach a symlink-based config from its target, so subsequent reads use a different file arrangement than before. **Counterevidence:** The rename remains atomic and does not truncate the symlink target. **Correction:** Specify and test a policy: reject symlink config files before save, or resolve the target and consistently use that canonical path for reading, revision checks, and writing.

- 🔵 **Compatibility / Security (P2, high confidence; effort: low): File-mode claims need an OS qualification** — **Location:** Design Decisions — “Validate and protect persistence”; Phase 1 and Phase 4 permission requirements. The plan and docs promise `0600` files and `0700` newly created directories, while tests are explicitly POSIX-only. The existing `payo/apps/server/src/auth.ts` skips `chmod` on Windows, reflecting that these mode-bit guarantees are not portable there. **Counterevidence:** POSIX verification is planned. **Correction:** State the guarantees as POSIX-specific and describe Windows behavior, or specify and test an equivalent Windows ACL strategy before promising owner-only access cross-platform.

- 🔵 **Compatibility (P2, high confidence; effort: low): Workspace lockfile update is omitted** — **Location:** Phase 1 — Shared schema and safe config-file persistence, Changes. Adding `@payo/contracts` to `payo/packages/config/package.json` also requires the `packages/config` importer in `payo/pnpm-lock.yaml` to be updated; that importer currently lists only `smol-toml` and `zod`. Without it, frozen-lockfile installs can fail or report an out-of-date lockfile. **Counterevidence:** The plan includes dependency-boundary changes and full project checks, but does not name the lockfile. **Correction:** Add `payo/pnpm-lock.yaml` to Phase 1 and verify the frozen-lockfile install/check convention.

- 🔵 **Test Coverage / Safety (P2, high confidence; effort: low): Persistence failure cleanup is not exercised** — **Location:** Risks & Mitigations — failed/partial save; Phase 1 — Tests. The plan requires cleanup of failed temp files and preserving the original config, but tests only cover invalid-candidate rejection and successful write paths. A filesystem failure after temp creation—especially a failed rename—could leave a temp file or damage the original without failing the listed tests. **Counterevidence:** The plan covers invalid inputs, stale revisions, concurrency, and successful missing/existing-file writes. **Correction:** Inject a temp-write or rename failure and assert the original bytes remain unchanged and the temporary file is cleaned up.

- 🔵 **Usability / Test Coverage (P2, high confidence; effort: medium): Dirty-draft guard does not define browser-history exits** — **Location:** Phase 3 — Changes and Tests. The plan promises to guard against losing a dirty draft when navigating away, but tests cover only the in-app confirmation. Existing navigation updates route state on `popstate`; browser Back/Forward, reload, or tab close could bypass an in-app-link guard and discard edits. **Counterevidence:** The plan explicitly requires a draft guard and tests cancellation/confirmation for in-app navigation. **Correction:** Define which history/document exits are supported and add tests for those paths, or narrow the stated guarantee to in-app navigation.

- 🔵 **Standards / Usability (P2, medium confidence; effort: low): Validation errors need explicit accessible associations** — **Location:** Phase 3 — Changes and Tests. The plan calls for inline constraints, form-associated messages, semantic labels, and visible focus, but does not require associating field errors with controls or exposing invalid state and submission errors to assistive technology. A visually clear error can therefore remain undiscoverable or ambiguous to screen-reader users. **Counterevidence:** The plan includes semantic labels, keyboard-focus checks, and visible error states. **Correction:** Specify programmatic error associations and invalid state (for example, `aria-describedby` and `aria-invalid`) plus an announced submission-level error, and assert these in component tests.

### Strengths
- ✅ Keeps filesystem ownership in `@payo/config`, API composition in the server, and browser dependencies limited to shared contracts.
- ✅ Binds writes to the startup-selected path, separates file values from environment overrides, validates effective real-mode models before save, and avoids mutating the running composition.
- ✅ Plans focused contract, persistence, HTTP, service, browser transport, and UI tests, alongside restart/conflict/error messaging.
- ✅ Correctly preserves the prior review’s timeout upper bound and the warning that `[tools]` chooses trusted executables.

### Recommended Changes
1. Add `PUT` to the CORS allow-methods response and test a successful browser-style preflight (addresses: PUT preflight).
2. Define the external-edit race and symlink policy; avoid promising stronger no-clobber semantics than check-then-rename provides (addresses: revision race, symlink replacement).
3. Qualify permission guarantees by platform and include the workspace lockfile update (addresses: platform permissions, lockfile).
4. Add a persistence fault-injection test for cleanup/original-file preservation (addresses: persistence failure cleanup).
5. Specify dirty-draft behavior for browser history/unload and accessible field/submission error semantics, with corresponding tests (addresses: navigation guard, accessible errors).

## Re-Review (Pass 2) — 2026-11-01
**Verdict:** APPROVE
The revised plan addresses the implementation and test gaps from Pass 1. It explicitly accepts and documents the narrow external-writer race that check-then-rename cannot eliminate; the other findings now have concrete changes, tests, and documentation requirements. This verdict approves the revised plan only; implementation and tests have not yet been run.

### Prior Finding Status
- **PUT preflight is not allowed — Resolved in plan; pending implementation.** Phase 2 now requires `PUT` in `corsHeaders`, with an allowed-origin preflight assertion and hostile-origin coverage.
- **Revision check does not cover the external-write race — Partially resolved / accepted limitation.** The plan narrows the guarantee to edits visible at the revision check and documents the remaining check-to-rename race. It does not claim to prevent all concurrent external writes.
- **Atomic rename replaces a selected symlink — Resolved in plan; pending implementation.** Save operations reject symlink config paths and config tests cover the behavior.
- **File-mode claims need an OS qualification — Resolved in plan.** POSIX mode guarantees are separated from Windows behavior; ACLs remain unchanged and owner-only access is not promised on Windows.
- **Workspace lockfile update is omitted — Resolved in plan; pending implementation.** Phase 1 now names the `payo/pnpm-lock.yaml` importer update.
- **Persistence failure cleanup is not exercised — Resolved in plan; pending implementation.** Config tests require injected write/rename failure coverage, original-byte preservation, and temp-file cleanup.
- **Dirty-draft guard does not define browser-history exits — Resolved in plan; pending implementation.** The plan specifies in-app and Back/Forward handling plus the native before-unload warning, with tests.
- **Validation errors need explicit accessible associations — Resolved in plan; pending implementation.** The plan specifies field associations, invalid state, an accessible submission error, and component assertions.

### Coverage
- **Checked:** Updated persistence, HTTP/CORS, dependency/lockfile, permission, browser navigation, accessibility, and test requirements against the relevant current source files; all affected prior finding titles compared.
- **Unverified:** The feature is not implemented. No proposed tests, Windows behavior, or manual browser flows were executed.
- **New findings:** None identified in the revised plan.

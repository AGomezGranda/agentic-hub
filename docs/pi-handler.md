# Portable personal Pi configuration

The Pi handler makes this editable Git checkout the source of truth for an
**explicitly owned subset** of personal Pi declarations. The committed
[`pi/manifest.json`](../pi/manifest.json) selects **no packages, settings, or
environment variables**. Installing/upgrading agentic-hub changes no personal Pi
configuration. Application is always explicit.

This is separate from skill distribution and behavior modes. `sync`, skill
install/remove, and `mode` never call the handler. Pi apply does not install hub
skills, change instruction files, configure MCP, or migrate subagent definitions.
There is no Pi TUI page, background synchronization, binary installer, credential
manager, or runtime extension-readiness check.

## Commands and paths

```text
agentic-hub pi status [--manifest PATH]
agentic-hub pi doctor [--manifest PATH]
agentic-hub pi apply [--manifest PATH] [--dry-run]
agentic-hub pi bump [--manifest PATH] [--dry-run]
```

Every subcommand accepts `--manifest`. The default is `pi/manifest.json` relative
to the resolved **editable checkout**, not the caller's current directory.
A missing default manifest is an error explaining the editable-checkout
requirement, not an empty setup. Standalone wheel asset distribution is not
supported. Relative overrides resolve from the caller's directory; `~` expands.

The agent directory is resolved at invocation time from `PI_CODING_AGENT_DIR`,
otherwise `~/.pi/agent`. An empty override uses the default. Nonempty relative
roots resolve from the caller's directory and expand `~`. Files are:

| Path under the agent directory | Purpose |
|---|---|
| `settings.json` | Pi's personal settings and package declarations |
| `agentic-hub/pi-state.json` | Private ownership and pending-operation journal |
| `agentic-hub/apply.lock` | Exclusive apply lock, with the hub PID |

Status reports **declared configuration**, not whether an extension is loaded or
a running model has adopted a setting. Output states are `in-sync`, `pending`,
`conflict`, and `error`. Actions distinguish creation, adoption, recreation,
update, restoration, removal, and ownership release. Paths and setting/package
identities appear in output; arbitrary setting values and subprocess output do
not. Actions/status go to stdout; diagnostics go to stderr.

| Exit | Meaning |
|---|---|
| `0` | Successful inspection (ordinary pending changes included), conflict-free dry-run, completed apply, or successful doctor checks |
| `1` | Conflict, invalid input, failed inspection/apply/doctor, or recovery required |
| `2` | Invalid argparse command syntax |

Status and dry-run never create configuration directories, state, backups, or
locks, and never resolve or launch Pi. An empty manifest with no ownership is an
apply no-op too: no writes and no Pi subprocess. An empty manifest **with prior
ownership** requests release/reconciliation and can therefore change files and
remove hub-introduced packages.

### Doctor is not a zero-write upstream guarantee

Doctor checks manifest/settings/state validity and readability, the agent-root
layout, Pi launcher/version availability, and the presence of declared
environment variables. It may invoke **only `pi --version`**, never an agent
session, MCP connection, or package installation. Newer versions are reported as
unverified; older than 1.4.0 fails the version check. Authentication, individual
extension readiness, model access, and package runtime compatibility are not
promised.

Doctor makes no handler-owned configuration or ownership changes. However,
upstream startup can create transient settings/installation locks and clean
managed-install staging before reporting a version. **A temporary HOME or agent
root does not isolate maintenance in the selected launcher's installation
tree.** Use a separate disposable Pi installation when complete filesystem
isolation is required. The same caveat applies to apply's package-version
preflight and manual version/help probes.

## Manifest version 1

All four fields are required; unknown fields and other versions are rejected:

```json
{
  "version": 1,
  "packages": [],
  "settings": {},
  "required_env": []
}
```

- `packages`: only string npm sources with exact semantic versions, for example
  the **fictional** `npm:@example/reviewed-tools@1.2.3`. Prerelease/build components
  are supported. Unversioned sources, tags, ranges, duplicate package names,
  filtered object entries, git sources, and local paths are not managed in v1.
  Review third-party source before selecting a package: installation can execute
  third-party code and have effects outside settings. `status`, `doctor` and
  `apply` do no version discovery, downloads, caching, or npm invocation. Only
  `pi bump` runs `npm view <name> version` (the registry's `latest` tag, using
  your own npm configuration) and rewrites the exact pins in the manifest text,
  preserving formatting; it never installs. It is all-or-nothing: any lookup
  failure leaves the manifest untouched. Review the diff, then run `pi apply`.
  The latest version may require a newer Pi than 1.4.0, and a prerelease pin
  ahead of `latest` would be bumped *down*. Adopted packages still reject
  version changes at apply time (see Packages).
- `settings`: a JSON object flattened into nonempty nested-object leaf paths.
  Arrays, scalars, and null are indivisible managed leaves. Arrays are replaced,
  not union-merged. Empty nested managed containers, duplicate JSON keys,
  nonfinite numbers, reserved top-level `packages`/`$schema`, and overlapping
  leaf/container shapes are rejected. Empty top-level `settings` is valid.
  No string interpolation, shell evaluation, home expansion inside values, or
  secret resolution takes place.
- `required_env`: unique environment-variable names. Doctor checks only whether
  each is nonempty, reporting names, never values. The handler does not persist
  or inject their values. Pi children inherit the ordinary process environment,
  with `PI_CODING_AGENT_DIR` set to the resolved agent root; `required_env` does
  not modify that environment.

**Never put literal credentials in the tracked manifest.** Managed literal
values necessarily enter Git and private ownership metadata. Validation cannot
reliably detect all secrets. Keep authentication, auth/session files, and
machine-specific credentials local and outside this repository. Ownership state
never backs up the whole settings document or unrelated credentials.

## Ownership: creation is not takeover

The state schema binds ownership to the canonical manifest path. Another
manifest cannot take over until the first has released its ownership. Changing
the contents of the same manifest is the normal reconciliation workflow.

### Settings

For each leaf the hub tracks its path, last applied value, original presence and
value, and whether it was introduced or adopted.

- An absent leaf can be created. An identical existing leaf can be adopted
  without rewriting settings. A different unowned value is a conflict: change
  the manifest or edit local configuration deliberately. There is no force or
  adopt-overwrite option.
- Updates require the observed value to equal the last applied value. Local
  divergence blocks both updates and cleanup, even if the manifest also changed.
  A missing still-desired owned leaf can be recreated. Missing owned targets
  are drift during cleanup: restore/resolve the last applied declaration before
  release, rather than silently discarding ownership.
- Removing a leaf from the manifest restores its original value when it was
  present, otherwise removes the introduced leaf. Unrelated siblings survive.
  Only empty containers introduced and recorded by the hub are pruned.
  Containers with local siblings remain; tracking ends when their last managed
  descendant is released. Preexisting empty containers are not pruned.
- Changing a managed path between a leaf and a container is a conflict in one
  invocation. Release the old shape first, verify status, then introduce the
  new shape if local configuration permits it.

### Packages

The hub tracks package name, exact source, and introduced/adopted provenance.
It recognizes identities in existing string npm declarations and source-bearing
object entries to detect ambiguity; that does not make object filters manageable.

- A matching exact string declaration can be adopted without launching Pi.
  A different version, filtered object, or duplicate/ambiguous identity conflicts.
- Managed updates require the observed source to equal the last applied source.
  A missing desired declaration can be recreated through Pi.
- For **hub-introduced** packages, install uses `pi install <exact-source>
  --no-approve`; removal uses `pi remove <current-owned-source> --no-approve`.
  Version changes use install with the new exact pin, verifying only the desired
  declaration remains.
- Releasing an **adopted** package only releases tracking. It never deletes the
  preexisting declaration or installation. Changing an adopted version is
  rejected: release it, resolve the declaration manually, then introduce/adopt
  the desired version in a later invocation.
- Merely appearing in the current manifest is never proof of destructive
  ownership. Missing state does not authorize removal.

## Delegated package writes and process control

The launcher is found with PATH lookup for `pi`, then `~/.pi/agent/bin/pi`.
Relocating configuration does not relocate the fallback installation launcher.
Package mutations initially require **exactly Pi 1.4.0**, the version whose
persistence implementation was inspected. Newer versions remain disabled until
their persistence contract is validated. Status, dry-run, setting-only apply,
and adoption/release without package subprocesses do not need Pi. npm must be
available only for planned package subprocesses, unless settings configure an
alternative nonempty `npmCommand` argument array. Pi, not the hub, invokes it.

Pi 1.4.0 rewrites the full settings file and applies migrations. Before any
planned package subprocess (including pending install retries), the handler
rejects settings with applicable migrations:

- `queueMode` when `steeringMode` is absent;
- boolean `websockets` when `transport` is absent;
- legacy object-form `skills`;
- any `retry.maxDelayMs` in an object-form `retry`.

It also requires a conservative lossless ECMAScript JSON numeric subset:
integers within ±9007199254740991, and finite binary64 noninteger values.
Diagnostics identify paths and reasons, not values. Migrate/repair locally, then
replan. The hub does not migrate or save originals of unrelated settings.
These restrictions are **not blanket validity rules**: otherwise-valid settings
with migrations/large integers remain usable for setting-only application or
package adoption/release without a subprocess. JSON comparison is semantic,
not formatting-sensitive or sensitive to `1` versus `1.0` spelling.

Package mutation is supported only on **POSIX with process-group control and a
system `ps` utility**. Unsupported platforms fail before handler writes. Pi runs
with an argument vector, no shell, stdin/output discarded, a neutral temporary
working directory, `--no-approve`, and a bounded timeout (120 seconds). Output is
not captured, so neither secrets nor inherited collection pipes are retained.

Each command starts a new session/process group. On timeout or handled
interruption, the group receives termination, then forced kill if necessary,
with bounded grace periods and direct-child reaping. The hub checks for active
group members even after a successful direct-child exit. Zombie-only members
cannot write and are not treated as active installers. If group shutdown cannot
be established, **both lock and journal remain** and retry is blocked.

This covers ordinary inherited installer children, not deliberately detached or
hostile processes. It is lifecycle control, not a sandbox or a promise to undo
third-party side effects.

## Apply, concurrency, and partial progress

The complete plan is preflighted before handler mutation. Apply then takes an
exclusive lock and replans, journaling before each operation. Package commands
run sequentially, with fresh settings reads and repeated compatibility checks
before further subprocesses. Setting changes use fresh snapshots after package
operations. Both expected managed state **and preservation of unrelated JSON
values/package entries** are checked, even after exit 0. Unexpected unrelated
changes create a persistent `repair` marker with reason/path only.

Settings/state targets must be regular, single-link files, not symbolic links,
hard-linked files, malformed JSON, or invalid UTF-8. Direct target-root/metadata
directory symlinks and unsuitable roots are rejected. This is deliberately
narrower than behavior-mode symlink handling. Existing settings permissions are
preserved; new settings, lock, and state files are owner-readable/writable only.
Hub writes use same-directory temporary files, fsync, identity/content checks,
and atomic replacement, with temporary-file cleanup on failure.

**Do not edit settings or state concurrently with apply**, including from a
running Pi settings writer. Atomic hub replacement is not a cross-process
transaction with Pi. Pi's own full-file writer is not made atomic by the hub.
Successful earlier operations remain when a later one fails; there is no unsafe
reverse package rollback or all-or-nothing installation guarantee.

### Recovery checklist

1. Stop and read the sanitized diagnostic. Status reports pending recovery as an
   error. Do not remove ownership merely to get a green status.
2. If a lock remains, inspect its owning PID and the journal's PID/process-group
   identity. Establish that the hub and **all ordinary installer descendants**
   are stopped before any manual lock removal or retry. After an abrupt hub
   crash, managed pre/post equality alone is insufficient: installers may still
   be running. Check descendants/group even if process metadata is missing or
   incomplete. PID reuse and detached processes mean identifiers are aids to
   investigation, not proof of quiescence. If uncertain, leave the lock in place.
3. Only after that investigation, manually remove the lock if appropriate.
   There is no stale-lock deletion, force command, or automated crash takeover.
4. Ensure settings and ownership are readable, valid JSON with safe file layout.
   A truncated/malformed file left by Pi requires **explicit local repair** from
   your own knowledge/private backup. The journal contains managed pre/post
   values, not a backup of unrelated settings or credentials, and cannot recover
   them. Do not paste configuration or child output into shared logs.
5. For an ordinary pending operation, apply resumes only if the observed managed
   target equals its recorded pre-state or post-state. Ambiguity blocks until
   explicitly corrected. Interrupted installs are retried **through Pi** even
   if the desired declaration is already present: declaration equality does not
   prove dependencies installed. A completed journaled removal needs no new
   subprocess.
6. A nonempty `repair` array is different: it blocks retry even when managed
   values match. Inspect and repair the actual local settings (including
   unrelated contents), verify pending pre/post expectations and provenance,
   and only then deliberately clear the `repair` array in the private state
   using a local editor. Preserve valid pending/ownership records so apply can
   resume safely; replan and apply. Clearing this marker is an explicit local
   state repair, not an automatic restoration or a new force workflow.
7. If ownership is missing/corrupt and cannot be verified, inspect and repair it
   explicitly. Never reconstruct destructive ownership from current settings or
   the manifest alone. With missing state, matching declarations can only be
   newly adopted; preexisting/adopted packages will not be removed on release.

Keep any manual recovery backups private (mode 0600) and outside Git. The hub
does not create full-settings recovery backups.

### Moving the checkout

Prefer releasing ownership from the old canonical manifest path before moving,
then applying from the new checkout. For an explicit state migration instead:

1. Verify the old path in the private state's `manifest` really identifies the
   checkout you are moving; compare the desired configuration and current owned
   declarations locally. Require no pending operation, repair marker, lock, or
   running hub/installer processes.
2. Save a private copy of the ownership file. Move/clone the same reviewed
   revision, and determine the new manifest's canonical path (for example with
   Python `Path(...).resolve()`).
3. Edit only the top-level `manifest` binding to that verified canonical path in
   `agentic-hub/pi-state.json`, retaining the ownership records and private file
   permissions. Do not change provenance to claim previously unowned resources.
4. Run status and dry-run before apply. Mismatches are reasons to stop, not
   reasons to rewrite values or delete state. Never perform automatic takeover.

## Second-machine bootstrap

1. Install prerequisites separately: Python 3.11+, uv, and Pi. For package
   mutation use Pi 1.4.0 on supported POSIX; install npm or configure an
   alternative locally. Pi's own Node/runtime requirements are its installer’s
   responsibility, not agentic-hub's.
2. Clone this repository and check out the same reviewed revision. Review the
   tracked manifest; the shared baseline is intentionally empty.
3. From the checkout, run `uv tool install --editable .`. Keep the checkout at
   that location. The CLI can then be used from another directory.
4. Select the intended HOME/`PI_CODING_AGENT_DIR` locally, if not using defaults.
   Authenticate Pi locally outside the repository; do not copy auth/session
   files or credentials into Git.
5. After acknowledging doctor's upstream maintenance caveat, run
   `agentic-hub pi doctor`, then `agentic-hub pi apply --dry-run` and inspect
   every action. Resolve conflicts locally.
6. Run `agentic-hub pi apply` explicitly, then `agentic-hub pi status`. Before
   first real package adoption, complete a separately reviewed disposable
   real-package lifecycle trial; fake-runtime tests do not establish upstream
   runtime compatibility.

To release a configured machine, remove managed entries from the **same**
manifest, apply, and verify status before uninstalling/downgrading the handler.
Removing the tool alone leaves owned configuration installed. Adopted packages
remain intentionally; release does not undo third-party installation effects.

## Isolated manual smoke test

**Before running any version/help/doctor probe:** an explicitly selected
installed launcher can perform maintenance in its own installation tree, even
with the temporary roots below. Obtain permission for that effect, or use a
separate disposable Pi installation for complete filesystem isolation. No real
personal configuration or package install is needed for the mandatory setting
round trip. Use a shell separate from your normal agent session:

```sh
# Select an absolute, reviewed launcher path; do not assume config-root relocation
# also relocated the installation. Remember the maintenance warning above.
launcher=/absolute/path/to/reviewed/pi
workspace=$(mktemp -d)
export HOME="$workspace/home"
export PI_CODING_AGENT_DIR="$workspace/agent"
mkdir -p "$HOME" "$workspace/bin"
ln -s "$launcher" "$workspace/bin/pi"
export PATH="$workspace/bin:$PATH"
cd "$workspace"

"$launcher" --version
"$launcher" install --help  # verify --no-approve is accepted; no source/install
"$launcher" remove --help

printf '%s\n' '{"version":1,"packages":[],"settings":{"quietStartup":true},"required_env":[]}' > manifest.json
agentic-hub pi doctor --manifest "$workspace/manifest.json"
agentic-hub pi apply --dry-run --manifest "$workspace/manifest.json"
agentic-hub pi apply --manifest "$workspace/manifest.json"
agentic-hub pi apply --manifest "$workspace/manifest.json"  # in-sync, no-op
printf '%s\n' '{"version":1,"packages":[],"settings":{},"required_env":[]}' > manifest.json
agentic-hub pi apply --manifest "$workspace/manifest.json"
agentic-hub pi status --manifest "$workspace/manifest.json"
```

Verify locally that `quietStartup` returned to its original absence and the
committed default manifest is unchanged and empty. On failure, keep the
workspace for recovery inspection. After successful release, discard it.
Optional real package lifecycle testing requires a **separately reviewed,
disposable package** and explicit permission; never add it to the committed
baseline just for testing. Do not inspect or copy personal credentials.

### Recorded verification for this implementation

- Final automated suite: **448 passed**, plus Ruff, pyrefly, CLI help, and
  `git diff --check`. Adapter tests use a Python fake executable; no npm/network/live
  provider or installed Pi/Node runtime is required by the default suite.
- Mandatory setting round trip: **passed** using temporary HOME/agent root and
  a synthetic nested nonsecret setting, from outside the checkout. Verified
  read-only preview, apply, repeated unchanged no-op, and release back to `{}`.
  Launcher resolution was explicitly blocked for this setting-only trial.
- Upstream source inspected: **Pi 1.4.0** package/persistence implementation.
  Synthetic migration/numeric fixtures record source locations and SHA-256 in
  `tests/fixtures/pi-1.4.0-persistence.json`; these are source-derived examples,
  not claims of live package execution.
- **Actual live Pi version tested: none.** Installed-launcher version/help probes
  are pending separate approval because of the maintenance caveat. Documentation
  confirms `--no-approve`; installed help has not yet been smoke-tested.
- **Real package lifecycle: not exercised; runtime compatibility unverified.**
  Fake process tests prove the adapter's tested contracts, not that a particular
  third-party package is safe or compatible.

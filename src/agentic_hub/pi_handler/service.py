"""CLI-facing orchestration for explicit personal Pi configuration."""

import copy
import os
from dataclasses import dataclass, field, replace
from pathlib import Path

from . import runtime
from .config import JSON, Manifest, PiPaths, load_manifest, package_name, resolve_paths
from .planner import (
    Change,
    Plan,
    build_plan,
    declarations,
    delegated_write_issues,
    equal,
    lookup,
    same,
)
from .state import (
    ApplyLock,
    ObservedSettings,
    OwnershipState,
    PendingOperation,
    Value,
    acquire_lock,
    atomic_json,
    checkpoint,
    decode_state,
    encode_state,
    encode_value,
    read_settings,
    read_state,
    unchanged,
)


def inspect_setup(manifest_path: Path | None = None) -> Plan:
    try:
        manifest = load_manifest(manifest_path)
        paths = resolve_paths(manifest.path)
        state = read_state(paths)
        plan = build_plan(manifest, read_settings(paths), state)
        plan.paths = paths
        if paths.lock.exists() or paths.lock.is_symlink():
            plan.errors.append(
                f"apply lock present: {paths.lock}; recovery inspection required"
            )
        return plan
    except ValueError as exc:
        return Plan(errors=[str(exc)])
    except (OSError, RuntimeError):
        return Plan(
            errors=["Pi configuration inspection failed; check paths and permissions"]
        )


@dataclass
class ApplyResult:
    ok: bool
    changes: list[Change] = field(default_factory=list)
    diagnostics: list[str] = field(default_factory=list)


def _operation(change: Change) -> dict[str, JSON]:
    return {
        "kind": change.kind,
        "action": change.action,
        "path": list(change.path),
        "name": change.name,
        "before": encode_value(change.before),
        "after": encode_value(change.after),
        "prune": [list(p) for p in change.prune],
    }


def _decode_operation(data: dict[str, JSON]) -> Change:
    if set(data) != {"kind", "action", "path", "name", "before", "after", "prune"}:
        raise ValueError("invalid pending operation; inspect state locally")
    kind, action, path, name, prune = (
        data["kind"],
        data["action"],
        data["path"],
        data["name"],
        data["prune"],
    )
    if (
        kind not in ("setting", "package")
        or action
        not in ("create", "update", "recreate", "remove", "restore", "adopt", "release")
        or not isinstance(path, list)
        or not all(isinstance(k, str) for k in path)
        or not isinstance(name, str)
        or not isinstance(prune, list)
    ):
        raise ValueError("invalid pending operation; inspect state locally")
    values: list[Value] = []
    for field_name in ("before", "after"):
        v = data[field_name]
        if (
            not isinstance(v, dict)
            or set(v) != {"present", "value"}
            or type(v["present"]) is not bool
            or (not v["present"] and v["value"] is not None)
        ):
            raise ValueError("invalid pending presence")
        values.append(Value(bool(v["present"]), v["value"]))
    if (kind == "setting" and (not path or path[0] in ("packages", "$schema"))) or (
        kind == "package" and not name
    ):
        raise ValueError("invalid pending target")
    if kind == "package" and (
        path
        or action == "restore"
        or any(
            v.present
            and (
                not isinstance(v.value, str)
                or package_name(v.value, exact=True) != name
            )
            for v in values
        )
    ):
        raise ValueError("invalid pending package source")
    if kind == "setting" and (name or any(isinstance(v.value, dict) for v in values)):
        raise ValueError("invalid pending setting leaf")
    pruned = []
    for p in prune:
        if not isinstance(p, list) or not p or not all(isinstance(k, str) for k in p):
            raise ValueError("invalid pending container")
        pruned.append(tuple(str(k) for k in p))
    return Change(
        "setting" if kind == "setting" else "package",
        str(action),
        values[0],
        values[1],
        tuple(str(k) for k in path),
        name,
        prune=tuple(pruned),
    )


def _managed(observed: ObservedSettings, change: Change) -> Value:
    return (
        declarations(observed.data, change.name)
        if change.kind == "package"
        else lookup(observed.data, change.path)
    )


def _next_state(
    state: OwnershipState, change: Change, manifest: Manifest, data: dict[str, JSON]
) -> OwnershipState:
    result = replace(
        state,
        settings=list(state.settings),
        packages=list(state.packages),
        containers=list(state.containers),
        pending=None,
    )
    if change.kind == "setting":
        result.settings = [
            owner for owner in result.settings if owner.path != change.path
        ]
        if change.setting_owner:
            result.settings.append(change.setting_owner)
        result.containers = sorted(set(result.containers) | set(change.containers))
        result.containers = [
            p
            for p in result.containers
            if lookup(data, p).present
            and any(owner.path[: len(p)] == p for owner in result.settings)
        ]
    else:
        result.packages = [
            owner for owner in result.packages if owner.name != change.name
        ]
        if change.package_owner:
            result.packages.append(change.package_owner)
    result.manifest = manifest.path if result.settings or result.packages else None
    return result


def _changed_packages(result: dict[str, JSON], change: Change) -> dict[str, JSON]:
    entries = result.get("packages", [])
    assert isinstance(entries, list)
    # Pi replaces an existing identity at its index, or appends a new one.
    replaced = False
    updated: list[JSON] = []
    for entry in entries:
        source = entry.get("source") if isinstance(entry, dict) else entry
        if isinstance(source, str) and package_name(source) == change.name:
            if change.after.present and not replaced:
                updated.append(change.after.value)
            replaced = True
        else:
            updated.append(entry)
    if change.after.present and not replaced:
        updated.append(change.after.value)
    result["packages"] = updated
    return result


def _changed_settings(data: dict[str, JSON], change: Change) -> dict[str, JSON]:
    result = copy.deepcopy(data)
    if change.kind == "package":
        return _changed_packages(result, change)
    if same(change.before, change.after):
        return result
    parent = result
    for key in change.path[:-1]:
        child = parent.setdefault(key, {})
        if not isinstance(child, dict):
            raise ValueError(f"{change.identity}: parent changed; replan")
        parent = child
    if change.after.present:
        parent[change.path[-1]] = change.after.value
    else:
        parent.pop(change.path[-1], None)
    for path in sorted(change.prune, key=len, reverse=True):
        if same(lookup(result, path), Value(True, {})):
            container: JSON = result
            for key in path[:-1]:
                container = container[key] if isinstance(container, dict) else None
            if isinstance(container, dict):
                container.pop(path[-1], None)
    return result


def _preflight(
    manifest: Manifest, observed: ObservedSettings, state: OwnershipState
) -> Plan:
    if state.manifest is not None and state.manifest != manifest.path:
        return Plan(
            conflicts=[
                f"ownership belongs to {state.manifest}; release before changing manifests"
            ]
        )
    candidate = state
    pending_change: Change | None = None
    if state.pending:
        pending_change = _decode_operation(state.pending.operation)
        recovered = decode_state(state.pending.next_state)
        if (
            recovered.pending is not None
            or recovered.manifest not in (None, manifest.path)
            or state.pending.package_command != pending_change.subprocess
        ):
            raise ValueError(
                "invalid pending ownership checkpoint; inspect and repair locally"
            )
        managed = _managed(observed, pending_change)
        if not same(managed, pending_change.before) and not same(
            managed, pending_change.after
        ):
            raise ValueError(
                "ambiguous pending managed state; inspect and repair locally"
            )
        candidate = (
            recovered
            if same(managed, pending_change.after)
            else replace(state, pending=None)
        )
        if candidate.manifest not in (None, manifest.path):
            raise ValueError("pending ownership belongs to a different manifest")
    plan = build_plan(manifest, observed, candidate)
    if state.repair:
        plan.errors.extend(
            f"manual repair required: {reason}" for reason in state.repair
        )
    if pending_change and _pending_runs(pending_change, observed):
        plan.conflicts.extend(delegated_write_issues(observed.data))
    return plan


def _execute_setting(
    paths: PiPaths,
    observed: ObservedSettings,
    change: Change,
    expected: dict[str, JSON],
) -> ObservedSettings:
    if not equal(observed.data, expected):
        assert observed.snapshot is not None
        atomic_json(observed.snapshot, expected)
    fresh = read_settings(paths)
    if not equal(fresh.data, expected):
        raise ValueError("settings postcondition failed; inspect locally")
    return fresh


class RecoveryUncertain(ValueError):
    """Recovery metadata could not be made durable; retain the lock."""


def _mark_repair(paths: PiPaths, state: OwnershipState, reason: str) -> None:
    state.repair.append(reason)
    try:
        checkpoint(paths, state)
    except (OSError, ValueError):
        raise RecoveryUncertain(
            "manual repair required; marker persistence failed; retain lock and inspect locally"
        ) from None
    raise ValueError(
        f"manual repair required: {reason}; inspect locally and repair ownership state explicitly"
    )


def _unrelated_packages(data: dict[str, JSON], change: Change) -> dict[str, JSON]:
    result = copy.deepcopy(data)
    entries = result.get("packages", [])
    assert isinstance(entries, list)
    result["packages"] = [
        entry
        for entry in entries
        if not (isinstance(entry, str) and package_name(entry) == change.name)
    ]
    return result


def _execute_package(
    paths: PiPaths,
    observed: ObservedSettings,
    change: Change,
    state: OwnershipState,
    adapter: runtime.PiRuntime,
) -> ObservedSettings:
    issues = delegated_write_issues(observed.data)
    if issues:
        raise ValueError("; ".join(issues))
    adapter.preflight(observed.data)
    assert observed.snapshot is not None
    unchanged(observed.snapshot)
    expected = _changed_settings(observed.data, change)

    def active(group: int) -> None:
        assert state.pending is not None
        state.pending.pid = os.getpid()
        state.pending.process_group = group
        checkpoint(paths, state)

    adapter.on_process = active
    failure: ValueError | None = None
    try:
        if change.action == "remove":
            assert isinstance(change.before.value, str)
            adapter.remove(change.before.value)
        else:
            assert isinstance(change.after.value, str)
            adapter.install(change.after.value)
    except ValueError as exc:
        failure = exc
    if not adapter.shutdown_certain:
        raise RecoveryUncertain(
            "installer shutdown uncertain; lock and journal retained; inspect hub and installer process group before manual recovery"
        )
    try:
        fresh = read_settings(paths)
    except (ValueError, OSError):
        _mark_repair(
            paths, state, "settings.json: unreadable or invalid after Pi write"
        )
        raise AssertionError("unreachable") from None
    if not equal(
        _unrelated_packages(observed.data, change),
        _unrelated_packages(fresh.data, change),
    ):
        _mark_repair(
            paths,
            state,
            "settings.json: unrelated JSON values changed during package operation",
        )
    if failure is not None:
        raise failure
    if not equal(fresh.data, expected):
        raise ValueError(
            f"{change.name}: Pi exited successfully without the expected declaration; journal retained"
        )
    return fresh


def _pending_runs(change: Change, observed: ObservedSettings) -> bool:
    return change.subprocess and (
        change.action != "remove" or _managed(observed, change).present
    )


def _needs_runtime(
    plan: Plan, state: OwnershipState, observed: ObservedSettings
) -> bool:
    return bool(
        plan.package_commands
        or (
            state.pending
            and _pending_runs(_decode_operation(state.pending.operation), observed)
        )
    )


def _apply_locked(
    manifest: Manifest, paths: PiPaths, result: ApplyResult, adapter: runtime.PiRuntime
) -> None:
    state, observed = read_state(paths), read_settings(paths)
    plan = _preflight(manifest, observed, state)
    if plan.errors or plan.conflicts:
        raise ValueError("; ".join(plan.errors + plan.conflicts))
    if _needs_runtime(plan, state, observed):
        adapter.preflight(observed.data)
    if state.pending:
        change = _decode_operation(state.pending.operation)
        if change.subprocess and (
            change.action != "remove" or same(_managed(observed, change), change.before)
        ):
            observed = _execute_package(paths, observed, change, state, adapter)
        elif not change.subprocess:
            expected = (
                _changed_settings(observed.data, change)
                if same(_managed(observed, change), change.before)
                else observed.data
            )
            observed = _execute_setting(paths, observed, change, expected)
        recovered = decode_state(state.pending.next_state)
        recovered.snapshot = state.snapshot
        checkpoint(paths, recovered)
        state = recovered
    while True:
        observed = read_settings(paths)
        plan = build_plan(manifest, observed, state)
        if plan.errors or plan.conflicts:
            raise ValueError("; ".join(plan.errors + plan.conflicts))
        if not plan.changes:
            return
        change = plan.changes[0]
        if change.subprocess:
            adapter.preflight(observed.data)
        expected = _changed_settings(observed.data, change)
        next_state = _next_state(state, change, manifest, expected)
        state.manifest = manifest.path
        state.pending = PendingOperation(
            _operation(change), encode_state(next_state), change.subprocess
        )
        checkpoint(paths, state)
        if change.subprocess:
            _execute_package(paths, observed, change, state, adapter)
        else:
            _execute_setting(paths, observed, change, expected)
        next_state.snapshot = state.snapshot
        checkpoint(paths, next_state)
        state = next_state
        result.changes.append(change)


def _finish_lock(
    lock: ApplyLock | None, adapter: runtime.PiRuntime | None, result: ApplyResult
) -> None:
    if lock is None:
        return
    if adapter is not None and not adapter.shutdown_certain:
        lock.retain = True
    try:
        lock.release()
    except (OSError, ValueError):
        result.ok = False
        result.diagnostics.append(
            "could not release apply lock safely; inspect locally"
        )


def apply_setup(manifest_path: Path | None = None) -> ApplyResult:
    result = ApplyResult(False)
    lock: ApplyLock | None = None
    adapter: runtime.PiRuntime | None = None
    try:
        manifest = load_manifest(manifest_path)
        paths = resolve_paths(manifest.path)
        observed, state = read_settings(paths), read_state(paths)
        plan = _preflight(manifest, observed, state)
        if plan.errors or plan.conflicts:
            raise ValueError("; ".join(plan.errors + plan.conflicts))
        if paths.lock.exists() or paths.lock.is_symlink():
            raise ValueError(
                f"apply lock present; inspect hub and installer descendants: {paths.lock}"
            )
        if plan.changes or state.pending:
            adapter = runtime.PiRuntime(paths)
            if _needs_runtime(plan, state, observed):
                adapter.preflight(observed.data)
            lock = acquire_lock(paths)
            _apply_locked(manifest, paths, result, adapter)
        result.ok = True
    except RecoveryUncertain as exc:
        if lock is not None:
            lock.retain = True
        result.diagnostics.append(str(exc))
    except KeyboardInterrupt:
        result.diagnostics.append(
            "Pi apply interrupted; inspect the pending journal before retry"
        )
    except ValueError as exc:
        result.diagnostics.append(str(exc))
    except (OSError, RuntimeError):
        result.diagnostics.append(
            "Pi apply failed; inspect settings, ownership journal and permissions before retry"
        )
    finally:
        _finish_lock(lock, adapter, result)
    return result


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str


def doctor(manifest_path: Path | None = None) -> list[Check]:
    plan = inspect_setup(manifest_path)
    checks = [
        Check(
            "configuration",
            not plan.errors and not plan.conflicts,
            "; ".join(plan.errors + plan.conflicts)
            or "manifest, settings, ownership and agent-root layout readable",
        )
    ]
    try:
        manifest = load_manifest(manifest_path)
        for name in manifest.required_env:
            checks.append(
                Check(
                    name,
                    bool(os.environ.get(name)),
                    "present"
                    if os.environ.get(name)
                    else "missing or empty environment variable",
                )
            )
        paths = resolve_paths(manifest.path)
        version = runtime.probe_version(runtime.resolve_launcher(), paths)
        label = ".".join(map(str, version))
        detail = (
            f"{label}: older than supported Pi 1.4.0"
            if version < (1, 4, 0)
            else f"{label}: unverified; package mutation disabled"
            if version > (1, 4, 0)
            else label
        )
        checks.append(Check("Pi version", version >= (1, 4, 0), detail))
    except ValueError as exc:
        checks.append(Check("Pi version", False, str(exc)))
    except OSError:
        checks.append(
            Check("Pi version", False, "probe failed; check paths and permissions")
        )
    return checks

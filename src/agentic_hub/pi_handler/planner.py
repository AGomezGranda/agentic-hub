"""Pure declaration reconciliation; no launcher or filesystem access."""

import math
from dataclasses import dataclass, field
from typing import Literal

from .config import JSON, Manifest, PiPaths, SettingPath, flatten_settings, package_name
from .state import (
    ObservedSettings,
    OwnershipState,
    PackageOwnership,
    SettingOwnership,
    Value,
)


@dataclass(frozen=True)
class Change:
    kind: Literal["setting", "package"]
    action: str
    before: Value
    after: Value
    path: SettingPath = ()
    name: str = ""
    setting_owner: SettingOwnership | None = None
    package_owner: PackageOwnership | None = None
    prune: tuple[SettingPath, ...] = ()
    containers: tuple[SettingPath, ...] = ()

    @property
    def subprocess(self) -> bool:
        return self.kind == "package" and self.action in {
            "create",
            "update",
            "recreate",
            "remove",
        }

    @property
    def identity(self) -> str:
        return self.name if self.kind == "package" else ".".join(self.path)


@dataclass
class Plan:
    changes: list[Change] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    paths: PiPaths | None = None

    @property
    def status(self) -> str:
        return (
            "error"
            if self.errors
            else "conflict"
            if self.conflicts
            else "pending"
            if self.changes
            else "in-sync"
        )

    @property
    def package_commands(self) -> list[Change]:
        return [change for change in self.changes if change.subprocess]


def equal(left: JSON, right: JSON) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            equal(v, right[k]) for k, v in left.items()
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            equal(a, b) for a, b in zip(left, right, strict=True)
        )
    return left == right


def same(left: Value, right: Value) -> bool:
    return left.present == right.present and (
        not left.present or equal(left.value, right.value)
    )


def lookup(data: dict[str, JSON], path: SettingPath) -> Value:
    node: JSON = data
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return Value()
        node = node[key]
    return Value(True, node)


def declarations(data: dict[str, JSON], name: str) -> Value:
    entries = data.get("packages", [])
    assert isinstance(entries, list)
    matches: list[JSON] = []
    for entry in entries:
        source = entry.get("source") if isinstance(entry, dict) else entry
        if isinstance(source, str) and package_name(source) == name:
            matches.append(entry)
    if not matches:
        return Value()
    return Value(True, matches[0] if len(matches) == 1 else matches)


def delegated_write_issues(data: dict[str, JSON]) -> list[str]:
    paths: list[str] = []
    if "queueMode" in data and "steeringMode" not in data:
        paths.append("queueMode")
    if isinstance(data.get("websockets"), bool) and "transport" not in data:
        paths.append("websockets")
    if isinstance(data.get("skills"), dict):
        paths.append("skills")
    retry = data.get("retry")
    if isinstance(retry, dict) and "maxDelayMs" in retry:
        paths.append("retry.maxDelayMs")
    issues = [
        f"{path}: Pi 1.4.0 migration would change settings; migrate locally and replan"
        for path in paths
    ]

    def numbers(value: JSON, path: str) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            unsafe = (
                abs(value) > 9007199254740991
                if isinstance(value, int) or value.is_integer()
                else not math.isfinite(value)
            )
            if unsafe:
                issues.append(
                    f"{path}: outside lossless ECMAScript JSON subset; repair locally and replan"
                )
        elif isinstance(value, dict):
            for key, child in value.items():
                numbers(child, f"{path}.{key}" if path else key)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                numbers(child, f"{path}.{index}")

    numbers(data, "")
    return issues


def _settings(
    manifest: Manifest, observed: ObservedSettings, state: OwnershipState, plan: Plan
) -> None:
    desired = flatten_settings(manifest.settings)
    owned = {record.path: record for record in state.settings}
    all_paths = set(desired) | set(owned)
    for path in sorted(all_paths):
        label = ".".join(path)
        if any(other != path and other[: len(path)] == path for other in all_paths):
            plan.conflicts.append(f"{label}: overlapping managed leaf/container shapes")
            continue
        if any(
            lookup(observed.data, path[:i]).present
            and not isinstance(lookup(observed.data, path[:i]).value, dict)
            for i in range(1, len(path))
        ):
            plan.conflicts.append(f"{label}: existing parent is not an object")
            continue
        before = lookup(observed.data, path)
        owner = owned.get(path)
        if owner is not None and before.present and not equal(before.value, owner.last):
            plan.conflicts.append(f"{label}: managed local edit; resolve locally")
            continue
        if path not in desired:
            assert owner is not None
            if not before.present:
                plan.conflicts.append(
                    f"{label}: owned leaf is missing; restore the last applied value before cleanup"
                )
            else:
                plan.changes.append(
                    Change(
                        "setting",
                        "restore" if owner.original.present else "remove",
                        before,
                        owner.original,
                        path=path,
                        prune=tuple(state.containers),
                    )
                )
            continue
        value = desired[path]
        if owner is None:
            if before.present and not equal(before.value, value):
                plan.conflicts.append(
                    f"{label}: different unowned value; edit locally or change manifest"
                )
                continue
            action = "adopt" if before.present else "create"
            owner = SettingOwnership(
                path, value, before, "adopted" if before.present else "introduced"
            )
        else:
            if before.present and equal(before.value, value):
                continue
            action = "update" if before.present else "recreate"
            owner = SettingOwnership(path, value, owner.original, owner.ownership)
        containers = tuple(
            path[:i]
            for i in range(1, len(path))
            if not lookup(observed.data, path[:i]).present
        )
        plan.changes.append(
            Change(
                "setting",
                action,
                before,
                Value(True, value),
                path=path,
                setting_owner=owner,
                containers=containers,
            )
        )


def _packages(
    manifest: Manifest, observed: ObservedSettings, state: OwnershipState, plan: Plan
) -> None:
    desired: dict[str, str] = {}
    for source in manifest.packages:
        name = package_name(source, exact=True)
        assert name is not None
        desired[name] = source
    owned = {record.name: record for record in state.packages}
    for name in sorted(set(desired) | set(owned)):
        assert name is not None
        before = declarations(observed.data, name)
        owner = owned.get(name)
        if owner and before.present and not equal(before.value, owner.source):
            plan.conflicts.append(f"{name}: managed declaration drift or ambiguity")
            continue
        if name not in desired:
            assert owner is not None
            if not before.present:
                plan.conflicts.append(
                    f"{name}: owned declaration is missing; resolve locally before cleanup"
                )
                continue
            action = "remove" if owner.introduced else "release"
            plan.changes.append(
                Change(
                    "package",
                    action,
                    before,
                    Value() if action == "remove" else before,
                    name=name,
                )
            )
            continue
        source = desired[name]
        if owner is None:
            if before.present and not equal(before.value, source):
                plan.conflicts.append(
                    f"{name}: different, filtered, or ambiguous declaration"
                )
                continue
            action = "adopt" if before.present else "create"
            owner = PackageOwnership(name, source, not before.present)
        else:
            if source != owner.source and not owner.introduced:
                plan.conflicts.append(
                    f"{name}: adopted version change requires release and manual resolution"
                )
                continue
            if before.present and equal(before.value, source):
                continue
            action = "update" if before.present else "recreate"
            owner = PackageOwnership(name, source, owner.introduced)
        plan.changes.append(
            Change(
                "package",
                action,
                before,
                Value(True, source),
                name=name,
                package_owner=owner,
            )
        )


def build_plan(
    manifest: Manifest, observed: ObservedSettings, state: OwnershipState
) -> Plan:
    plan = Plan()
    if state.manifest is not None and state.manifest != manifest.path:
        plan.conflicts.append(
            f"ownership belongs to {state.manifest}; release it before changing manifests"
        )
        return plan
    if state.repair:
        plan.errors.extend(
            f"manual repair required: {reason}" for reason in state.repair
        )
    if state.pending is not None:
        plan.errors.append(
            "pending operation: recovery required; inspect installer descendants before removing a crash lock"
        )
    if not isinstance(observed.data.get("packages", []), list):
        plan.errors.append("packages: expected an array")
        return plan
    _packages(manifest, observed, state, plan)
    _settings(manifest, observed, state, plan)
    pending_command = bool(state.pending and state.pending.package_command)
    if state.pending:
        operation = state.pending.operation
        name = operation.get("name")
        if (
            operation.get("action") == "remove"
            and isinstance(name, str)
            and not declarations(observed.data, name).present
        ):
            pending_command = False
    if plan.package_commands or pending_command:
        plan.conflicts.extend(delegated_write_issues(observed.data))
    return plan

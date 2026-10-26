"""Local observations and ownership records. Reads never create files."""

import json
import os
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from .config import JSON, PiPaths, SettingPath, package_name, parse_json


@dataclass(frozen=True)
class Value:
    present: bool = False
    value: JSON = None


@dataclass(frozen=True)
class SettingOwnership:
    path: SettingPath
    last: JSON
    original: Value = Value()
    ownership: str = "introduced"


@dataclass(frozen=True)
class PackageOwnership:
    name: str
    source: str
    introduced: bool = True


@dataclass
class PendingOperation:
    operation: dict[str, JSON]
    next_state: dict[str, JSON]
    package_command: bool = False
    pid: int = field(default_factory=os.getpid)
    process_group: int | None = None


@dataclass(frozen=True)
class Snapshot:
    path: Path
    content: bytes = b""
    metadata: os.stat_result | None = None


@dataclass
class OwnershipState:
    manifest: Path | None = None
    settings: list[SettingOwnership] = field(default_factory=list)
    packages: list[PackageOwnership] = field(default_factory=list)
    containers: list[SettingPath] = field(default_factory=list)
    pending: PendingOperation | None = None
    repair: list[str] = field(default_factory=list)
    snapshot: Snapshot | None = field(default=None, repr=False)


@dataclass
class ObservedSettings:
    data: dict[str, JSON] = field(default_factory=dict)
    snapshot: Snapshot | None = field(default=None, repr=False)


def validate_root(path: Path) -> None:
    # Resolve platform aliases in ancestors (e.g. macOS /var), not target links.
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            if candidate == path or not candidate.is_dir():
                raise ValueError(
                    f"symbolic-link directory is unsupported or unsuitable: {candidate}"
                )
        elif candidate.exists() and not candidate.is_dir():
            raise ValueError(f"unsuitable directory: {candidate}")


def read_snapshot(path: Path) -> Snapshot:
    validate_root(path.parent)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return Snapshot(path)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(
            f"unsafe nonregular, symbolic-link, or hard-linked file: {path}"
        )
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise ValueError(f"file changed during read: {path}")
        content = stream.read()
    if _identity(path.lstat()) != _identity(metadata):
        raise ValueError(f"file changed during read: {path}")
    return Snapshot(path, content, metadata)


def read_settings(paths: PiPaths) -> ObservedSettings:
    validate_root(paths.agent_dir)
    snapshot = read_snapshot(paths.settings)
    data = parse_json(snapshot.content, paths.settings) if snapshot.metadata else {}
    if not isinstance(data.get("packages", []), list):
        raise ValueError(f"packages must be an array: {paths.settings}")
    return ObservedSettings(data, snapshot)


def _object(value: JSON, keys: set[str]) -> dict[str, JSON]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("invalid state fields")
    return value


def _path(value: JSON) -> SettingPath:
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(v, str) for v in value)
    ):
        raise ValueError("invalid setting path")
    return tuple(str(v) for v in value)


def _array(value: JSON) -> list[JSON]:
    if not isinstance(value, list):
        raise ValueError("invalid state array")
    return value


def _value(value: JSON) -> Value:
    obj = _object(value, {"present", "value"})
    if type(obj["present"]) is not bool or (
        not obj["present"] and obj["value"] is not None
    ):
        raise ValueError("invalid presence")
    return Value(bool(obj["present"]), obj["value"])


def decode_state(data: dict[str, JSON]) -> OwnershipState:
    _object(
        data,
        {
            "version",
            "manifest",
            "settings",
            "packages",
            "containers",
            "pending",
            "repair",
        },
    )
    if type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("unsupported state version")
    manifest = data["manifest"]
    if manifest is not None and (
        not isinstance(manifest, str) or not Path(manifest).is_absolute()
    ):
        raise ValueError("invalid manifest binding")
    result = OwnershipState(Path(manifest) if isinstance(manifest, str) else None)
    for entry in _array(data["settings"]):
        obj = _object(entry, {"path", "last", "original", "ownership"})
        path = _path(obj["path"])
        if path[0] in {"packages", "$schema"} or obj["ownership"] not in (
            "introduced",
            "adopted",
        ):
            raise ValueError("invalid setting ownership")
        result.settings.append(
            SettingOwnership(
                path, obj["last"], _value(obj["original"]), str(obj["ownership"])
            )
        )
    for entry in _array(data["packages"]):
        obj = _object(entry, {"name", "source", "introduced"})
        source = obj["source"]
        if (
            not isinstance(source, str)
            or not isinstance(obj["name"], str)
            or package_name(source, exact=True) != obj["name"]
            or type(obj["introduced"]) is not bool
        ):
            raise ValueError("invalid package ownership")
        result.packages.append(
            PackageOwnership(str(obj["name"]), source, bool(obj["introduced"]))
        )
    result.containers = [_path(p) for p in _array(data["containers"])]
    for reason in _array(data["repair"]):
        if not isinstance(reason, str):
            raise ValueError("invalid repair marker")
        result.repair.append(reason)
    pending = data["pending"]
    if pending is not None:
        obj = _object(
            pending,
            {"operation", "next_state", "package_command", "pid", "process_group"},
        )
        if (
            not isinstance(obj["operation"], dict)
            or not isinstance(obj["next_state"], dict)
            or type(obj["package_command"]) is not bool
            or type(obj["pid"]) is not int
            or (
                obj["process_group"] is not None
                and type(obj["process_group"]) is not int
            )
        ):
            raise ValueError("invalid pending operation")
        result.pending = PendingOperation(
            obj["operation"],
            obj["next_state"],
            bool(obj["package_command"]),
            int(str(obj["pid"])),
            int(str(obj["process_group"]))
            if obj["process_group"] is not None
            else None,
        )
    leaves = [record.path for record in result.settings]
    names = [record.name for record in result.packages]
    if (
        len(set(leaves)) != len(leaves)
        or len(set(names)) != len(names)
        or any(a != b and b[: len(a)] == a for a in leaves for b in leaves)
    ):
        raise ValueError("duplicate or overlapping ownership")
    if (
        result.settings or result.packages or result.pending
    ) and result.manifest is None:
        raise ValueError("missing manifest binding")
    return result


def encode_value(value: Value) -> dict[str, JSON]:
    return {"present": value.present, "value": value.value}


def encode_state(state: OwnershipState) -> dict[str, JSON]:
    settings: list[JSON] = [
        {
            "path": list(record.path),
            "last": record.last,
            "original": encode_value(record.original),
            "ownership": record.ownership,
        }
        for record in state.settings
    ]
    packages: list[JSON] = [
        {"name": record.name, "source": record.source, "introduced": record.introduced}
        for record in state.packages
    ]
    pending: JSON = None
    if state.pending:
        p = state.pending
        pending = {
            "operation": p.operation,
            "next_state": p.next_state,
            "package_command": p.package_command,
            "pid": p.pid,
            "process_group": p.process_group,
        }
    return {
        "version": 1,
        "manifest": str(state.manifest) if state.manifest else None,
        "settings": settings,
        "packages": packages,
        "containers": [list(p) for p in state.containers],
        "pending": pending,
        "repair": list(state.repair),
    }


def read_state(paths: PiPaths) -> OwnershipState:
    snapshot = read_snapshot(paths.state)
    if snapshot.metadata is None:
        return OwnershipState(snapshot=snapshot)
    try:
        result = decode_state(parse_json(snapshot.content, paths.state))
    except (ValueError, TypeError, RecursionError):
        raise ValueError(
            f"invalid ownership state; inspect and repair locally: {paths.state}"
        ) from None
    result.snapshot = snapshot
    return result


def _identity(metadata: os.stat_result | None) -> tuple[int, ...] | None:
    if metadata is None:
        return None
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
        metadata.st_size,
    )


def unchanged(snapshot: Snapshot) -> None:
    current = read_snapshot(snapshot.path)
    if current.content != snapshot.content or _identity(current.metadata) != _identity(
        snapshot.metadata
    ):
        raise ValueError(
            f"file changed concurrently; inspect and retry: {snapshot.path}"
        )


def _sync_directory(path: Path) -> None:
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_json(
    snapshot: Snapshot, data: dict[str, JSON], *, private: bool = False
) -> Snapshot:
    unchanged(snapshot)
    validate_root(snapshot.path.parent)
    snapshot.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    payload = (
        json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    ).encode("utf-8")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=snapshot.path.parent, prefix=".pi-hub-", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            mode = (
                stat.S_IMODE(snapshot.metadata.st_mode)
                if snapshot.metadata and not private
                else 0o600
            )
            os.fchmod(stream.fileno(), mode)
            stream.flush()
            os.fsync(stream.fileno())
        unchanged(snapshot)
        os.replace(temporary, snapshot.path)
        _sync_directory(snapshot.path.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return read_snapshot(snapshot.path)


def checkpoint(paths: PiPaths, state: OwnershipState) -> None:
    snapshot = state.snapshot or read_snapshot(paths.state)
    state.snapshot = atomic_json(snapshot, encode_state(state), private=True)


@dataclass
class ApplyLock:
    snapshot: Snapshot
    retain: bool = False

    def release(self) -> None:
        if not self.retain:
            unchanged(self.snapshot)
            self.snapshot.path.unlink()
            _sync_directory(self.snapshot.path.parent)


def acquire_lock(paths: PiPaths) -> ApplyLock:
    validate_root(paths.agent_dir)
    validate_root(paths.state.parent)
    paths.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        descriptor = os.open(paths.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError(
            f"apply lock present; inspect hub and installer descendants before manual recovery: {paths.lock}"
        ) from None
    with os.fdopen(descriptor, "w") as stream:
        json.dump({"pid": os.getpid()}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    _sync_directory(paths.state.parent)
    return ApplyLock(read_snapshot(paths.lock))

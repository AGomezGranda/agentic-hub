"""Persistent primary behavior, independent of skill installation."""

import os
import re
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from . import agents

BehaviorMode = Literal["coach", "rubber-duck", "skeptic", "interviewer"]
PROFILES: dict[BehaviorMode, Path] = {
    "coach": Path(__file__).parent / "profiles/coding-coach.md",
    "rubber-duck": Path(__file__).parent / "profiles/rubber-duck.md",
    "skeptic": Path(__file__).parent / "profiles/skeptic.md",
    "interviewer": Path(__file__).parent / "profiles/interviewer.md",
}
_MARKERS = (b"<!-- agentic-hub: coding-coach", b"<!-- agentic-hub: behavior-mode")
# The two leading and one trailing LF bytes belong to the block, not user text.
_BLOCK = re.compile(
    rb"\n\n<!-- agentic-hub: coding-coach begin created=([01]) -->\n"
    rb"(.*?)\n<!-- agentic-hub: coding-coach end -->\n",
    re.DOTALL,
)

_NAMED_BLOCK = re.compile(
    rb"\n\n<!-- agentic-hub: behavior-mode begin mode=([a-z-]+) created=([01]) -->\n"
    rb"(.*?)\n<!-- agentic-hub: behavior-mode end -->\n",
    re.DOTALL,
)


@dataclass
class _Block:
    start: int
    end: int
    mode: BehaviorMode
    created: bytes
    body: bytes


def _parse_block(data: bytes, path: Path) -> _Block | None:
    legacy = _BLOCK.search(data)
    named = _NAMED_BLOCK.search(data)
    count = sum(data.count(marker) for marker in _MARKERS)
    if count == 0:
        return None
    if count != 2 or (legacy is None) == (named is None):
        raise ValueError(f"malformed primary behavior markers: {path}")
    if legacy is not None:
        return _Block(legacy.start(), legacy.end(), "coach", legacy[1], legacy[2])
    assert named is not None
    identifier = named[1].decode("ascii")
    mode = next((mode for mode in PROFILES if mode == identifier), None)
    if mode is None:
        raise ValueError(f"unknown or invalid behavior mode: {path}")
    return _Block(named.start(), named.end(), mode, named[2], named[3])


@dataclass
class BehaviorStatus:
    state: Literal["off", "on", "stale", "error"]
    path: Path | None
    mode: BehaviorMode | None = None
    detail: str | None = None


def mode_label(mode: BehaviorMode) -> str:
    return mode.replace("-", " ").title()


def combined_state(statuses: dict[str, BehaviorStatus]) -> str:
    states = {status.state for status in statuses.values()}
    if "error" in states:
        return "ERROR"
    modes = {status.mode for status in statuses.values()}
    if states == {"on"} and len(modes) == 1:
        mode = next(iter(modes))
        if mode is not None:
            return mode_label(mode).upper()
    if states == {"off"}:
        return "OFF"
    return "MIXED"


def _root(variable: str, default: Path) -> Path:
    return Path(os.environ.get(variable) or default).expanduser().absolute()


def instruction_candidates(agent: str) -> list[Path]:
    """Ordered global instruction candidates in the current environment."""
    home = Path.home()
    if agent == "claude":
        return [_root("CLAUDE_CONFIG_DIR", home / ".claude") / "CLAUDE.md"]
    if agent == "codex":
        root = _root("CODEX_HOME", home / ".codex")
        return [root / "AGENTS.override.md", root / "AGENTS.md"]
    if agent == "pi":
        root = _root("PI_CODING_AGENT_DIR", home / ".pi/agent")
        return [
            root / name
            for name in (
                "AGENTS.override.md",
                "AGENTS.md",
                "AGENTS.MD",
                "CLAUDE.md",
                "CLAUDE.MD",
            )
        ]
    if agent == "opencode":
        if os.environ.get("OPENCODE_CONFIG_DIR") or (
            _root("XDG_CONFIG_HOME", home / ".config").resolve()
            != (home / ".config").resolve()
        ):
            raise ValueError("unsupported OpenCode layout: use the default config root")
        native = home / ".config/opencode/AGENTS.md"
        disabled = any(
            os.environ.get(name, "").lower() in ("1", "true")
            for name in (
                "OPENCODE_DISABLE_CLAUDE_CODE",
                "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
            )
        )
        if disabled:
            return [native]
        if (
            _root("CLAUDE_CONFIG_DIR", home / ".claude").resolve()
            != (home / ".claude").resolve()
        ):
            if not native.exists():
                raise ValueError(
                    "unsupported OpenCode layout: relocated Claude fallback"
                )
        return [native, home / ".claude/CLAUDE.md"]
    raise ValueError(f"unsupported host: {agent}")


@dataclass
class _File:
    path: Path
    data: bytes
    metadata: os.stat_result | None
    aliases: set[Path] = field(default_factory=set)
    block: _Block | None = None

    @property
    def key(self) -> tuple[int, int] | Path:
        if self.metadata is not None:
            return self.metadata.st_dev, self.metadata.st_ino
        return self.path


def _read(path: Path) -> _File:
    try:
        physical = path.resolve(strict=True)
        metadata = physical.stat()
    except FileNotFoundError:
        for part in (path, *path.parents):
            if part.is_symlink() and not part.exists():
                raise ValueError(f"dangling symlink: {part}") from None
        return _File(path.resolve(), b"", None, {path})
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"not a regular file: {path}")
    if metadata.st_nlink != 1:
        raise ValueError(f"multiply hard-linked file: {path}")
    data = physical.read_bytes()
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(f"not valid UTF-8: {path}") from None
    block = _parse_block(data, path)
    return _File(physical, data, metadata, {path}, block)


def _scan() -> tuple[
    dict[str, list[_File]], dict[str, _File], dict[str, BehaviorStatus]
]:
    candidates: dict[str, list[_File]] = {}
    selected: dict[str, _File] = {}
    errors: dict[str, BehaviorStatus] = {}
    files: dict[tuple[int, int] | Path, _File] = {}
    for agent in agents.AGENTS:
        path = None
        try:
            paths = instruction_candidates(agent)
            candidates[agent] = []
            for path in paths:
                item = _read(path)
                shared = files.setdefault(item.key, item)
                shared.aliases.add(path)
                candidates[agent].append(shared)
            options = candidates[agent]
            if agent == "codex":
                chosen = next((f for f in options if f.data), options[-1])
            elif agent in ("pi", "opencode"):
                fallback = options[1] if agent == "pi" else options[0]
                chosen = next((f for f in options if f.metadata is not None), fallback)
            else:
                chosen = options[0]
            selected[agent] = chosen
        except (OSError, ValueError, RuntimeError) as exc:
            errors[agent] = BehaviorStatus("error", path, detail=str(exc))
    return candidates, selected, errors


def _profile(mode: BehaviorMode) -> bytes:
    path = PROFILES[mode]
    data = path.read_bytes()
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(f"not valid UTF-8: {path}") from None
    if not data.strip() or any(marker in data for marker in _MARKERS):
        raise ValueError(f"invalid behavior profile: {path}")
    return data


def inspect() -> dict[str, BehaviorStatus]:
    """Read actual installed state without creating files or directories."""
    candidates, selected, errors = _scan()
    active = {f.key for f in selected.values()}
    result = dict(errors)
    for agent, target in selected.items():
        status = BehaviorStatus("off", target.path)
        if target.block is not None:
            status.mode = target.block.mode
            try:
                status.state = (
                    "on"
                    if target.block.body == _profile(target.block.mode)
                    else "stale"
                )
                if status.state == "stale":
                    status.detail = "Effective file contains an older or edited profile; reapply to refresh."
            except (OSError, ValueError) as exc:
                status.state, status.detail = "error", str(exc)
        leftovers = {
            f.path for f in candidates[agent] if f.block and f.key not in active
        }
        if leftovers and status.state != "error":
            status.state = "stale"
            uncertainty = (
                "potentially leftover; cleanup deferred until all hosts validate"
                if errors
                else "unclaimed"
            )
            presence = "present" if target.block else "absent"
            status.detail = (
                f"Behavior {presence} in effective file; {uncertainty} blocks: "
                + ", ".join(str(p) for p in sorted(leftovers))
                + ". Retry apply or turn off to remove."
            )
        result[agent] = status
    return {agent: result[agent] for agent in agents.AGENTS}


def _unchanged(target: _File) -> None:
    for alias in target.aliases:
        current = _read(alias)
        changed = current.key != target.key or current.data != target.data
        if current.metadata is not None and target.metadata is not None:
            changed |= (
                current.metadata.st_mode != target.metadata.st_mode
                or current.metadata.st_mtime_ns != target.metadata.st_mtime_ns
            )
        if changed:
            raise ValueError(f"conflict: instruction file changed; retry: {alias}")


def _write(target: _File, data: bytes, delete: bool = False) -> None:
    if data == target.data:
        return
    if delete:
        _unchanged(target)
        target.path.unlink()
        return
    target.path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=target.path.parent, prefix=".coach-", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            if target.metadata is not None:
                os.fchmod(stream.fileno(), stat.S_IMODE(target.metadata.st_mode))
        _unchanged(target)
        os.replace(temporary, target.path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _updated(
    target: _File, mode: BehaviorMode | None, profile: bytes | None
) -> tuple[bytes, bool]:
    block = target.block
    if mode is None:
        if block is None:
            return target.data, False
        remaining = target.data[: block.start] + target.data[block.end :]
        linked = any(p.is_symlink() for p in target.aliases)
        return remaining, block.created == b"1" and not remaining and not linked
    assert profile is not None
    created = block.created if block else (b"1" if target.metadata is None else b"0")
    marker = b"coding-coach" if mode == "coach" else b"behavior-mode"
    identity = b"" if mode == "coach" else b"mode=" + mode.encode() + b" "
    replacement = (
        b"\n\n<!-- agentic-hub: "
        + marker
        + b" begin "
        + identity
        + b"created="
        + created
        + b" -->\n"
        + profile
        + b"\n<!-- agentic-hub: "
        + marker
        + b" end -->\n"
    )
    if block:
        return target.data[: block.start] + replacement + target.data[
            block.end :
        ], False
    return target.data + replacement, False


def set_mode(mode: BehaviorMode | None) -> dict[str, BehaviorStatus]:
    """Update validated targets independently, then report state and operation errors."""
    if mode is not None and mode not in PROFILES:
        raise ValueError("unknown behavior mode")
    try:
        profile = _profile(mode) if mode is not None else None
    except (OSError, ValueError) as exc:
        return {
            agent: BehaviorStatus(
                "error",
                actual.path,
                actual.mode,
                f"{exc}; {actual.detail or ''}; observed state: {actual.state}, "
                f"mode: {actual.mode or 'off'}",
            )
            for agent, actual in inspect().items()
        }
    candidates, selected, errors = _scan()
    active = {f.key for f in selected.values()}
    targets = {f.key: f for agent in selected for f in candidates[agent]}
    for key, target in targets.items():
        if mode is not None and key not in active and errors:
            continue
        data, delete = _updated(target, mode if key in active else None, profile)
        try:
            _write(target, data, delete)
        except (OSError, ValueError, RuntimeError) as exc:
            for agent, options in candidates.items():
                if any(f.key == key for f in options):
                    if agent in errors:
                        errors[agent].detail = f"{errors[agent].detail}; {exc}"
                    else:
                        errors[agent] = BehaviorStatus(
                            "error", target.path, detail=str(exc)
                        )
    result = inspect()
    for agent, actual in result.items():
        if actual.state == "on" and actual.mode != mode and agent not in errors:
            errors[agent] = BehaviorStatus(
                "error",
                actual.path,
                actual.mode,
                f"requested {mode or 'off'} was not reached; retry or turn off",
            )
    for agent, error in errors.items():
        actual = result[agent]
        error.mode = actual.mode
        error.detail = f"{error.detail}; observed state: {actual.state}, mode: {actual.mode or 'off'}"
        result[agent] = error
    return result

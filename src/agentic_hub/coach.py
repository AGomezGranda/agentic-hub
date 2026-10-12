"""Persistent coaching instructions, independent of skill installation."""

import os
import re
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from . import agents

PROFILE_PATH = Path(__file__).parent / "profiles/coding-coach.md"
_MARKER = b"<!-- agentic-hub: coding-coach"
# The two leading and one trailing LF bytes belong to the block, not user text.
_BLOCK = re.compile(
    rb"\n\n<!-- agentic-hub: coding-coach begin created=([01]) -->\n"
    rb"(.*?)\n<!-- agentic-hub: coding-coach end -->\n",
    re.DOTALL,
)


@dataclass
class CoachStatus:
    state: Literal["off", "on", "stale", "error"]
    path: Path | None
    detail: str | None = None


def combined_state(statuses: dict[str, CoachStatus]) -> str:
    states = {status.state for status in statuses.values()}
    if "error" in states:
        return "ERROR"
    if states == {"on"}:
        return "ON"
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
    block: re.Match[bytes] | None = None

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
    block = _BLOCK.search(data)
    if data.count(_MARKER) != (2 if block else 0):
        raise ValueError(f"malformed coding-coach markers: {path}")
    return _File(physical, data, metadata, {path}, block)


def _scan() -> tuple[dict[str, list[_File]], dict[str, _File], dict[str, CoachStatus]]:
    candidates: dict[str, list[_File]] = {}
    selected: dict[str, _File] = {}
    errors: dict[str, CoachStatus] = {}
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
            errors[agent] = CoachStatus("error", path, str(exc))
    return candidates, selected, errors


def _profile() -> bytes:
    data = PROFILE_PATH.read_bytes()
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError(f"not valid UTF-8: {PROFILE_PATH}") from None
    if not data.strip() or _MARKER in data:
        raise ValueError(f"invalid coaching profile: {PROFILE_PATH}")
    return data


def inspect() -> dict[str, CoachStatus]:
    """Read actual installed state without creating files or directories."""
    candidates, selected, errors = _scan()
    active = {f.key for f in selected.values()}
    result = dict(errors)
    for agent, target in selected.items():
        status = CoachStatus("off", target.path)
        if target.block is not None:
            try:
                status.state = "on" if target.block[2] == _profile() else "stale"
                if status.state == "stale":
                    status.detail = "Effective file contains an older or edited profile; enable to refresh."
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
                f"Coaching {presence} in effective file; {uncertainty} blocks: "
                + ", ".join(str(p) for p in sorted(leftovers))
                + ". Retry enable or disable to remove."
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


def _updated(target: _File, profile: bytes | None) -> tuple[bytes, bool]:
    block = target.block
    if profile is None:
        if block is None:
            return target.data, False
        remaining = target.data[: block.start()] + target.data[block.end() :]
        linked = any(p.is_symlink() for p in target.aliases)
        return remaining, block[1] == b"1" and not remaining and not linked
    created = block[1] if block else (b"1" if target.metadata is None else b"0")
    replacement = (
        b"\n\n<!-- agentic-hub: coding-coach begin created="
        + created
        + b" -->\n"
        + profile
        + b"\n<!-- agentic-hub: coding-coach end -->\n"
    )
    if block:
        return target.data[: block.start()] + replacement + target.data[
            block.end() :
        ], False
    return target.data + replacement, False


def set_enabled(enabled: bool) -> dict[str, CoachStatus]:
    """Update validated targets independently, then report state and operation errors."""
    candidates, selected, errors = _scan()
    profile = None
    if enabled:
        try:
            profile = _profile()
        except (OSError, ValueError) as exc:
            return {
                agent: errors.get(agent)
                or CoachStatus("error", selected[agent].path, str(exc))
                for agent in agents.AGENTS
            }
    active = {f.key for f in selected.values()}
    targets = {f.key: f for agent in selected for f in candidates[agent]}
    for key, target in targets.items():
        if enabled and key not in active and errors:
            continue
        data, delete = _updated(target, profile if enabled and key in active else None)
        try:
            _write(target, data, delete)
        except (OSError, ValueError, RuntimeError) as exc:
            for agent, options in candidates.items():
                if any(f.key == key for f in options):
                    if agent in errors:
                        errors[agent].detail = f"{errors[agent].detail}; {exc}"
                    else:
                        errors[agent] = CoachStatus("error", target.path, str(exc))
    result = inspect()
    for agent, error in errors.items():
        actual = result[agent]
        error.detail = f"{error.detail}; observed state: {actual.state}"
        result[agent] = error
    return result

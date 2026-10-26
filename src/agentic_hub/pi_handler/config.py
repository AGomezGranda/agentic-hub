"""Portable manifest schema and invocation-time paths."""

import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias, cast

JSON: TypeAlias = "None | bool | int | float | str | list[JSON] | dict[str, JSON]"
SettingPath: TypeAlias = tuple[str, ...]
DEFAULT_MANIFEST = Path(__file__).resolve().parents[3] / "pi/manifest.json"
_NAME = r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*"
_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
_EXACT = re.compile(rf"npm:({_NAME})@({_VERSION})\Z")
_IDENTITY = re.compile(rf"npm:({_NAME})(?:@[^\s]+)?\Z")


@dataclass(frozen=True)
class Manifest:
    path: Path
    packages: tuple[str, ...]
    settings: dict[str, JSON]
    required_env: tuple[str, ...]


@dataclass(frozen=True)
class PiPaths:
    manifest: Path
    agent_dir: Path
    settings: Path
    state: Path
    lock: Path


def resolve_paths(manifest_path: Path) -> PiPaths:
    root = (
        Path(os.environ.get("PI_CODING_AGENT_DIR") or Path.home() / ".pi/agent")
        .expanduser()
        .absolute()
    )
    return PiPaths(
        manifest_path.resolve(),
        root,
        root / "settings.json",
        root / "agentic-hub/pi-state.json",
        root / "agentic-hub/apply.lock",
    )


def package_name(source: str, *, exact: bool = False) -> str | None:
    match = (_EXACT if exact else _IDENTITY).fullmatch(source)
    if match is None or len(match[1]) > 214:
        return None
    if exact:
        prerelease = match[2].split("+", 1)[0].partition("-")[2]
        if any(
            part.isdigit() and len(part) > 1 and part.startswith("0")
            for part in prerelease.split(".")
        ):
            return None
    return match[1]


def _unique_object(pairs: list[tuple[str, JSON]]) -> dict[str, JSON]:
    result: dict[str, JSON] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(_: str) -> JSON:
    raise ValueError("nonfinite JSON number")


def parse_json(data: bytes, path: Path) -> dict[str, JSON]:
    try:
        value = cast(
            JSON,
            json.loads(
                data.decode("utf-8"),
                object_pairs_hook=_unique_object,
                parse_constant=_invalid_constant,
            ),
        )
        if not isinstance(value, dict):
            raise ValueError("expected object")
        validate_json(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError(f"invalid JSON object: {path}") from None


def validate_json(value: JSON) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("nonfinite JSON number")
    if isinstance(value, str):
        value.encode("utf-8")
    elif isinstance(value, dict):
        for key, child in value.items():
            key.encode("utf-8")
            validate_json(child)
    elif isinstance(value, list):
        for child in value:
            validate_json(child)


def flatten_settings(settings: dict[str, JSON]) -> dict[SettingPath, JSON]:
    leaves: dict[SettingPath, JSON] = {}

    def visit(obj: dict[str, JSON], prefix: SettingPath) -> None:
        for key, value in obj.items():
            path = (*prefix, key)
            if isinstance(value, dict):
                if not value:
                    raise ValueError(f"empty managed container: {'.'.join(path)}")
                visit(value, path)
            else:
                leaves[path] = value

    visit(settings, ())
    return leaves


def load_manifest(path: Path | None = None) -> Manifest:
    target = (path or DEFAULT_MANIFEST).expanduser().resolve()
    try:
        data = parse_json(target.read_bytes(), target)
    except FileNotFoundError:
        detail = (
            "; default manifest requires an editable checkout" if path is None else ""
        )
        raise ValueError(f"missing manifest: {target}{detail}") from None
    if (
        set(data) != {"version", "packages", "settings", "required_env"}
        or type(data["version"]) is not int
        or data["version"] != 1
    ):
        raise ValueError(f"unsupported manifest schema: {target}")
    packages, settings, env = data["packages"], data["settings"], data["required_env"]
    if (
        not isinstance(packages, list)
        or not isinstance(settings, dict)
        or not isinstance(env, list)
    ):
        raise ValueError(f"invalid manifest field types: {target}")
    sources: list[str] = []
    names: set[str] = set()
    for source in packages:
        name = package_name(source, exact=True) if isinstance(source, str) else None
        if name is None or name in names:
            raise ValueError(f"packages require unique exact npm pins: {target}")
        names.add(name)
        sources.append(cast(str, source))
    variables: list[str] = []
    for name in env:
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
            or name in variables
        ):
            raise ValueError(f"required_env requires unique variable names: {target}")
        variables.append(name)
    if {"packages", "$schema"} & settings.keys():
        raise ValueError(f"reserved managed setting: {target}")
    flatten_settings(settings)
    return Manifest(target, tuple(sources), settings, tuple(variables))

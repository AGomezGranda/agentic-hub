"""Rewrite manifest package pins to the latest npm versions (never installs)."""

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .config import _VERSION, load_manifest, package_name

NPM_TIMEOUT = 30.0


@dataclass(frozen=True)
class Bump:
    name: str
    old: str
    new: str


def latest_version(name: str) -> str:
    npm = shutil.which("npm")
    if npm is None:
        raise ValueError("npm not found on PATH")
    failure = ValueError(f"cannot resolve latest version of {name}")
    try:
        with tempfile.TemporaryDirectory(prefix="agentic-hub-pi-bump-") as cwd:
            result = subprocess.run(
                [npm, "view", name, "version"],
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=NPM_TIMEOUT,
                check=False,
            )
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise failure from None
    version = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(_VERSION, version):
        raise failure
    return version


def bump_manifest(path: Path | None, *, dry_run: bool) -> list[Bump]:
    manifest = load_manifest(path)
    bumps: list[Bump] = []
    for source in manifest.packages:
        name = package_name(source, exact=True)
        assert name is not None
        old = source.rsplit("@", 1)[1]
        new = latest_version(name)
        if new != old:
            bumps.append(Bump(name, old, new))
    if not bumps:
        return bumps
    text = manifest.path.read_text()
    for item in bumps:
        pin = f'"npm:{item.name}@{item.old}"'
        if text.count(pin) != 1:
            raise ValueError(f"cannot locate {item.name} pin in manifest")
        text = text.replace(pin, f'"npm:{item.name}@{item.new}"')
    if dry_run:
        return bumps
    # validate the rewritten manifest before replacing the original
    fd, temporary = tempfile.mkstemp(dir=manifest.path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        shutil.copymode(manifest.path, temporary)
        load_manifest(Path(temporary))
        os.replace(temporary, manifest.path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return bumps

#!/usr/bin/env python3
"""Set up agentic-hub: install dependencies, write the payo config, run payo's preflight.

Run as `uv run scripts/setup.py` (portable). Plain `python3` needs 3.11+.
Stdlib only.
"""

import json
import os
import shutil
import subprocess
import sys
import tomllib
from collections.abc import Mapping
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAYO = ROOT / "payo"
TEMPLATE = PAYO / "config.example.toml"
NODE_MAJOR_MIN = 24


def config_path(env: Mapping[str, str]) -> Path:
    """Mirror payo's resolveConfigPath: an explicit value must be absolute."""
    if "PAYO_CONFIG_FILE" in env:
        explicit = env["PAYO_CONFIG_FILE"].strip()
        if not Path(explicit).is_absolute():
            sys.exit("setup: PAYO_CONFIG_FILE must be an absolute path")
        return Path(explicit)
    return Path.home() / ".config" / "payo" / "config.toml"


def pi_bin(env: Mapping[str, str]) -> str:
    """Mirror payo's PAYO_PI_BIN: unset means "pi"; a set value is trimmed, blank is an error."""
    if "PAYO_PI_BIN" not in env:
        return "pi"
    value = env["PAYO_PI_BIN"].strip()
    if not value:
        sys.exit("setup: PAYO_PI_BIN must not be blank")
    return value


def render_config(template: str, repo: Path) -> str:
    """Append the repo path to the shared template and check the result parses."""
    # ensure_ascii=False: TOML rejects \u escapes for astral characters (emoji).
    text = f"{template.rstrip()}\n\n[paths]\nrepo = {json.dumps(str(repo), ensure_ascii=False)}\n"
    tomllib.loads(text)
    return text


def write_config(path: Path, text: str) -> bool:
    """Create the config without overwriting; returns False if it already exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        if path.is_file():
            return False
        raise  # dangling link or non-file: main reports it
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
    except BaseException:
        path.unlink(missing_ok=True)  # never leave a truncated file that blocks reruns
        raise
    return True


def config_repo(path: Path) -> Path | None:
    """The repo a kept config points at, or None if unset, unreadable or malformed."""
    try:
        paths = tomllib.loads(path.read_text(encoding="utf-8")).get("paths")
        repo = paths.get("repo") if isinstance(paths, dict) else None
        return Path(repo).resolve() if isinstance(repo, str) and repo else None
    except (OSError, ValueError):
        return None


def require(tool: str, hint: str) -> None:
    if shutil.which(tool) is None:
        sys.exit(f"setup: {tool} not found. {hint}")


def require_node() -> None:
    require("node", f"payo needs Node {NODE_MAJOR_MIN}.")
    try:
        result = subprocess.run(
            ["node", "-p", "process.versions.node.split('.')[0]"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        sys.exit(f"setup: cannot run node: {error}")
    if result.returncode != 0:
        sys.exit(f"setup: `node -p` failed: {result.stderr.strip()}")
    major = result.stdout.strip()
    if not major.isdigit() or int(major) < NODE_MAJOR_MIN:
        sys.exit(f"setup: payo needs Node {NODE_MAJOR_MIN} or newer")


def run(args: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(args)}  (in {cwd.relative_to(ROOT) or '.'})", flush=True)
    result = subprocess.run(args, cwd=cwd, check=False)
    if result.returncode != 0:
        sys.exit(f"setup: `{' '.join(args)}` failed with exit code {result.returncode}")


def main() -> None:
    path = config_path(os.environ)  # validate before any install work
    pi_bin(os.environ)  # blank check only: preflight checks the pi payo actually runs
    require("uv", "Install uv: https://docs.astral.sh/uv/")
    require_node()
    require("pnpm", "Install pnpm 10.9: https://pnpm.io/installation")

    run(["uv", "sync"], ROOT)
    run(["pnpm", "install", "--frozen-lockfile"], PAYO)

    overridden = os.environ.get("PAYO_REPO", "").strip()
    if overridden and Path(overridden).resolve() != ROOT:
        print(
            f"warning: PAYO_REPO={overridden} overrides the repo in the config at serve time"
        )

    try:
        created = write_config(path, render_config(TEMPLATE.read_text(), ROOT))
    except (
        OSError,
        ValueError,
    ) as error:  # TOMLDecodeError and UnicodeEncodeError are ValueError
        sys.exit(f"setup: cannot create {path}: {error}")
    if created:
        print(f"wrote {path} (repo = {ROOT})")
    else:
        print(f"kept existing {path}")
        kept = config_repo(path)
        if kept != ROOT:
            print(
                f"warning: {path} points at {kept or 'no repo (unset or unreadable)'}, not {ROOT}"
            )

    preflight = subprocess.run(["pnpm", "--dir", str(PAYO), "preflight"], check=False)
    if preflight.returncode != 0:
        sys.exit(
            "setup: preflight found blocking failures above. Fix them, then rerun "
            "`uv run scripts/setup.py`."
        )
    print("setup: preflight passed. Data dir and token are checked when serve starts.")
    print("Start the server with `pnpm -C payo payo serve`.")


if __name__ == "__main__":
    main()

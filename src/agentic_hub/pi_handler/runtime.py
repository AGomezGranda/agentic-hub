"""Sanitized Pi process boundary."""

import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .config import JSON, PiPaths

PACKAGE_TIMEOUT = 120.0
SHUTDOWN_GRACE = 1.0


def process_control_supported() -> bool:
    return (
        os.name == "posix"
        and hasattr(os, "killpg")
        and any(Path(p).is_file() for p in ("/bin/ps", "/usr/bin/ps"))
    )


class RuntimeFailure(ValueError):
    """A process failure safe to display without child output."""


def resolve_launcher() -> Path:
    found = shutil.which("pi")
    fallback = Path.home() / ".pi/agent/bin/pi"
    if found:
        return Path(found).absolute()
    if fallback.is_file() and os.access(fallback, os.X_OK):
        return fallback
    raise RuntimeFailure("Pi launcher not found on PATH or ~/.pi/agent/bin/pi")


def child_environment(paths: PiPaths) -> dict[str, str]:
    return dict(os.environ, PI_CODING_AGENT_DIR=str(paths.agent_dir))


def probe_version(launcher: Path, paths: PiPaths) -> tuple[int, int, int]:
    try:
        with tempfile.TemporaryDirectory(prefix="agentic-hub-pi-version-") as cwd:
            result = subprocess.run(
                [str(launcher), "--version"],
                cwd=cwd,
                env=child_environment(paths),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        match = re.fullmatch(r"(?:pi\s+)?(\d+)\.(\d+)\.(\d+)\s*", result.stdout)
        if result.returncode != 0 or match is None:
            raise RuntimeFailure(
                "Pi version probe failed or returned an unsupported version format"
            )
        return int(match[1]), int(match[2]), int(match[3])
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise RuntimeFailure("Pi version probe failed; child output withheld") from None


class PiRuntime:
    def __init__(self, paths: PiPaths) -> None:
        self.paths = paths
        self.launcher: Path | None = None
        self.validated = False
        self.active_group: int | None = None
        self.shutdown_certain = True
        self.on_process: Callable[[int], None] = lambda group: None

    def preflight(self, settings: dict[str, JSON]) -> None:
        if not process_control_supported():
            raise RuntimeFailure(
                "package mutation requires POSIX process-group lifecycle control"
            )
        if not self.validated:
            self.launcher = resolve_launcher()
            if probe_version(self.launcher, self.paths) != (1, 4, 0):
                raise RuntimeFailure(
                    "package mutation requires validated Pi 1.4.0; installed version is unverified or older"
                )
            self.validated = True
        command = settings.get("npmCommand")
        configured = (
            isinstance(command, list)
            and bool(command)
            and all(isinstance(part, str) and part for part in command)
        )
        if not configured and shutil.which("npm") is None:
            raise RuntimeFailure(
                "package mutation requires npm or a configured npmCommand"
            )

    def install(self, source: str) -> None:
        self._run("install", source)

    def remove(self, source: str) -> None:
        self._run("remove", source)

    def _group_active(self, group: int) -> bool:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        # Zombies cannot write and can outlive their parent under a slow init reaper.
        ps = next(p for p in ("/bin/ps", "/usr/bin/ps") if Path(p).is_file())
        try:
            result = subprocess.run(
                [ps, "-eo", "pgid=,stat="],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=1,
                check=False,
            )
            if result.returncode:
                return True
            for line in result.stdout.splitlines():
                fields = line.split()
                if (
                    len(fields) >= 2
                    and int(fields[0]) == group
                    and not fields[1].startswith("Z")
                ):
                    return True
            return False
        except (OSError, ValueError, subprocess.SubprocessError):
            return True

    @staticmethod
    def _signal_group(group: int, sig: signal.Signals) -> None:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass

    def _settled(self, child: subprocess.Popen[bytes], deadline: float) -> bool:
        while time.monotonic() < deadline:
            child.poll()
            assert self.active_group is not None
            if not self._group_active(self.active_group):
                child.wait(timeout=max(0.01, deadline - time.monotonic()))
                return True
            time.sleep(0.02)
        return False

    def _shutdown(self, child: subprocess.Popen[bytes]) -> None:
        assert self.active_group is not None
        try:
            self._signal_group(self.active_group, signal.SIGTERM)
            self.shutdown_certain = self._settled(
                child, time.monotonic() + SHUTDOWN_GRACE
            )
            if not self.shutdown_certain:
                self._signal_group(self.active_group, signal.SIGKILL)
                self.shutdown_certain = self._settled(
                    child, time.monotonic() + SHUTDOWN_GRACE
                )
            child.wait(timeout=SHUTDOWN_GRACE)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            self.shutdown_certain = False

    def _run(self, command: str, source: str) -> None:
        if not self.validated:
            self.preflight({})
        assert self.launcher is not None
        previous = None
        child: subprocess.Popen[bytes] | None = None
        if threading.current_thread() is threading.main_thread():
            previous = signal.signal(signal.SIGTERM, _interrupt)
        try:
            with tempfile.TemporaryDirectory(prefix="agentic-hub-pi-package-") as cwd:
                # Discard output rather than retaining secrets or waiting on inherited pipes.
                child = subprocess.Popen(
                    [str(self.launcher), command, source, "--no-approve"],
                    cwd=cwd,
                    env=child_environment(self.paths),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                self.active_group = child.pid
                self.shutdown_certain = False
                self.on_process(child.pid)
                try:
                    code = child.wait(timeout=PACKAGE_TIMEOUT)
                except subprocess.TimeoutExpired:
                    raise RuntimeFailure(
                        f"Pi {command} timed out; pending operation retained"
                    ) from None
                if self._group_active(child.pid):
                    raise RuntimeFailure(
                        f"Pi {command} left active installer descendants; pending operation retained"
                    )
                self.shutdown_certain = True
                if code:
                    raise RuntimeFailure(
                        f"Pi {command} failed (exit {code}); child output withheld; inspect and retry"
                    )
        except KeyboardInterrupt:
            raise RuntimeFailure(
                f"Pi {command} interrupted; pending operation retained"
            ) from None
        except OSError:
            raise RuntimeFailure(
                f"Pi {command} could not execute; child output withheld"
            ) from None
        finally:
            if child is not None and not self.shutdown_certain:
                self._shutdown(child)
            if previous is not None:
                signal.signal(signal.SIGTERM, previous)


def _interrupt(signum: int, frame: object) -> None:
    raise KeyboardInterrupt

import json
import os
import signal
import threading
import time
from pathlib import Path

import pytest

from agentic_hub.pi_handler import runtime, service, state
from agentic_hub.pi_handler.config import resolve_paths

pytestmark = pytest.mark.usefixtures("fake_pi")


def test_launcher_lookup_ignores_relocated_agent_root(
    fake_pi: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "relocated"))
    assert runtime.resolve_launcher() == fake_pi
    fake_pi.unlink()
    fallback = Path.home() / ".pi/agent/bin/pi"
    fallback.parent.mkdir(parents=True)
    fallback.write_text("fake")
    fallback.chmod(0o700)
    assert runtime.resolve_launcher() == fallback


def test_install_uses_exact_argument_vector_and_neutral_cwd(tmp_path: Path) -> None:
    paths = resolve_paths(tmp_path / "manifest.json")
    adapter = runtime.PiRuntime(paths)
    adapter.install("npm:@scope/demo@1.2.3")
    calls = [
        json.loads(line)
        for line in (tmp_path / "pi-commands.jsonl").read_text().splitlines()
    ]
    assert calls[0]["argv"] == ["install", "npm:@scope/demo@1.2.3", "--no-approve"]
    assert Path(calls[0]["cwd"]) != tmp_path
    assert not Path(calls[0]["cwd"]).exists()
    assert calls[0]["root"] == str(paths.agent_dir)
    assert adapter.shutdown_certain


@pytest.mark.parametrize("mode, message", [("hang", "timed out"), ("fail", "exit 7")])
def test_timeout_and_child_failure_are_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str, message: str
) -> None:
    monkeypatch.setenv("HUB_FAKE_MODE", mode)
    monkeypatch.setattr(runtime, "PACKAGE_TIMEOUT", 0.15)
    monkeypatch.setattr(runtime, "SHUTDOWN_GRACE", 0.15)
    adapter = runtime.PiRuntime(resolve_paths(tmp_path / "manifest.json"))
    with pytest.raises(runtime.RuntimeFailure, match=message) as exc:
        adapter.install("npm:demo@1.0.0")
    assert "secret-child-output" not in str(exc.value)
    assert adapter.shutdown_certain


def package_manifest(tmp_path: Path) -> Path:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            dict(version=1, packages=["npm:demo@1.0.0"], settings={}, required_env=[])
        )
    )
    return manifest


def child_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> Path:
    delayed = tmp_path / "delayed-write"
    monkeypatch.setenv("HUB_FAKE_MODE", mode)
    monkeypatch.setenv("HUB_DELAYED_WRITE", str(delayed))
    monkeypatch.setenv("HUB_CHILD_READY", str(tmp_path / "child-ready"))
    monkeypatch.setattr(runtime, "PACKAGE_TIMEOUT", 0.3)
    monkeypatch.setattr(runtime, "SHUTDOWN_GRACE", 0.15)
    return delayed


@pytest.mark.skipif(
    not runtime.process_control_supported(), reason="POSIX process groups required"
)
@pytest.mark.parametrize("mode", ["child", "stubborn"])
def test_timeout_stops_installer_group_before_unlock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    delayed = child_environment(tmp_path, monkeypatch, mode)
    manifest = package_manifest(tmp_path)
    assert not service.apply_setup(manifest).ok
    paths = resolve_paths(manifest)
    assert state.read_state(paths).pending is not None
    assert not paths.lock.exists()
    time.sleep(1.6)
    assert not delayed.exists()
    monkeypatch.delenv("HUB_FAKE_MODE")
    assert service.apply_setup(manifest).ok


@pytest.mark.skipif(
    not runtime.process_control_supported(), reason="POSIX process groups required"
)
def test_interruption_stops_installer_group_before_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    delayed = child_environment(tmp_path, monkeypatch, "stubborn")
    monkeypatch.setattr(runtime, "PACKAGE_TIMEOUT", 5)
    manifest = package_manifest(tmp_path)

    def interrupt() -> None:
        deadline = time.monotonic() + 3
        while not (tmp_path / "child-ready").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        if (tmp_path / "child-ready").exists():
            os.kill(os.getpid(), signal.SIGTERM)

    sender = threading.Thread(target=interrupt)
    sender.start()
    try:
        result = service.apply_setup(manifest)
    finally:
        sender.join()
    assert not result.ok
    assert any("interrupted" in message for message in result.diagnostics)
    assert not resolve_paths(manifest).lock.exists()
    time.sleep(1.6)
    assert not delayed.exists()
    monkeypatch.delenv("HUB_FAKE_MODE")
    assert service.apply_setup(manifest).ok


@pytest.mark.skipif(
    not runtime.process_control_supported(), reason="POSIX process groups required"
)
def test_output_collection_respects_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    delayed = child_environment(tmp_path, monkeypatch, "pipes")
    start = time.monotonic()
    result = service.apply_setup(package_manifest(tmp_path))
    assert not result.ok
    assert time.monotonic() - start < 2
    time.sleep(1.6)
    assert not delayed.exists()


def test_uncertain_shutdown_retains_lock_and_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    child_environment(tmp_path, monkeypatch, "hang")
    manifest = package_manifest(tmp_path)
    # Simulate inability to establish group quiescence; the real direct child is killed.
    monkeypatch.setattr(runtime.PiRuntime, "_group_active", lambda self, group: True)
    result = service.apply_setup(manifest)
    assert not result.ok
    paths = resolve_paths(manifest)
    assert paths.lock.exists()
    pending = state.read_state(paths).pending
    assert pending is not None and pending.process_group is not None
    before = (tmp_path / "pi-commands.jsonl").read_bytes()
    assert not service.apply_setup(manifest).ok
    assert (tmp_path / "pi-commands.jsonl").read_bytes() == before

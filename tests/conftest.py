import sys
from pathlib import Path

import pytest

from agentic_hub import behavior


@pytest.fixture
def isolated_pi_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", "")
    for name in (
        "PI_CODING_AGENT_DIR",
        "PI_PACKAGE_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.fixture
def fake_pi(
    isolated_pi_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    directory = tmp_path / "bin"
    directory.mkdir()
    launcher = directory / "pi"
    script = Path(__file__).parent / "fixtures/fake_pi.py"
    launcher.write_text(f"#!{sys.executable}\n" + script.read_text())
    launcher.chmod(0o700)
    npm = directory / "npm"
    npm.write_text("#!/bin/sh\nexit 0\n")
    npm.chmod(0o700)
    monkeypatch.setenv("PATH", str(directory))
    monkeypatch.setenv("HUB_FAKE_LOG", str(tmp_path / "pi-commands.jsonl"))
    return launcher


@pytest.fixture
def isolated_behavior_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    for name in (
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "PI_CODING_AGENT_DIR",
        "OPENCODE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "OPENCODE_DISABLE_CLAUDE_CODE",
        "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
    ):
        monkeypatch.delenv(name, raising=False)
    profiles = {}
    for mode in behavior.PROFILES:
        profile = tmp_path / f"{mode}.md"
        profile.write_text(
            "Coach the current objective.\n" if mode == "coach" else f"{mode} role.\n"
        )
        profiles[mode] = profile
    monkeypatch.setattr(behavior, "PROFILES", profiles)

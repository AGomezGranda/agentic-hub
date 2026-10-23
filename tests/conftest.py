from pathlib import Path

import pytest

from agentic_hub import behavior


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

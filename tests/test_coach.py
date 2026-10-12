import os
from pathlib import Path
from unittest.mock import Mock

import pytest

from agentic_hub import agents, coach

pytestmark = pytest.mark.usefixtures("isolated_coach_home")


@pytest.mark.parametrize(
    "statuses,expected",
    [
        ([coach.CoachStatus("on", None), coach.CoachStatus("on", None)], "ON"),
        ([coach.CoachStatus("off", None), coach.CoachStatus("off", None)], "OFF"),
        ([coach.CoachStatus("on", None), coach.CoachStatus("off", None)], "MIXED"),
        ([coach.CoachStatus("stale", None)], "MIXED"),
        ([coach.CoachStatus("error", None), coach.CoachStatus("on", None)], "ERROR"),
        ([coach.CoachStatus("stale", None), coach.CoachStatus("error", None)], "ERROR"),
        ([], "MIXED"),
    ],
)
def test_combined_coach_state(statuses: list[coach.CoachStatus], expected: str) -> None:
    assert coach.combined_state({str(i): s for i, s in enumerate(statuses)}) == expected


def test_default_off_is_read_only(tmp_path: Path) -> None:
    before = list(tmp_path.rglob("*"))
    for result in (coach.inspect(), coach.set_enabled(False)):
        assert set(result) == set(agents.AGENTS)
        assert {s.state for s in result.values()} == {"off"}
        assert all(s.path is not None for s in result.values())
    assert list(tmp_path.rglob("*")) == before


def put(path: Path, data: bytes = b"user instructions") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.mark.parametrize(
    "agent,env,files,expected",
    [
        ("claude", {"CLAUDE_CONFIG_DIR": "~/custom"}, {}, "custom/CLAUDE.md"),
        ("claude", {"CLAUDE_CONFIG_DIR": ""}, {}, ".claude/CLAUDE.md"),
        (
            "codex",
            {},
            {".codex/AGENTS.override.md": b"override"},
            ".codex/AGENTS.override.md",
        ),
        (
            "codex",
            {},
            {".codex/AGENTS.override.md": b"", ".codex/AGENTS.md": b"base"},
            ".codex/AGENTS.md",
        ),
        ("codex", {"CODEX_HOME": "relative"}, {}, "relative/AGENTS.md"),
        (
            "pi",
            {},
            {".pi/agent/AGENTS.override.md": b""},
            ".pi/agent/AGENTS.override.md",
        ),
        ("pi", {}, {".pi/agent/AGENTS.MD": b""}, ".pi/agent/AGENTS.MD"),
        ("pi", {}, {".pi/agent/CLAUDE.MD": b""}, ".pi/agent/CLAUDE.MD"),
        ("pi", {"PI_CODING_AGENT_DIR": "~/custom"}, {}, "custom/AGENTS.md"),
        ("opencode", {}, {".claude/CLAUDE.md": b""}, ".claude/CLAUDE.md"),
        (
            "opencode",
            {},
            {".config/opencode/AGENTS.md": b"", ".claude/CLAUDE.md": b"x"},
            ".config/opencode/AGENTS.md",
        ),
        (
            "opencode",
            {"OPENCODE_DISABLE_CLAUDE_CODE": "1"},
            {".claude/CLAUDE.md": b"x"},
            ".config/opencode/AGENTS.md",
        ),
        (
            "opencode",
            {"OPENCODE_DISABLE_CLAUDE_CODE_PROMPT": "true"},
            {".claude/CLAUDE.md": b"x"},
            ".config/opencode/AGENTS.md",
        ),
        (
            "opencode",
            {"OPENCODE_DISABLE_CLAUDE_CODE": "false"},
            {".claude/CLAUDE.md": b"x"},
            ".claude/CLAUDE.md",
        ),
    ],
)
def test_resolves_effective_global_instruction_file(
    tmp_path: Path,
    agent: str,
    env: dict[str, str],
    files: dict[str, bytes],
    expected: str,
) -> None:
    with pytest.MonkeyPatch.context() as patch:
        patch.chdir(tmp_path)
        for key, value in env.items():
            patch.setenv(key, value)
        for name, data in files.items():
            put(tmp_path / name, data)
        status = coach.inspect()[agent]
    assert status.state == "off"
    expected_path = tmp_path / expected
    assert status.path is not None
    if expected_path.exists():
        assert status.path.samefile(expected_path)
    else:
        assert status.path == expected_path


@pytest.mark.parametrize(
    "name", ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]
)
def test_unsupported_opencode_layout_is_reported_without_guessing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
) -> None:
    monkeypatch.setenv(name, str(tmp_path / "custom"))
    status = coach.inspect()["opencode"]
    assert status.state == "error"
    assert "unsupported" in (status.detail or "").lower()
    assert not (tmp_path / ".config").exists()


def test_unknown_host_is_explicit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(agents, "AGENTS", {"custom": (tmp_path, "symlink")})
    status = coach.inspect()["custom"]
    assert status.state == "error"
    assert "unsupported host" in (status.detail or "")


@pytest.mark.parametrize("original", [None, b"", b"user\n", b"user\r\n", b"user"])
@pytest.mark.parametrize("later", [b"", b"\nLater user text\r\n"])
def test_toggle_round_trip_preserves_user_bytes(
    tmp_path: Path,
    original: bytes | None,
    later: bytes,
) -> None:
    path = tmp_path / ".claude/CLAUDE.md"
    if original is not None:
        put(path, original)
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    installed = path.read_bytes()
    assert coach.PROFILE_PATH.read_bytes() in installed
    path.write_bytes(installed + later)
    assert {s.state for s in coach.set_enabled(False).values()} == {"off"}
    if original is None and not later:
        assert not path.exists()
    else:
        assert path.read_bytes() == (original or b"") + later


def test_repeated_enable_is_idempotent_and_refreshes_stale_profile(
    tmp_path: Path,
) -> None:
    coach.set_enabled(True)
    path = tmp_path / ".claude/CLAUDE.md"
    before = path.stat()
    data = path.read_bytes()
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    assert path.stat() == before
    assert path.read_bytes() == data
    coach.PROFILE_PATH.write_text("Updated coaching contract.\n")
    assert {s.state for s in coach.inspect().values()} == {"stale"}
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    assert coach.PROFILE_PATH.read_bytes() in path.read_bytes()
    path.write_bytes(b"New preface\n" + path.read_bytes())
    coach.set_enabled(False)
    assert path.read_bytes() == b"New preface\n"


def test_disable_removes_shadowed_blocks_without_profile_source(tmp_path: Path) -> None:
    coach.set_enabled(True)
    base = tmp_path / ".codex/AGENTS.md"
    put(tmp_path / ".codex/AGENTS.override.md")
    assert coach.inspect()["codex"].state == "stale"
    coach.PROFILE_PATH.unlink()
    assert {s.state for s in coach.set_enabled(False).values()} == {"off"}
    assert not base.exists()
    assert (tmp_path / ".codex/AGENTS.override.md").read_bytes() == b"user instructions"


def test_shared_claude_opencode_target_is_updated_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = put(tmp_path / ".claude/CLAUDE.md")
    replace = Mock(wraps=os.replace)
    monkeypatch.setattr(coach.os, "replace", replace)
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    assert sum(call.args[1] == path for call in replace.call_args_list) == 1
    assert not (tmp_path / ".config").exists()
    coach.PROFILE_PATH.write_text("New profile\n")

    def fail_shared(source: Path, destination: Path) -> None:
        if destination == path:
            raise OSError("injected shared write failure")
        replace(source, destination)

    monkeypatch.setattr(coach.os, "replace", fail_shared)
    result = coach.set_enabled(True)
    assert result["claude"].state == result["opencode"].state == "error"
    assert result["pi"].state == result["codex"].state == "on"
    assert "observed state: stale" in (result["claude"].detail or "")


def test_native_opencode_preserves_claude_coaching(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    claude = put(tmp_path / ".claude/CLAUDE.md", b"claude user\r\n")
    native = put(tmp_path / ".config/opencode/AGENTS.md", b"opencode user")
    for _ in range(2):
        assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
        assert coach.PROFILE_PATH.read_bytes() in claude.read_bytes()
        assert coach.PROFILE_PATH.read_bytes() in native.read_bytes()
    claude.write_bytes(
        claude.read_bytes().replace(b"Coach the current objective.", b"Edited body.")
    )
    result = coach.inspect()
    assert result["claude"].state == "stale"
    assert result["opencode"].state == "on"
    assert {s.state for s in coach.set_enabled(False).values()} == {"off"}
    assert claude.read_bytes() == b"claude user\r\n"
    assert native.read_bytes() == b"opencode user"
    replace = os.replace

    def fail_native(source: Path, destination: Path) -> None:
        if destination == native:
            raise OSError("injected native write failure")
        replace(source, destination)

    monkeypatch.setattr(coach.os, "replace", fail_native)
    assert coach.set_enabled(True)["opencode"].state == "error"
    result = coach.inspect()
    assert result["claude"].state == "on"
    assert result["opencode"].state == "off"


def test_symlink_target_and_case_aliases_preserve_identity(tmp_path: Path) -> None:
    base = put(tmp_path / ".codex/AGENTS.md", b"base")
    override = put(tmp_path / ".codex/AGENTS.override.md", b"override")
    link = tmp_path / ".pi/agent/AGENTS.md"
    link.parent.mkdir(parents=True)
    link.symlink_to(base)
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    assert link.is_symlink()
    assert coach.PROFILE_PATH.read_bytes() in base.read_bytes()
    assert coach.PROFILE_PATH.read_bytes() in override.read_bytes()
    assert {s.state for s in coach.set_enabled(False).values()} == {"off"}
    assert link.is_symlink()
    assert base.read_bytes() == b"base"
    assert override.read_bytes() == b"override"


def test_hub_created_symlink_target_is_kept_empty(tmp_path: Path) -> None:
    coach.set_enabled(True)
    base = tmp_path / ".codex/AGENTS.md"
    link = tmp_path / ".codex/AGENTS.override.md"
    link.symlink_to(base)
    assert coach.set_enabled(False)["codex"].state == "off"
    assert link.is_symlink()
    assert base.read_bytes() == b""


@pytest.mark.parametrize("kind", ["dangling", "loop", "directory", "hardlink", "fifo"])
def test_invalid_targets_are_left_untouched(tmp_path: Path, kind: str) -> None:
    path = tmp_path / ".codex/AGENTS.override.md"
    path.parent.mkdir()
    base = put(path.parent / "AGENTS.md", b"user base")
    if kind == "dangling":
        path.symlink_to(tmp_path / "missing")
    elif kind == "loop":
        path.symlink_to(path)
    elif kind == "directory":
        path.mkdir()
    elif kind == "hardlink":
        os.link(base, path)
    else:
        os.mkfifo(path)
    before = path.lstat()
    for result in (coach.inspect(), coach.set_enabled(True), coach.set_enabled(False)):
        assert result["codex"].state == "error"
    assert path.lstat() == before
    assert base.read_bytes() == b"user base"


@pytest.mark.parametrize(
    "invalid",
    [
        b"\xffprivate text",
        b"<!-- agentic-hub: coding-coach begin -->",
        b"<!-- agentic-hub: coding-coach end -->",
        b"<!-- agentic-hub: coding-coach begin created=2 -->",
    ],
)
def test_malformed_markers_and_invalid_utf8_are_not_overwritten(
    tmp_path: Path,
    invalid: bytes,
) -> None:
    path = put(tmp_path / ".claude/CLAUDE.md", invalid)
    for result in (coach.inspect(), coach.set_enabled(True), coach.set_enabled(False)):
        assert result["claude"].state == result["opencode"].state == "error"
        assert "private text" not in (result["claude"].detail or "")
    assert path.read_bytes() == invalid


@pytest.mark.parametrize("edit", ["duplicate", "reversed", "missing", "framing"])
def test_broken_owned_block_is_not_repaired(tmp_path: Path, edit: str) -> None:
    coach.set_enabled(True)
    path = tmp_path / ".claude/CLAUDE.md"
    data = path.read_bytes()
    if edit == "duplicate":
        data += data
    elif edit == "reversed":
        data = (
            data.replace(b"begin created=1", b"swap")
            .replace(b" end ", b" begin created=1 ")
            .replace(b"swap", b"end")
        )
    elif edit == "missing":
        data = data.replace(b"<!-- agentic-hub: coding-coach end -->", b"")
    else:
        data = data.lstrip(b"\n")
    path.write_bytes(data)
    assert coach.set_enabled(True)["claude"].state == "error"
    assert coach.set_enabled(False)["claude"].state == "error"
    assert path.read_bytes() == data


@pytest.mark.parametrize("failure", ["replace", "bytes", "identity", "symlink"])
def test_failed_or_conflicting_write_preserves_original(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    path = put(tmp_path / ".claude/CLAUDE.md", b"original")
    path.chmod(0o640)
    original_replace = os.replace
    original_fsync = os.fsync
    other = put(tmp_path / "other.md", b"other")

    def fail_replace(source: Path, destination: Path) -> None:
        if destination == path:
            raise OSError("injected replacement failure")
        original_replace(source, destination)

    def concurrent_edit(fd: int) -> None:
        original_fsync(fd)
        if failure == "bytes":
            path.write_bytes(b"concurrent edit")
        elif failure == "identity":
            replacement = put(tmp_path / "replacement.md", b"original")
            original_replace(replacement, path)
        elif failure == "symlink":
            path.unlink()
            path.symlink_to(other)

    if failure == "replace":
        monkeypatch.setattr(coach.os, "replace", fail_replace)
    else:
        monkeypatch.setattr(coach.os, "fsync", concurrent_edit)
    result = coach.set_enabled(True)
    assert result["claude"].state == result["opencode"].state == "error"
    assert result["pi"].state == result["codex"].state == "on"
    assert not list(tmp_path.rglob(".coach-*"))
    if failure == "symlink":
        assert path.is_symlink()
        assert other.read_bytes() == b"other"
    else:
        assert path.read_bytes() == (
            b"concurrent edit" if failure == "bytes" else b"original"
        )
    if failure == "replace":
        assert path.stat().st_mode & 0o777 == 0o640


def test_mode_bits_preserved_and_access_time_is_not_a_conflict(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = put(tmp_path / ".claude/CLAUDE.md", b"original")
    path.chmod(0o640)
    original_fsync = os.fsync

    def reader(fd: int) -> None:
        original_fsync(fd)
        metadata = path.stat()
        os.utime(path, ns=(metadata.st_atime_ns + 1_000_000_000, metadata.st_mtime_ns))

    monkeypatch.setattr(coach.os, "fsync", reader)
    assert coach.set_enabled(True)["claude"].state == "on"
    assert path.stat().st_mode & 0o777 == 0o640
    assert coach.set_enabled(False)["claude"].state == "off"
    assert path.read_bytes() == b"original"
    assert path.stat().st_mode & 0o777 == 0o640


@pytest.mark.parametrize("failure", ["resolution", "validation"])
def test_partial_failure_keeps_independent_success_and_reports_actual_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    coach.set_enabled(True)
    base = tmp_path / ".codex/AGENTS.md"
    old_block = base.read_bytes()
    put(tmp_path / ".codex/AGENTS.override.md", b"override")
    bad = tmp_path / ".pi/agent/AGENTS.override.md"
    if failure == "resolution":
        monkeypatch.setenv("OPENCODE_CONFIG_DIR", str(tmp_path / "unsupported"))
        failed_host = "opencode"
    else:
        put(bad, b"\xff")
        failed_host = "pi"
    result = coach.set_enabled(True)
    assert result[failed_host].state == "error"
    assert result["claude"].state == "on"
    assert result["codex"].state == "stale"
    assert "present in effective file" in (result["codex"].detail or "")
    assert "cleanup deferred" in (result["codex"].detail or "")
    assert base.read_bytes() == old_block
    # Disable still clears independently validated candidate sets.
    assert coach.set_enabled(False)["codex"].state == "off"
    assert not base.exists()
    put(base, old_block)
    if failure == "resolution":
        monkeypatch.delenv("OPENCODE_CONFIG_DIR")
    else:
        bad.unlink()
    assert {s.state for s in coach.set_enabled(True).values()} == {"on"}
    assert not base.exists()


def test_unreadable_shadowed_candidate_blocks_all_writes_for_its_host(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    override = put(tmp_path / ".codex/AGENTS.override.md", b"override")
    base = put(tmp_path / ".codex/AGENTS.md", b"base")
    read_bytes = Path.read_bytes

    def unreadable(path: Path) -> bytes:
        if path == base:
            raise PermissionError("injected unreadable candidate")
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", unreadable)
    for result in (coach.inspect(), coach.set_enabled(True), coach.set_enabled(False)):
        assert result["codex"].state == "error"
    assert override.read_bytes() == b"override"


def test_conflicting_delete_preserves_concurrent_edit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coach.set_enabled(True)
    path = tmp_path / ".claude/CLAUDE.md"
    original_read = coach._read
    calls = 0

    def edit_before_recheck(candidate: Path) -> coach._File:
        nonlocal calls
        if candidate == path:
            calls += 1
            if calls == 3:
                path.write_bytes(path.read_bytes() + b"concurrent addition")
        return original_read(candidate)

    # Claude's path is scanned once for Claude and once as OpenCode's fallback.
    monkeypatch.setattr(coach, "_read", edit_before_recheck)
    result = coach.set_enabled(False)
    assert result["claude"].state == "error"
    assert path.read_bytes().endswith(b"concurrent addition")


def test_shared_write_failure_retains_candidate_validation_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared = put(tmp_path / ".codex/AGENTS.md", b"base")
    pi_root = tmp_path / ".pi/agent"
    pi_root.mkdir(parents=True)
    (pi_root / "AGENTS.override.md").symlink_to(shared)
    put(pi_root / "AGENTS.md", b"\xff")
    replace = os.replace

    def fail_shared(source: Path, destination: Path) -> None:
        if destination == shared:
            raise OSError("injected shared failure")
        replace(source, destination)

    monkeypatch.setattr(coach.os, "replace", fail_shared)
    result = coach.set_enabled(True)
    assert result["pi"].state == "error"
    assert "not valid UTF-8" in (result["pi"].detail or "")
    assert "injected shared failure" in (result["pi"].detail or "")


@pytest.mark.parametrize("invalid", [None, b"", b"\xff"])
def test_unavailable_profile_prevents_enable_but_allows_disable(
    tmp_path: Path,
    invalid: bytes | None,
) -> None:
    coach.set_enabled(True)
    path = tmp_path / ".claude/CLAUDE.md"
    before = path.read_bytes()
    if invalid is None:
        coach.PROFILE_PATH.unlink()
    else:
        coach.PROFILE_PATH.write_bytes(invalid)
    assert {s.state for s in coach.inspect().values()} == {"error"}
    assert {s.state for s in coach.set_enabled(True).values()} == {"error"}
    assert path.read_bytes() == before
    assert {s.state for s in coach.set_enabled(False).values()} == {"off"}

import os
from pathlib import Path
from unittest.mock import Mock

import pytest

from agentic_hub import agents, behavior

pytestmark = pytest.mark.usefixtures("isolated_behavior_home")


@pytest.mark.parametrize(
    "statuses,expected",
    [
        (
            [
                behavior.BehaviorStatus("on", None, mode="coach"),
                behavior.BehaviorStatus("on", None, mode="coach"),
            ],
            "COACH",
        ),
        (
            [
                behavior.BehaviorStatus("off", None),
                behavior.BehaviorStatus("off", None),
            ],
            "OFF",
        ),
        (
            [
                behavior.BehaviorStatus("on", None, mode="coach"),
                behavior.BehaviorStatus("off", None),
            ],
            "MIXED",
        ),
        ([behavior.BehaviorStatus("stale", None)], "MIXED"),
        (
            [
                behavior.BehaviorStatus("error", None),
                behavior.BehaviorStatus("on", None, mode="coach"),
            ],
            "ERROR",
        ),
        (
            [
                behavior.BehaviorStatus("stale", None),
                behavior.BehaviorStatus("error", None),
            ],
            "ERROR",
        ),
        ([], "MIXED"),
    ],
)
def test_combined_coach_state(
    statuses: list[behavior.BehaviorStatus], expected: str
) -> None:
    assert (
        behavior.combined_state({str(i): s for i, s in enumerate(statuses)}) == expected
    )


def test_default_off_is_read_only(tmp_path: Path) -> None:
    before = list(tmp_path.rglob("*"))
    for result in (behavior.inspect(), behavior.set_mode(None)):
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
        status = behavior.inspect()[agent]
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
    status = behavior.inspect()["opencode"]
    assert status.state == "error"
    assert "unsupported" in (status.detail or "").lower()
    assert not (tmp_path / ".config").exists()


def test_unknown_host_is_explicit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(agents, "AGENTS", {"custom": (tmp_path, "symlink")})
    status = behavior.inspect()["custom"]
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
    assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
    installed = path.read_bytes()
    assert behavior.PROFILES["coach"].read_bytes() in installed
    path.write_bytes(installed + later)
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}
    if original is None and not later:
        assert not path.exists()
    else:
        assert path.read_bytes() == (original or b"") + later


def test_repeated_enable_is_idempotent_and_refreshes_stale_profile(
    tmp_path: Path,
) -> None:
    behavior.set_mode("coach")
    path = tmp_path / ".claude/CLAUDE.md"
    before = path.stat()
    data = path.read_bytes()
    assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
    assert path.stat() == before
    assert path.read_bytes() == data
    behavior.PROFILES["coach"].write_text("Updated coaching contract.\n")
    assert {s.state for s in behavior.inspect().values()} == {"stale"}
    assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
    assert behavior.PROFILES["coach"].read_bytes() in path.read_bytes()
    path.write_bytes(b"New preface\n" + path.read_bytes())
    behavior.set_mode(None)
    assert path.read_bytes() == b"New preface\n"


def test_disable_removes_shadowed_blocks_without_profile_source(tmp_path: Path) -> None:
    behavior.set_mode("coach")
    base = tmp_path / ".codex/AGENTS.md"
    put(tmp_path / ".codex/AGENTS.override.md")
    assert behavior.inspect()["codex"].state == "stale"
    behavior.PROFILES["coach"].unlink()
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}
    assert not base.exists()
    assert (tmp_path / ".codex/AGENTS.override.md").read_bytes() == b"user instructions"


def test_shared_claude_opencode_target_is_updated_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = put(tmp_path / ".claude/CLAUDE.md")
    replace = Mock(wraps=os.replace)
    monkeypatch.setattr(behavior.os, "replace", replace)
    assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
    assert sum(call.args[1] == path for call in replace.call_args_list) == 1
    assert not (tmp_path / ".config").exists()
    behavior.PROFILES["coach"].write_text("New profile\n")

    def fail_shared(source: Path, destination: Path) -> None:
        if destination == path:
            raise OSError("injected shared write failure")
        replace(source, destination)

    monkeypatch.setattr(behavior.os, "replace", fail_shared)
    result = behavior.set_mode("coach")
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
        assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
        assert behavior.PROFILES["coach"].read_bytes() in claude.read_bytes()
        assert behavior.PROFILES["coach"].read_bytes() in native.read_bytes()
    claude.write_bytes(
        claude.read_bytes().replace(b"Coach the current objective.", b"Edited body.")
    )
    result = behavior.inspect()
    assert result["claude"].state == "stale"
    assert result["opencode"].state == "on"
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}
    assert claude.read_bytes() == b"claude user\r\n"
    assert native.read_bytes() == b"opencode user"
    replace = os.replace

    def fail_native(source: Path, destination: Path) -> None:
        if destination == native:
            raise OSError("injected native write failure")
        replace(source, destination)

    monkeypatch.setattr(behavior.os, "replace", fail_native)
    assert behavior.set_mode("coach")["opencode"].state == "error"
    result = behavior.inspect()
    assert result["claude"].state == "on"
    assert result["opencode"].state == "off"


def test_symlink_target_and_case_aliases_preserve_identity(tmp_path: Path) -> None:
    base = put(tmp_path / ".codex/AGENTS.md", b"base")
    override = put(tmp_path / ".codex/AGENTS.override.md", b"override")
    link = tmp_path / ".pi/agent/AGENTS.md"
    link.parent.mkdir(parents=True)
    link.symlink_to(base)
    for mode in ("coach", "skeptic", "interviewer"):
        result = behavior.set_mode(mode)
        assert {s.state for s in result.values()} == {"on"}
        assert {s.mode for s in result.values()} == {mode}
        assert link.is_symlink()
        assert behavior.PROFILES[mode].read_bytes() in base.read_bytes()
        assert behavior.PROFILES[mode].read_bytes() in override.read_bytes()
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}
    assert link.is_symlink()
    assert base.read_bytes() == b"base"
    assert override.read_bytes() == b"override"


def test_hub_created_symlink_target_is_kept_empty(tmp_path: Path) -> None:
    behavior.set_mode("coach")
    base = tmp_path / ".codex/AGENTS.md"
    link = tmp_path / ".codex/AGENTS.override.md"
    link.symlink_to(base)
    assert behavior.set_mode(None)["codex"].state == "off"
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
    for result in (
        behavior.inspect(),
        behavior.set_mode("coach"),
        behavior.set_mode(None),
    ):
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
    for result in (
        behavior.inspect(),
        behavior.set_mode("coach"),
        behavior.set_mode(None),
    ):
        assert result["claude"].state == result["opencode"].state == "error"
        assert "private text" not in (result["claude"].detail or "")
    assert path.read_bytes() == invalid


@pytest.mark.parametrize("edit", ["duplicate", "reversed", "missing", "framing"])
def test_broken_owned_block_is_not_repaired(tmp_path: Path, edit: str) -> None:
    behavior.set_mode("coach")
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
    assert behavior.set_mode("coach")["claude"].state == "error"
    assert behavior.set_mode(None)["claude"].state == "error"
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
        monkeypatch.setattr(behavior.os, "replace", fail_replace)
    else:
        monkeypatch.setattr(behavior.os, "fsync", concurrent_edit)
    result = behavior.set_mode("coach")
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

    monkeypatch.setattr(behavior.os, "fsync", reader)
    assert behavior.set_mode("coach")["claude"].state == "on"
    assert path.stat().st_mode & 0o777 == 0o640
    assert behavior.set_mode(None)["claude"].state == "off"
    assert path.read_bytes() == b"original"
    assert path.stat().st_mode & 0o777 == 0o640


@pytest.mark.parametrize("failure", ["resolution", "validation"])
def test_partial_failure_keeps_independent_success_and_reports_actual_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    behavior.set_mode("coach")
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
    result = behavior.set_mode("coach")
    assert result[failed_host].state == "error"
    assert result["claude"].state == "on"
    assert result["codex"].state == "stale"
    assert "present in effective file" in (result["codex"].detail or "")
    assert "cleanup deferred" in (result["codex"].detail or "")
    assert base.read_bytes() == old_block
    # Disable still clears independently validated candidate sets.
    assert behavior.set_mode(None)["codex"].state == "off"
    assert not base.exists()
    put(base, old_block)
    if failure == "resolution":
        monkeypatch.delenv("OPENCODE_CONFIG_DIR")
    else:
        bad.unlink()
    assert {s.state for s in behavior.set_mode("coach").values()} == {"on"}
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
    for result in (
        behavior.inspect(),
        behavior.set_mode("coach"),
        behavior.set_mode(None),
    ):
        assert result["codex"].state == "error"
    assert override.read_bytes() == b"override"


def test_conflicting_delete_preserves_concurrent_edit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    behavior.set_mode("coach")
    path = tmp_path / ".claude/CLAUDE.md"
    original_read = behavior._read
    calls = 0

    def edit_before_recheck(candidate: Path) -> behavior._File:
        nonlocal calls
        if candidate == path:
            calls += 1
            if calls == 3:
                path.write_bytes(path.read_bytes() + b"concurrent addition")
        return original_read(candidate)

    # Claude's path is scanned once for Claude and once as OpenCode's fallback.
    monkeypatch.setattr(behavior, "_read", edit_before_recheck)
    result = behavior.set_mode(None)
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

    monkeypatch.setattr(behavior.os, "replace", fail_shared)
    result = behavior.set_mode("coach")
    assert result["pi"].state == "error"
    assert "not valid UTF-8" in (result["pi"].detail or "")
    assert "injected shared failure" in (result["pi"].detail or "")


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        b"",
        b"\xff",
        b"<!-- agentic-hub: coding-coach",
        b"<!-- agentic-hub: behavior-mode",
    ],
)
def test_unavailable_profile_prevents_enable_but_allows_disable(
    tmp_path: Path,
    invalid: bytes | None,
) -> None:
    behavior.set_mode("coach")
    path = tmp_path / ".claude/CLAUDE.md"
    before = path.read_bytes()
    if invalid is None:
        behavior.PROFILES["coach"].unlink()
    else:
        behavior.PROFILES["coach"].write_bytes(invalid)
    assert {s.state for s in behavior.inspect().values()} == {"error"}
    assert {s.state for s in behavior.set_mode("coach").values()} == {"error"}
    assert path.read_bytes() == before
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}


def test_mode_aggregation_uses_identity_and_freshness() -> None:
    statuses = {
        "claude": behavior.BehaviorStatus("on", None, mode="coach"),
        "pi": behavior.BehaviorStatus("on", None, mode="skeptic"),
    }
    assert behavior.combined_state(statuses) == "MIXED"
    for mode in behavior.PROFILES:
        statuses = {"host": behavior.BehaviorStatus("on", None, mode)}
        assert behavior.combined_state(statuses) == behavior.mode_label(mode).upper()
        statuses["host"].state = "stale"
        assert behavior.combined_state(statuses) == "MIXED"
        statuses["host"].state = "error"
        assert behavior.combined_state(statuses) == "ERROR"


@pytest.mark.parametrize(
    "first,second",
    [
        (first, second)
        for first in behavior.PROFILES
        for second in behavior.PROFILES
        if first != second
    ],
)
@pytest.mark.parametrize("original", [None, b"", b"user\r\n", b"user"])
def test_mode_switch_round_trip_preserves_user_bytes(
    tmp_path: Path,
    first: behavior.BehaviorMode,
    second: behavior.BehaviorMode,
    original: bytes | None,
) -> None:
    path = tmp_path / ".claude/CLAUDE.md"
    if original is not None:
        put(path, original)
    for mode in (first, second, "coach"):
        result = behavior.set_mode(mode)
        assert {s.state for s in result.values()} == {"on"}
        assert {s.mode for s in result.values()} == {mode}
        data = path.read_bytes()
        assert data.count(b"<!-- agentic-hub:") == 2
        assert behavior.PROFILES[mode].read_bytes() in data
        before = path.stat()
        behavior.set_mode(mode)
        assert path.stat() == before
    assert b"coding-coach begin" in path.read_bytes()
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}
    if original is None:
        assert not path.exists()
    else:
        assert path.read_bytes() == original


@pytest.mark.parametrize("mode", list(behavior.PROFILES))
def test_profile_refresh_and_missing_sources_are_mode_specific(
    tmp_path: Path,
    mode: behavior.BehaviorMode,
) -> None:
    behavior.set_mode(mode)
    path = tmp_path / ".claude/CLAUDE.md"
    behavior.PROFILES[mode].write_text("Updated role.\n")
    assert {s.state for s in behavior.inspect().values()} == {"stale"}
    assert {s.mode for s in behavior.inspect().values()} == {mode}
    assert {s.state for s in behavior.set_mode(mode).values()} == {"on"}
    before = path.read_bytes()
    behavior.PROFILES[mode].unlink()
    observed = behavior.inspect()
    assert {s.state for s in observed.values()} == {"error"}
    assert {s.mode for s in observed.values()} == {mode}
    failed = behavior.set_mode(mode)
    assert {s.mode for s in failed.values()} == {mode}
    assert all("observed state: error" in (s.detail or "") for s in failed.values())
    assert path.read_bytes() == before
    other = next(candidate for candidate in behavior.PROFILES if candidate != mode)
    assert {s.mode for s in behavior.set_mode(other).values()} == {other}
    assert {s.state for s in behavior.set_mode(None).values()} == {"off"}


def test_invalid_direct_mode_does_not_write(tmp_path: Path) -> None:
    before = list(tmp_path.rglob("*"))
    with pytest.raises(ValueError, match="unknown behavior mode"):
        behavior.set_mode("unknown")  # type: ignore[arg-type]
    assert list(tmp_path.rglob("*")) == before


@pytest.mark.parametrize("edit", ["unknown", "duplicate", "both", "end", "framing"])
def test_conflicting_primary_blocks_are_not_overwritten(
    tmp_path: Path, edit: str
) -> None:
    behavior.set_mode("coach")
    path = tmp_path / ".claude/CLAUDE.md"
    legacy = path.read_bytes()
    behavior.set_mode("skeptic")
    named = path.read_bytes()
    if edit == "unknown":
        data = named.replace(b"mode=skeptic", b"mode=unknown")
    elif edit == "duplicate":
        data = named + named
    elif edit == "both":
        data = legacy + named
    elif edit == "end":
        data = named.replace(b"behavior-mode end", b"coding-coach end")
    else:
        data = named.lstrip(b"\n")
    path.write_bytes(data + b"private instructions")
    before = path.read_bytes()
    for result in (
        behavior.inspect(),
        behavior.set_mode("interviewer"),
        behavior.set_mode(None),
    ):
        assert result["claude"].state == result["opencode"].state == "error"
        assert "private instructions" not in (result["claude"].detail or "")
    assert path.read_bytes() == before


def test_switch_failure_retains_observed_modes_and_allows_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    shared = put(tmp_path / ".claude/CLAUDE.md")
    behavior.set_mode("rubber-duck")
    replace = os.replace

    def fail(source: Path, destination: Path) -> None:
        if destination == shared:
            raise OSError("injected switch failure")
        replace(source, destination)

    monkeypatch.setattr(behavior.os, "replace", fail)
    result = behavior.set_mode("skeptic")
    for host in ("claude", "opencode"):
        assert result[host].state == "error"
        assert result[host].mode == "rubber-duck"
        assert "observed state: on, mode: rubber-duck" in (result[host].detail or "")
    assert result["pi"].mode == result["codex"].mode == "skeptic"
    monkeypatch.setattr(behavior.os, "replace", replace)
    assert behavior.combined_state(behavior.set_mode("skeptic")) == "SKEPTIC"


def test_set_mode_checks_observed_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        behavior,
        "inspect",
        lambda: {
            host: behavior.BehaviorStatus("on", None, "interviewer")
            for host in agents.AGENTS
        },
    )
    result = behavior.set_mode("skeptic")
    assert {s.state for s in result.values()} == {"error"}
    assert {s.mode for s in result.values()} == {"interviewer"}
    assert all("requested skeptic" in (s.detail or "") for s in result.values())

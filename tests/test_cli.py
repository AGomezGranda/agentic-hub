import logging
from pathlib import Path
from unittest.mock import Mock

import pytest

from agentic_hub import agents, behavior, catalog, cli, tui

pytestmark = pytest.mark.usefixtures("isolated_behavior_home")


def make_skill(src_dir: Path, name: str) -> None:
    d = src_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\ndescription: test {name}\n---\nBody.\n")


def setup_agents(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    src = tmp_path / "skills"
    src.mkdir()
    monkeypatch.setattr(catalog, "SKILLS_DIR", src)
    fake_agents: dict[str, tuple[Path, agents.Mode]] = {
        "a1": (tmp_path / "a1", "symlink"),
        "a2": (tmp_path / "a2", "symlink"),
    }
    monkeypatch.setattr(agents, "AGENTS", fake_agents)
    return src


def test_bare_invocation_dispatches_to_tui(monkeypatch: pytest.MonkeyPatch) -> None:
    called = []
    monkeypatch.setattr(tui, "run", lambda: called.append(True))

    cli.main([])

    assert called == [True]


def test_list_subcommand_still_dispatches_to_cmd_list(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    src = tmp_path / "skills"
    src.mkdir()
    (src / "demo").mkdir()
    (src / "demo" / "SKILL.md").write_text("---\ndescription: x\n---\nBody\n")
    monkeypatch.setattr(catalog, "SKILLS_DIR", src)
    monkeypatch.setattr(agents, "AGENTS", {"fake": (tmp_path / "fake", "symlink")})

    cli.main(["list"])

    out = capsys.readouterr().out
    assert "demo" in out
    assert "fake" in out


def test_install_dispatches_to_all_agents_and_skips_unknown_skill(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    src = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")
    caplog.set_level(logging.WARNING, logger="agentic-hub")

    with pytest.raises(SystemExit) as exc:
        cli.main(["install", "demo", "bogus"])

    assert exc.value.code == 1
    assert agents.status("a1", "demo") == "linked"
    assert agents.status("a2", "demo") == "linked"
    assert "unknown skill 'bogus'" in caplog.text


def test_install_respects_agent_filter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    src = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")

    cli.main(["install", "demo", "--agent", "a1"])

    assert agents.status("a1", "demo") == "linked"
    assert agents.status("a2", "demo") == "missing"


def test_remove_respects_agent_filter(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    src = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")
    cli.main(["install", "demo"])

    cli.main(["remove", "demo", "--agent", "a1"])

    assert agents.status("a1", "demo") == "missing"
    assert agents.status("a2", "demo") == "linked"


def test_remove_rejects_path_traversal_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    setup_agents(tmp_path, monkeypatch)
    caplog.set_level(logging.WARNING, logger="agentic-hub")

    cli.main(["remove", "../etc"])

    assert "invalid skill name" in caplog.text


def test_sync_installs_every_skill_to_every_agent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    src = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo1")
    make_skill(src, "demo2")
    toggle = Mock()
    monkeypatch.setattr(behavior, "set_mode", toggle)

    cli.main(["sync"])

    for name in ("demo1", "demo2"):
        for agent in ("a1", "a2"):
            assert agents.status(agent, name) == "linked"
    toggle.assert_not_called()


@pytest.mark.parametrize("command", ["install", "sync"])
@pytest.mark.parametrize("failure", ["conflict", "write"])
def test_install_batch_finishes_and_exits_one_after_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    command: str,
    failure: str,
) -> None:
    src = setup_agents(tmp_path, monkeypatch)
    for name in ("first", "last"):
        make_skill(src, name)
    blocked = tmp_path / "a1"
    if failure == "conflict":
        (blocked / "first").mkdir(parents=True)
    else:
        blocked.write_text("Personal content.")
    caplog.set_level(logging.INFO, logger="agentic-hub")

    with pytest.raises(SystemExit) as exc:
        cli.main([command, "first", "last"] if command == "install" else [command])

    assert exc.value.code == 1
    for name in ("first", "last"):
        assert agents.status("a2", name) == "linked"
    verb = "installed" if command == "install" else "synced"
    if failure == "conflict":
        assert agents.status("a1", "last") == "linked"
        assert (blocked / "first").is_dir()
        assert f"{verb} 3/4" in caplog.text
    else:
        assert blocked.read_text() == "Personal content."
        assert "a1/first" in caplog.text and "a1/last" in caplog.text
        assert f"{verb} 2/4" in caplog.text


def test_remove_missing_skill_remains_a_successful_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    setup_agents(tmp_path, monkeypatch)
    assert cli.main(["remove", "missing"]) is None


def test_resolve_agents_exits_on_unknown_agent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    setup_agents(tmp_path, monkeypatch)

    with pytest.raises(SystemExit):
        cli.resolve_agents("bogus")


@pytest.mark.parametrize("choice", ["0", "-1", "3", "1,0", "x", ""])
def test_picker_rejects_invalid_selection(
    monkeypatch: pytest.MonkeyPatch, choice: str
) -> None:
    monkeypatch.setattr(catalog, "discover_skills", lambda: ["first", "last"])
    monkeypatch.setattr("builtins.input", lambda prompt: choice)

    with pytest.raises(SystemExit, match="invalid selection"):
        cli.pick_interactive()


def test_picker_accepts_one_based_numbers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog, "discover_skills", lambda: ["first", "last"])
    monkeypatch.setattr("builtins.input", lambda prompt: "2, 1")

    assert cli.pick_interactive() == ["last", "first"]


def test_coach_default_status_is_read_only(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    before = list(tmp_path.rglob("*"))

    assert cli.main(["coach", "status"]) is None

    output = capsys.readouterr()
    assert output.out.splitlines()[0] == "Behavior: OFF"
    for host, status in behavior.inspect().items():
        assert f"{host:10s} off" in output.out
        assert str(status.path) in output.out
    assert output.err == ""
    assert list(tmp_path.rglob("*")) == before


def test_coach_on_status_off_persists_and_is_idempotent(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    originals = {
        tmp_path / ".claude/CLAUDE.md": b"private claude instructions\r\n",
        tmp_path / ".config/opencode/AGENTS.md": b"private opencode instructions",
    }
    for path, data in originals.items():
        path.parent.mkdir(parents=True)
        path.write_bytes(data)

    for action, expected in (
        ("on", "on"),
        ("status", "on"),
        ("on", "on"),
        ("off", "off"),
        ("status", "off"),
        ("off", "off"),
    ):
        assert cli.main(["coach", action]) is None
        output = capsys.readouterr()
        assert (
            output.out.splitlines()[0]
            == f"Behavior: {'COACH' if expected == 'on' else 'OFF'}"
        )
        for host in agents.AGENTS:
            assert f"{host:10s} {expected}" in output.out
        for data in originals.values():
            assert data.decode().strip() not in output.out + output.err
        if action != "status":
            assert "restart" in output.err.lower()
            assert "new chat" in output.err.lower()
        for path, data in originals.items():
            if expected == "on":
                assert behavior.PROFILES["coach"].read_bytes() in path.read_bytes()
            else:
                assert path.read_bytes() == data


@pytest.mark.parametrize("action", ["on", "status", "off"])
def test_coach_partial_failure_reports_hosts_and_exits_one(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    action: str,
) -> None:
    bad = tmp_path / ".codex/AGENTS.md"
    bad.parent.mkdir()
    bad.write_bytes(b"\xffprivate instructions")

    with pytest.raises(SystemExit) as exc:
        cli.main(["coach", action])

    assert exc.value.code == 1
    output = capsys.readouterr()
    assert output.out.splitlines()[0] == "Behavior: ERROR"
    assert "codex      error" in output.out
    expected = "on" if action == "on" else "off"
    for host in ("claude", "pi", "opencode"):
        assert f"{host:10s} {expected}" in output.out
        assert behavior.inspect()[host].state == expected
    assert "codex: not valid UTF-8" in caplog.text
    assert str(bad) in caplog.text
    assert "not valid UTF-8" not in output.out
    assert "private instructions" not in output.out + output.err + caplog.text


@pytest.mark.parametrize("action", ["on", "off"])
def test_coach_unmet_postcondition_exits_one(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    action: str,
) -> None:
    statuses = {
        host: behavior.BehaviorStatus(
            "on" if action == "on" else "off",
            tmp_path / host,
            "coach" if action == "on" else None,
        )
        for host in agents.AGENTS
    }
    statuses["pi"] = behavior.BehaviorStatus(
        "stale", tmp_path / "pi", detail="Leftover block."
    )
    monkeypatch.setattr(behavior, "set_mode", lambda enabled: statuses)

    with pytest.raises(SystemExit) as exc:
        cli.main(["coach", action])

    assert exc.value.code == 1
    assert capsys.readouterr().out.splitlines()[0] == "Behavior: MIXED"
    assert (
        f"pi: requested {'coach' if action == 'on' else 'off'}, observed stale"
        in caplog.text
    )


@pytest.mark.parametrize("state", ["off", "stale"])
def test_coach_mixed_status_succeeds(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    state: str,
) -> None:
    cli.main(["coach", "on"])
    path = tmp_path / ".codex/AGENTS.md"
    if state == "off":
        path.unlink()
    else:
        path.write_bytes(
            path.read_bytes().replace(b"current objective", b"old objective")
        )
    capsys.readouterr()

    assert cli.main(["coach", "status"]) is None

    output = capsys.readouterr()
    assert output.out.splitlines()[0] == "Behavior: MIXED"
    assert f"codex      {state}" in output.out
    assert "claude     on" in output.out
    if state == "stale":
        assert (
            "codex: Effective file contains an older or edited profile" in caplog.text
        )


@pytest.mark.parametrize("args", [[], ["invalid"], ["on", "--agent", "codex"]])
def test_coach_invalid_action_exits_two(args: list[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["coach", *args])
    assert exc.value.code == 2


def test_coach_off_without_profile_source(capsys: pytest.CaptureFixture[str]) -> None:
    cli.main(["coach", "on"])
    behavior.PROFILES["coach"].unlink()
    capsys.readouterr()

    assert cli.main(["coach", "off"]) is None

    assert capsys.readouterr().out.splitlines()[0] == "Behavior: OFF"
    assert {status.state for status in behavior.inspect().values()} == {"off"}


@pytest.mark.parametrize("mode", list(behavior.PROFILES))
def test_mode_set_status_switch_off(
    mode: behavior.BehaviorMode, capsys: pytest.CaptureFixture[str]
) -> None:
    for action in (["set", mode], ["status"], ["set", mode]):
        cli.main(["mode", *action])
        output = capsys.readouterr()
        assert output.out.startswith(f"Behavior: {behavior.mode_label(mode).upper()}\n")
        for status in behavior.inspect().values():
            assert str(status.path) in output.out
            assert status.mode == mode and status.state == "on"
        assert ("Restart" in output.err) == (action[0] != "status")
    other = next(candidate for candidate in behavior.PROFILES if candidate != mode)
    cli.main(["mode", "set", other])
    assert {s.mode for s in behavior.inspect().values()} == {other}
    cli.main(["mode", "off"])
    assert behavior.combined_state(behavior.inspect()) == "OFF"


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["set"],
        ["wat"],
        ["set", "unknown"],
        ["set", "coach", "--agent", "pi"],
        ["status", "--agent", "pi"],
    ],
)
def test_mode_invalid_arguments_exit_two(args: list[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.main(["mode", *args])
    assert exc.value.code == 2


def test_coach_commands_alias_primary_mode_actions(
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli.main(["mode", "set", "skeptic"])
    cli.main(["coach", "on"])
    assert behavior.combined_state(behavior.inspect()) == "COACH"
    cli.main(["mode", "set", "interviewer"])
    capsys.readouterr()
    cli.main(["coach", "status"])
    assert capsys.readouterr().out.startswith("Behavior: INTERVIEWER\n")
    cli.main(["coach", "off"])
    assert behavior.combined_state(behavior.inspect()) == "OFF"


def test_mode_status_is_read_only_and_reports_mixed_modes(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cli.main(["mode", "set", "skeptic"])
    claude = tmp_path / ".claude/CLAUDE.md"
    skeptic = claude.read_bytes()
    cli.main(["mode", "set", "interviewer"])
    claude.write_bytes(skeptic)
    capsys.readouterr()
    before = {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    cli.main(["mode", "status"])
    output = capsys.readouterr()
    assert output.out.startswith("Behavior: MIXED\n")
    assert "skeptic" in output.out and "interviewer" in output.out
    assert before == {p: p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    claude.write_bytes(skeptic.replace(b"skeptic role", b"older role"))
    cli.main(["mode", "status"])
    assert "stale" in capsys.readouterr().out
    claude.write_bytes(b"<!-- agentic-hub: behavior-mode begin mode=unknown -->")
    with pytest.raises(SystemExit) as exc:
        cli.main(["mode", "status"])
    assert exc.value.code == 1


@pytest.mark.parametrize("action", [["set", "skeptic"], ["off"]])
def test_mode_mutation_requires_requested_mode_and_freshness(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
    action: list[str],
) -> None:
    monkeypatch.setattr(
        behavior,
        "set_mode",
        lambda mode: {
            "claude": behavior.BehaviorStatus("on", None, "interviewer"),
            "pi": behavior.BehaviorStatus("stale", None, "skeptic", "Leftover block."),
        },
    )
    with pytest.raises(SystemExit) as exc:
        cli.main(["mode", *action])
    assert exc.value.code == 1
    output = capsys.readouterr()
    assert "interviewer" in output.out and "stale" in output.out
    assert "requested" in caplog.text and "Leftover block." in caplog.text
    assert "Leftover block." not in output.out
    assert "Restart" in output.err


def test_empty_status_is_mixed_but_empty_mutation_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(behavior, "inspect", lambda: {})
    monkeypatch.setattr(behavior, "set_mode", lambda mode: {})
    cli.main(["mode", "status"])
    assert capsys.readouterr().out == "Behavior: MIXED\n"
    with pytest.raises(SystemExit) as exc:
        cli.main(["mode", "off"])
    assert exc.value.code == 1

import logging
from pathlib import Path

import pytest

from agentic_hub import agents, catalog, cli, tui


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

    cli.main(["install", "demo", "bogus"])

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

    cli.main(["sync"])

    for name in ("demo1", "demo2"):
        for agent in ("a1", "a2"):
            assert agents.status(agent, name) == "linked"


def test_resolve_agents_exits_on_unknown_agent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    setup_agents(tmp_path, monkeypatch)

    with pytest.raises(SystemExit):
        cli.resolve_agents("bogus")

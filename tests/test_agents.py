from pathlib import Path

import pytest

from agentic_hub import agents, catalog


def make_skill(src_dir: Path, name: str) -> Path:
    d = src_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test {name}\n---\nBody for {name}.\n"
    )
    return d


def setup_agents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, dict[str, tuple[Path, agents.Mode]]]:
    src = tmp_path / "skills"
    src.mkdir()
    monkeypatch.setattr(catalog, "SKILLS_DIR", src)
    fake_agents: dict[str, tuple[Path, agents.Mode]] = {
        "claude": (tmp_path / "claude", "symlink"),
        "pi": (tmp_path / "pi", "symlink"),
        "opencode": (tmp_path / "opencode", "symlink"),
        "codex": (tmp_path / "codex", "codex"),
    }
    monkeypatch.setattr(agents, "AGENTS", fake_agents)
    return src, fake_agents


def test_install_symlinks_native_agents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_skill(src, "demo")

    for agent in ("claude", "pi", "opencode"):
        assert agents.install_one(agent, "demo")
        link = fake_agents[agent][0] / "demo"
        assert link.is_symlink()
        assert link.resolve() == skill_dir.resolve()
        assert agents.status(agent, "demo") == "linked"


def test_install_flattens_codex_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert text.startswith(agents.CODEX_MARKER)
    assert "test demo" in text
    assert "Body for demo." in text
    assert "description:" not in text  # frontmatter stripped
    assert agents.status("codex", "demo") == "linked"


def test_remove_only_deletes_our_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")
    agents.install_one("claude", "demo")
    agents.install_one("codex", "demo")

    # unrelated symlink/file sharing a target dir must survive
    other = tmp_path / "unrelated_dir"
    other.mkdir()
    stray_link = fake_agents["claude"][0] / "stray"
    stray_link.symlink_to(other, target_is_directory=True)
    stray_prompt = fake_agents["codex"][0] / "stray.md"
    stray_prompt.write_text("hand-written, not ours\n")

    assert agents.remove_one("claude", "demo")
    assert agents.remove_one("codex", "demo")
    assert not (fake_agents["claude"][0] / "demo").exists()
    assert not (fake_agents["codex"][0] / "demo.md").exists()

    assert stray_link.is_symlink()  # untouched
    assert stray_prompt.read_text() == "hand-written, not ours\n"

    # removing things we don't own is a no-op, not an error
    assert not agents.remove_one("claude", "stray")
    assert not agents.remove_one("codex", "stray")
    assert stray_link.is_symlink()
    assert stray_prompt.exists()

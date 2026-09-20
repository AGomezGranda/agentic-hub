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


def make_fanout_skill(src_dir: Path, name: str) -> Path:
    """A skill with a '### Fanning out' section carrying the splice marker,
    the shape `_effective_mode` treats as spliced/codex rather than plain
    symlink."""
    d = src_dir / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test {name}\n---\n"
        f"Body for {name}.\n\n"
        f"### Fanning out\n\nBundled agent: `demo-agent`.\n\n{agents.FANOUT_MARKER}\n"
    )
    return d


def make_fanout_branches(src_dir: Path, agents_: tuple[str, ...]) -> None:
    """Write a minimal, distinguishable fan-out branch file per host under
    `_shared/fanning-out/`, so a test can assert one host's spliced output
    doesn't leak another host's branch."""
    branch_dir = src_dir / "_shared" / "fanning-out"
    branch_dir.mkdir(parents=True, exist_ok=True)
    for agent in agents_:
        (branch_dir / f"{agent}.md").write_text(f"[{agent} branch content]\n")


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
    assert text.startswith(agents.CODEX_MARKER_PREFIX)
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


def test_codex_flatten_inlines_sibling_markdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_skill(src, "demo")
    (skill_dir / "REFERENCE.md").write_text("Reference content.\n")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "## Bundled reference: REFERENCE.md" in text
    assert "Reference content." in text


def test_codex_flatten_inlines_nested_references_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_skill(src, "demo")
    (skill_dir / "references").mkdir()
    (skill_dir / "references" / "a.md").write_text("A content.\n")
    (skill_dir / "references" / "b.md").write_text("B content.\n")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "## Bundled reference: references/a.md" in text
    assert "## Bundled reference: references/b.md" in text
    assert text.index("references/a.md") < text.index("references/b.md")


def test_codex_flatten_skips_scripts_and_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_skill(src, "demo")
    (skill_dir / "scripts").mkdir()
    (skill_dir / "scripts" / "helper.md").write_text("Should not appear.\n")
    (skill_dir / "assets").mkdir()
    (skill_dir / "assets" / "note.md").write_text("Should not appear either.\n")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "Should not appear" not in text


def test_codex_flatten_unchanged_without_siblings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "## Bundled reference:" not in text


def test_codex_flatten_skips_non_utf8_sibling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_skill(src, "demo")
    (skill_dir / "BAD.md").write_bytes(b"\xff\xfe not utf-8")

    assert agents.install_one("codex", "demo")
    text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "## Bundled reference: BAD.md" not in text


def test_codex_install_raises_on_folded_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    d = src / "broken"
    d.mkdir()
    (d / "SKILL.md").write_text(
        "---\ndescription: >\n  line one\n  line two\n---\nBody.\n"
    )

    with pytest.raises(ValueError, match="folded"):
        agents.install_one("codex", "broken")


def test_codex_status_detects_stale_after_source_edit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "demo")

    assert agents.install_one("codex", "demo")
    assert agents.status("codex", "demo") == "linked"

    (src / "demo" / "SKILL.md").write_text(
        "---\nname: demo\ndescription: test demo\n---\nEdited body.\n"
    )
    assert agents.status("codex", "demo") == "stale"

    assert agents.install_one("codex", "demo")
    assert agents.status("codex", "demo") == "linked"
    assert "Edited body." in (fake_agents["codex"][0] / "demo.md").read_text()


def test_splice_injects_only_host_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_fanout_skill(src, "demo")
    make_fanout_branches(src, ("pi", "claude", "opencode", "codex"))

    assert agents.install_one("pi", "demo")
    assert agents.install_one("codex", "demo")

    pi_text = (fake_agents["pi"][0] / "demo" / "SKILL.md").read_text()
    assert "[pi branch content]" in pi_text
    assert "[codex branch content]" not in pi_text

    codex_text = (fake_agents["codex"][0] / "demo.md").read_text()
    assert "[codex branch content]" in codex_text
    assert "[pi branch content]" not in codex_text


def test_spliced_skill_detects_stale_after_source_edit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_fanout_skill(src, "demo")
    make_fanout_branches(src, ("pi", "claude", "opencode", "codex"))

    assert agents.install_one("pi", "demo")
    assert agents.status("pi", "demo") == "linked"

    skill_md = src / "demo" / "SKILL.md"
    skill_md.write_text(skill_md.read_text() + "\nEdited.\n")
    assert agents.status("pi", "demo") == "stale"

    assert agents.install_one("pi", "demo")
    assert agents.status("pi", "demo") == "linked"
    assert "Edited." in (fake_agents["pi"][0] / "demo" / "SKILL.md").read_text()


def test_spliced_skill_detects_stale_after_reference_edit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Staleness must also catch a sibling reference file drifting out from
    under its symlink, not just the SKILL.md hash."""
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    skill_dir = make_fanout_skill(src, "demo")
    (skill_dir / "references").mkdir()
    ref = skill_dir / "references" / "a.md"
    ref.write_text("A content.\n")
    make_fanout_branches(src, ("pi", "claude", "opencode", "codex"))

    assert agents.install_one("pi", "demo")
    assert agents.status("pi", "demo") == "linked"

    sibling = fake_agents["pi"][0] / "demo" / "references"
    assert sibling.is_symlink()
    sibling.unlink()
    assert agents.status("pi", "demo") == "stale"


def test_mixed_host_directory_status_and_remove(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A plain-symlinked skill and a spliced skill side by side on the same
    host: status() reports each correctly through its own mechanism, and
    removing the spliced one doesn't touch the plain-symlinked one."""
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_skill(src, "implement-plan")
    make_fanout_skill(src, "code-quality-audit")
    make_fanout_branches(src, ("pi", "claude", "opencode", "codex"))

    assert agents.install_one("pi", "implement-plan")
    assert agents.install_one("pi", "code-quality-audit")

    assert agents.status("pi", "implement-plan") == "linked"
    assert agents.status("pi", "code-quality-audit") == "linked"

    plain_link = fake_agents["pi"][0] / "implement-plan"
    spliced_dir = fake_agents["pi"][0] / "code-quality-audit"
    assert plain_link.is_symlink()
    assert spliced_dir.is_dir() and not spliced_dir.is_symlink()

    assert agents.remove_one("pi", "code-quality-audit")
    assert not spliced_dir.exists()
    assert plain_link.is_symlink()  # untouched
    assert agents.status("pi", "implement-plan") == "linked"


def test_remove_leaves_directory_if_something_unowned_remains(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src, fake_agents = setup_agents(tmp_path, monkeypatch)
    make_fanout_skill(src, "demo")
    make_fanout_branches(src, ("pi", "claude", "opencode", "codex"))

    assert agents.install_one("pi", "demo")
    tp = fake_agents["pi"][0] / "demo"
    (tp / "stray.txt").write_text("not ours\n")

    assert agents.remove_one("pi", "demo")
    assert tp.is_dir()  # left behind, not ours to rmdir
    assert not (tp / "SKILL.md").exists()
    assert (tp / "stray.txt").exists()


def test_codex_prompt_keeps_all_test_levels_after_reference_split() -> None:
    """Phase 4b split AUDIT_STRATEGY.md into references/*.md, one file per
    level. Codex has no fan-out, so its flattened prompt must still see
    every level -- `_bundled_references` inlines the whole directory
    regardless of how many files it's split into, so no level should have
    silently dropped out of the generated prompt.
    """
    body = agents._codex_body("testing-strategy")
    for heading in (
        "# Unit testing",
        "# Integration testing",
        "# Component testing",
        "# Contract testing",
        "# End-to-end testing",
        "# Async and event-driven services",
    ):
        assert heading in body, f"missing level section: {heading!r}"

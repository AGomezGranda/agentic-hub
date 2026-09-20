from pathlib import Path

import pytest

from agentic_hub import catalog


def test_discover_skills_finds_dir_with_skill_md(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(catalog, "SKILLS_DIR", tmp_path)
    (tmp_path / "has-skill").mkdir()
    (tmp_path / "has-skill" / "SKILL.md").write_text("body")
    (tmp_path / "no-skill").mkdir()

    assert catalog.discover_skills() == ["has-skill"]


def test_discover_skills_missing_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(catalog, "SKILLS_DIR", tmp_path / "nope")

    assert catalog.discover_skills() == []


def test_parse_frontmatter_splits_fields_and_body() -> None:
    text = "---\nname: demo\ndescription: a demo\n---\nBody text.\n"

    fm, body = catalog.parse_frontmatter(text)

    assert fm == {"name": "demo", "description": "a demo"}
    assert body == "Body text.\n"


def test_parse_frontmatter_no_leading_dashes_returns_unchanged() -> None:
    text = "Just a body, no frontmatter.\n"

    fm, body = catalog.parse_frontmatter(text)

    assert fm == {}
    assert body == text

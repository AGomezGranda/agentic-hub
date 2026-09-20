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


def test_parse_frontmatter_warns_on_folded_scalar(
    caplog: pytest.LogCaptureFixture,
) -> None:
    text = "---\ndescription: >\n  line one\n  line two\n---\nBody.\n"

    with caplog.at_level("WARNING"):
        fm, _ = catalog.parse_frontmatter(text)

    assert fm["description"] == ">"
    assert any("folded" in r.message for r in caplog.records)


def test_parse_frontmatter_strips_matching_quotes() -> None:
    text = "---\nname: demo\ndescription: 'a quoted demo'\n---\nBody.\n"

    fm, _ = catalog.parse_frontmatter(text)

    assert fm["description"] == "a quoted demo"


def test_real_skills_corpus_has_valid_frontmatter() -> None:
    """No monkeypatch, no synthetic fixture: runs against the real skills/ dir."""
    for name in catalog.discover_skills():
        text = (catalog.SKILLS_DIR / name / "SKILL.md").read_text()
        fm, _ = catalog.parse_frontmatter(text)
        description = fm.get("description", "")
        assert description.strip() not in (">", "|"), (
            f"{name}: description is a broken folded/literal YAML block"
        )
        assert description, f"{name}: missing description"
        assert "\n" not in description, (
            f"{name}: description spans multiple lines, not a single-line scalar"
        )

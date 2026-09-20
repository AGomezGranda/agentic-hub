from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / "skills"


def discover_skills() -> list[str]:
    """List skill names (dirs containing a SKILL.md) under SKILLS_DIR."""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(
        p.name for p in SKILLS_DIR.iterdir() if p.is_dir() and (p / "SKILL.md").exists()
    )


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split a SKILL.md into its --- frontmatter dict and the remaining body."""
    # ponytail: flat key: value pairs only, no nested/list YAML. Upgrade to a
    # real YAML parser if a skill's frontmatter ever needs more than that.
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    _, fm_block, body = parts
    fm = {}
    for line in fm_block.strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()
    return fm, body.lstrip("\n")

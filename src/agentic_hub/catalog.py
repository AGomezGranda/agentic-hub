import logging
from pathlib import Path

log = logging.getLogger("agentic-hub")

SKILLS_DIR = Path(__file__).resolve().parent.parent.parent / "skills"


def discover_skills() -> list[str]:
    """List skill names (dirs containing a SKILL.md) under SKILLS_DIR."""
    if not SKILLS_DIR.is_dir():
        return []
    return sorted(
        p.name for p in SKILLS_DIR.iterdir() if p.is_dir() and (p / "SKILL.md").exists()
    )


def _unquote(value: str) -> str:
    """Strip one matching layer of '...'/"..." quoting from a scalar value."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


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
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v[:1] in (">", "|"):
            log.warning(
                "frontmatter key %r uses a folded/literal YAML block (%r); "
                "only flat key: value scalars are supported, continuation "
                "lines are silently dropped",
                k,
                v,
            )
        fm[k] = _unquote(v)
    return fm, body.lstrip("\n")

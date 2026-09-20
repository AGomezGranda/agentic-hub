import hashlib
import logging
from pathlib import Path
from typing import Literal

from . import catalog

log = logging.getLogger("agentic-hub")

HOME = Path.home()

Mode = Literal["symlink", "spliced", "codex"]
Status = Literal["linked", "stale", "missing", "conflict"]

# agent -> (target dir, mode)
AGENTS: dict[str, tuple[Path, Mode]] = {
    "claude": (HOME / ".claude/skills", "symlink"),
    "pi": (HOME / ".pi/agent/skills", "symlink"),
    "opencode": (HOME / ".config/opencode/skill", "symlink"),
    "codex": (HOME / ".codex/prompts", "codex"),
}

CODEX_MARKER_PREFIX = "<!-- agentic-hub: generated sha256:"
CODEX_MARKER_SUFFIX = " -->"

# Marks the spot in a SKILL.md's "### Fanning out" section where the
# per-host fan-out prose is spliced in at install time (skills/_shared/
# fanning-out/<agent>.md). A skill without this marker is never spliced;
# it stays plain `symlink` (or flattened `codex`) on every host.
FANOUT_MARKER = "<!-- agentic-hub: fanout -->"

# Reference files bundled into a Codex prompt; anything under these dirs
# (scripts, illustrative assets) is never inlined.
_EXCLUDED_REF_DIRS = {"scripts", "assets"}


def target_path(agent: str, name: str) -> Path:
    """Where a skill would live for this agent (symlink path or generated file)."""
    dir_, mode = AGENTS[agent]
    return dir_ / (f"{name}.md" if mode == "codex" else name)


def is_our_codex_file(path: Path) -> bool:
    """Check the marker on the first line to see if we generated this file.

    Ownership only — the marker also carries a content hash, checked
    separately by `status()`, so a stale-but-ours file still counts here.
    """
    try:
        first_line = path.read_text().splitlines()[0]
    except (OSError, IndexError):
        return False
    return first_line.strip().startswith(CODEX_MARKER_PREFIX)


def _fanout_branch(agent: str) -> str:
    """This host's fan-out prose (skills/_shared/fanning-out/<agent>.md).

    A missing or unreadable branch file is a hard install-time error, not a
    silent fallback -- a host installing with no fan-out instructions at all
    is exactly the failure this mechanism exists to prevent.
    """
    path = catalog.SKILLS_DIR / "_shared" / "fanning-out" / f"{agent}.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(
            f"agent {agent!r} has no fan-out branch at {path}"
        ) from e


def _splice(text: str, agent: str) -> str:
    """Replace a FANOUT_MARKER occurrence in `text` with this host's
    fan-out branch. No-op if the marker isn't present."""
    if FANOUT_MARKER not in text:
        return text
    return text.replace(FANOUT_MARKER, _fanout_branch(agent).rstrip("\n"))


def _marker_line(text: str) -> str | None:
    """First line in `text` starting with the generated-content marker,
    wherever it sits (not necessarily line 1 -- a spliced SKILL.md keeps
    its YAML frontmatter first, so the marker lives further down)."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(CODEX_MARKER_PREFIX):
            return stripped
    return None


def is_our_spliced_skill(path: Path) -> bool:
    """Ownership check for a spliced SKILL.md: same marker/hash convention
    as `is_our_codex_file`, just not pinned to line 1."""
    try:
        text = path.read_text()
    except OSError:
        return False
    return _marker_line(text) is not None


def _spliced_output(name: str, agent: str) -> str:
    """Full generated SKILL.md text for a spliced host: source SKILL.md
    with the FANOUT_MARKER line replaced by this host's branch prose, and
    a generated/hash marker (`_codex_marker`, same convention as Codex's
    flat file) stamped immediately above the branch -- inside the
    document rather than at line 1, since a real SKILL.md's frontmatter
    must still open the file.
    """
    sp = catalog.SKILLS_DIR / name
    text = (sp / "SKILL.md").read_text()
    if FANOUT_MARKER not in text:
        raise ValueError(f"skill {name!r} has no {FANOUT_MARKER!r} marker to splice")
    branch = _fanout_branch(agent).rstrip("\n")
    unmarked = text.replace(FANOUT_MARKER, branch)
    marker = _codex_marker(unmarked)
    return text.replace(FANOUT_MARKER, f"{marker}\n{branch}")


def _effective_mode(agent: str, name: str) -> Mode:
    """Mode is per (agent, skill), not just per host: a skill without a
    FANOUT_MARKER stays plain `symlink` (or `codex`) everywhere; a skill
    that has one is `spliced` on every symlink-mode host and stays `codex`
    on Codex, which has its own flattening instead.
    """
    _, base_mode = AGENTS[agent]
    if base_mode == "codex":
        return "codex"
    try:
        has_marker = FANOUT_MARKER in (catalog.SKILLS_DIR / name / "SKILL.md").read_text()
    except OSError:
        has_marker = False
    return "spliced" if has_marker else "symlink"


def _bundled_references(skill_dir: Path) -> list[Path]:
    """Markdown files beyond SKILL.md that a Codex prompt should inline.

    Recursive (not just siblings of SKILL.md): reference files may live under
    a references/ subdirectory. Sorted by relative POSIX path so the
    generated file is deterministic.
    """
    refs = []
    for p in skill_dir.rglob("*.md"):
        rel = p.relative_to(skill_dir)
        if rel.name == "SKILL.md" or _EXCLUDED_REF_DIRS & set(rel.parts[:-1]):
            continue
        refs.append(p)
    return sorted(refs, key=lambda p: p.relative_to(skill_dir).as_posix())


def _codex_body(name: str) -> str:
    """Render a skill's Codex prompt body: description + SKILL.md body +
    bundled references, unmarked (no marker/hash line).

    Raises ValueError if the description is an unsupported folded/literal
    YAML block — loudly, unlike `catalog.parse_frontmatter`, which only warns.
    """
    skill_dir = catalog.SKILLS_DIR / name
    fm, body = catalog.parse_frontmatter((skill_dir / "SKILL.md").read_text())
    description = fm.get("description", "")
    if description.strip() in (">", "|"):
        raise ValueError(
            f"skill {name!r}: description is an unsupported folded/literal "
            "YAML block; rewrite it as a single-line scalar"
        )
    body = _splice(body, "codex")
    text = f"{description}\n\n{body}"
    for ref in _bundled_references(skill_dir):
        rel = ref.relative_to(skill_dir).as_posix()
        try:
            ref_text = ref.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            log.warning("skip bundled reference %s: not readable as utf-8", ref)
            continue
        text += f"\n## Bundled reference: {rel}\n\n{ref_text}"
    return text


def _codex_marker(body: str) -> str:
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    return f"{CODEX_MARKER_PREFIX}{digest}{CODEX_MARKER_SUFFIX}"


def _is_ours_symlink(tp: Path, sp: Path) -> bool:
    try:
        return tp.resolve() == sp.resolve()
    except OSError:
        return False


def _siblings_stale(sp: Path, tp: Path) -> bool:
    """True if any non-SKILL.md entry in the source isn't live-symlinked
    from the spliced target -- silently serving a stale/absent reference
    is exactly the failure this check exists to catch."""
    for entry in sp.iterdir():
        if entry.name == "SKILL.md":
            continue
        sib = tp / entry.name
        if not sib.is_symlink() or not _is_ours_symlink(sib, entry):
            return True
    return False


def _spliced_status(agent: str, name: str, tp: Path) -> Status:
    if tp.is_symlink():
        # A pre-splice install symlinked the whole skill directory. Ours is
        # upgradable (install_one replaces it), a foreign one is a real
        # conflict.
        return "stale" if _is_ours_symlink(tp, catalog.SKILLS_DIR / name) else "conflict"
    if not tp.is_dir():
        return "conflict" if tp.exists() else "missing"
    skill_md = tp / "SKILL.md"
    if not skill_md.is_file() or not is_our_spliced_skill(skill_md):
        return "conflict"
    try:
        want = _spliced_output(name, agent)
    except (OSError, ValueError):
        return "stale"
    if _marker_line(skill_md.read_text()) != _marker_line(want):
        return "stale"
    sp = catalog.SKILLS_DIR / name
    return "stale" if _siblings_stale(sp, tp) else "linked"


def _symlink_status(tp: Path, sp: Path) -> Status:
    if tp.is_symlink():
        return "linked" if _is_ours_symlink(tp, sp) else "stale"
    return "conflict" if tp.exists() else "missing"


def _codex_status(name: str, tp: Path) -> Status:
    if not tp.exists():
        return "missing"
    if not is_our_codex_file(tp):
        return "conflict"
    try:
        body = _codex_body(name)
        want_marker = _codex_marker(body)
        have_marker = tp.read_text().splitlines()[0].strip()
    except (OSError, IndexError, ValueError):
        return "stale"
    return "linked" if have_marker == want_marker else "stale"


def status(agent: str, name: str) -> Status:
    """Report whether a skill is linked, stale, missing, or conflicting for an agent."""
    tp = target_path(agent, name)
    effective = _effective_mode(agent, name)
    if effective == "symlink":
        return _symlink_status(tp, catalog.SKILLS_DIR / name)
    if effective == "spliced":
        return _spliced_status(agent, name, tp)
    return _codex_status(name, tp)


def _install_spliced(agent: str, name: str, sp: Path, tp: Path) -> bool:
    if tp.is_symlink():
        if not _is_ours_symlink(tp, sp):
            log.warning("skip %s/%s: %s is a symlink, not ours", agent, name, tp)
            return False
        tp.unlink()  # upgrade a pre-splice whole-directory symlink
    elif tp.exists() and not tp.is_dir():
        log.warning("skip %s/%s: %s is a real file, not ours", agent, name, tp)
        return False
    if status(agent, name) == "linked":
        log.debug("ok %s/%s: already linked", agent, name)
        return True
    skill_md = tp / "SKILL.md"
    if skill_md.exists() and not is_our_spliced_skill(skill_md):
        log.warning(
            "skip %s/%s: %s exists and wasn't generated by agentic-hub", agent, name, skill_md
        )
        return False
    output = _spliced_output(name, agent)
    tp.mkdir(parents=True, exist_ok=True)
    skill_md.write_text(output)
    for entry in sp.iterdir():
        if entry.name == "SKILL.md":
            continue
        sib = tp / entry.name
        if sib.is_symlink():
            if _is_ours_symlink(sib, entry):
                continue
            sib.unlink()
        elif sib.exists():
            log.warning(
                "skip sibling %s/%s/%s: %s is a real file/dir, not ours",
                agent, name, entry.name, sib,
            )
            continue
        sib.symlink_to(entry, target_is_directory=entry.is_dir())
    log.info("spliced %s/%s -> %s", agent, name, tp)
    return True


def install_one(agent: str, name: str) -> bool:
    """Install (symlink, splice, or generate) one skill for one agent; False if skipped."""
    dir_, mode = AGENTS[agent]
    sp = catalog.SKILLS_DIR / name
    tp = target_path(agent, name)
    dir_.mkdir(parents=True, exist_ok=True)
    effective = _effective_mode(agent, name)
    if effective == "symlink":
        if tp.exists() and not tp.is_symlink():
            log.warning("skip %s/%s: %s is a real file/dir, not ours", agent, name, tp)
            return False
        if status(agent, name) == "linked":
            log.debug("ok %s/%s: already linked", agent, name)
            return True
        relinked = tp.is_symlink()
        if tp.is_symlink() or tp.exists():
            tp.unlink()
        tp.symlink_to(sp, target_is_directory=True)
        log.info(
            "%s %s/%s -> %s", "relinked" if relinked else "linked", agent, name, tp
        )
        return True
    if effective == "spliced":
        return _install_spliced(agent, name, sp, tp)
    if tp.exists() and not is_our_codex_file(tp):
        log.warning(
            "skip %s/%s: %s exists and wasn't generated by agentic-hub", agent, name, tp
        )
        return False
    body = _codex_body(name)
    tp.write_text(f"{_codex_marker(body)}\n{body}")
    log.info("generated %s/%s -> %s", agent, name, tp)
    return True


def _remove_spliced(agent: str, name: str, tp: Path) -> bool:
    if tp.is_symlink():
        # A pre-splice whole-directory symlink for a skill that's since
        # grown a fan-out marker -- still ours to remove.
        if _is_ours_symlink(tp, catalog.SKILLS_DIR / name):
            tp.unlink()
            log.info("unlinked %s/%s (%s)", agent, name, tp)
            return True
        return False
    if not tp.is_dir():
        return False
    removed = False
    skill_md = tp / "SKILL.md"
    if skill_md.is_file() and is_our_spliced_skill(skill_md):
        skill_md.unlink()
        removed = True
    sp = catalog.SKILLS_DIR / name
    for entry in list(tp.iterdir()):
        if entry.is_symlink() and _is_ours_symlink(entry, sp / entry.name):
            entry.unlink()
            removed = True
    if not removed:
        return False
    try:
        tp.rmdir()
    except OSError:
        pass  # something we don't own is still inside; leave the directory
    log.info("removed %s/%s (%s)", agent, name, tp)
    return True


def remove_one(agent: str, name: str) -> bool:
    """Remove a skill we installed for an agent; False if there's nothing to remove."""
    dir_, mode = AGENTS[agent]
    tp = target_path(agent, name)
    effective = _effective_mode(agent, name)
    if effective == "symlink":
        if tp.is_symlink() and _is_ours_symlink(tp, catalog.SKILLS_DIR / name):
            tp.unlink()
            log.info("unlinked %s/%s (%s)", agent, name, tp)
            return True
    elif effective == "spliced":
        if _remove_spliced(agent, name, tp):
            return True
    elif tp.is_file() and is_our_codex_file(tp):
        tp.unlink()
        log.info("deleted %s/%s (%s)", agent, name, tp)
        return True
    log.debug(
        "nothing to remove for %s/%s: %s",
        agent,
        name,
        "not ours" if tp.exists() else "not installed",
    )
    return False

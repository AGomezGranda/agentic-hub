"""Content-contract tests for the shared skill prose (fan-out block, finding
schema). These assert what must be present and identical, not raw byte
equality against a fixed literal, so a legitimate per-skill wording tweak
elsewhere in the file doesn't fail the test.
"""

import re

import pytest

from agentic_hub import agents, catalog

FANOUT_HEADING = "### Fanning out"
FANOUT_MARKER = agents.FANOUT_MARKER
HOST_BRANCH_DIR = catalog.SKILLS_DIR / "_shared" / "fanning-out"


def _skill_text(name: str) -> str:
    return (catalog.SKILLS_DIR / name / "SKILL.md").read_text()


def _skills_with_fanout() -> list[str]:
    return [
        name
        for name in catalog.discover_skills()
        if FANOUT_HEADING in _skill_text(name)
    ]


def _fanout_section(name: str) -> str:
    """Slice a skill's in-repo fan-out block: from the heading through the
    splice marker where the per-host branch gets installed in at install
    time. Each host's actual instructions now live in their own file under
    `_shared/fanning-out/`, not duplicated per skill.
    """
    text = _skill_text(name)
    heading_at = text.index(FANOUT_HEADING)
    end = text.index(FANOUT_MARKER, heading_at) + len(FANOUT_MARKER)
    return text[heading_at:end]


def _host_branch_text(agent: str) -> str:
    return (HOST_BRANCH_DIR / f"{agent}.md").read_text(encoding="utf-8")


def test_fanout_block_present_and_complete() -> None:
    names = _skills_with_fanout()
    assert len(names) >= 5, f"expected at least the five fan-out skills, found {names}"
    for name in names:
        section = _fanout_section(name)
        assert FANOUT_MARKER in section, (
            f"{name}: fan-out section missing the splice marker"
        )
    for agent in agents.AGENTS:
        text = _host_branch_text(agent)
        assert "lead, not evidence" in text, (
            f"fanning-out/{agent}.md missing the capability-conditional "
            "verification rule"
        )


def test_every_skill_has_fanout_marker() -> None:
    """Structural replacement for the old byte-identical-prose check: every
    skill with a '### Fanning out' heading also carries the splice marker,
    now that each host's prose lives in its own file instead of being
    duplicated verbatim into every skill.
    """
    for name in _skills_with_fanout():
        assert FANOUT_MARKER in _skill_text(name), (
            f"{name}: has a '### Fanning out' heading but no splice marker"
        )


def test_every_host_has_a_fanout_branch() -> None:
    """Every key in agents.AGENTS has a readable fan-out branch file, so
    adding a host cannot silently ship without one."""
    for agent in agents.AGENTS:
        path = HOST_BRANCH_DIR / f"{agent}.md"
        assert path.is_file(), f"{agent}: missing fan-out branch at {path}"
        assert path.read_text(encoding="utf-8").strip(), (
            f"{agent}: empty fan-out branch"
        )


@pytest.mark.parametrize("agent", ["opencode"])
def test_serial_branch_states_ordering_and_budget(agent: str) -> None:
    text = _host_branch_text(agent)
    assert re.search(r"[Oo]rdering", text), f"{agent}.md: missing an ordering rule"
    assert re.search(r"[Cc]ontext budget", text), (
        f"{agent}.md: missing a context budget"
    )
    assert re.search(r"[Vv]erification collapses", text), (
        f"{agent}.md: missing the verification-collapse rule"
    )


def test_codex_branch_dispatches_independent_subagents() -> None:
    text = _host_branch_text("codex")
    assert "spawn one" in text
    assert "subagent per bounded question" in text
    assert "collect all results" in text


def test_pi_branch_blocks_explicitly() -> None:
    """Workflow calls default to background, so an omitted `async` returns a
    receipt instead of the findings the parent must synthesize from."""
    text = _host_branch_text("pi")
    assert "async: false" in text
    assert "default blocking" not in text


def test_claude_branch_forbids_nesting() -> None:
    text = _host_branch_text("claude")
    assert re.search(r"cannot spawn\s+further children", text)
    assert "one level of fan-out" in text


FANOUT_ROSTER = {
    "code-quality-audit": "audit-reviewer",
    "architecture-audit": "audit-reviewer",
    "testing-strategy": "audit-reviewer",
    "review-plan": "audit-reviewer",
    "review-implementation": "audit-reviewer",
    "research-codebase": "repo-scout",
    "create-plan": "repo-scout",
    "remove-comment-slop": "comment-compressor",
}


def test_fanout_roster_line_present_per_skill() -> None:
    """Each fan-out skill names its own bundled agent once, immediately
    under the heading and above the splice marker."""
    for name in _skills_with_fanout():
        agent = FANOUT_ROSTER.get(name)
        assert agent, f"{name}: no expected roster entry in this test — add one"
        text = _skill_text(name)
        heading_at = text.index(FANOUT_HEADING)
        marker_at = text.index(FANOUT_MARKER, heading_at)
        roster_line = text[heading_at:marker_at]
        assert f"`{agent}`" in roster_line, (
            f"{name}: fan-out roster line missing bundled agent `{agent}`"
        )


def test_common_body_has_no_host_mechanics() -> None:
    """Phase 3: Pi-only dispatch/output mechanics live in
    `_shared/fanning-out/pi.md`, not in common skill prose — other hosts
    must never read them as actionable instructions."""
    for name in _skills_with_fanout():
        text = _skill_text(name)
        for token in ("runs.all", "outputMode", "evidence-auditor", "inheritSkills"):
            assert token not in text, (
                f"{name}: host-specific {token!r} leaks into common prose"
            )


def test_delegation_is_scope_driven_not_count_driven() -> None:
    """Phase 3: no mandatory agent counts or fixed multi-scout maps in
    common prose — small scopes stay with the parent, large scopes split by
    module/context, and single-dimension children only for genuinely
    independent questions."""
    for name in _skills_with_fanout():
        flat = re.sub(r"\s+", " ", _skill_text(name).lower())
        for phrase in (
            "per applicable dimension",
            "per applicable level",
            "one child per lens",
            "4-5 lenses",
            "one for domain vocabulary, one for layering",
            "one per layer, one per boundary",
            "file-only",
        ):
            assert phrase not in flat, (
                f"{name}: fixed-count/universal-channel rule still present: {phrase!r}"
            )


def test_serial_policy_names_no_dimension_to_drop() -> None:
    """Phase 3: a serial budget fallback never mandates dropping a named
    dimension/level — remaining coverage is marked unverified instead."""
    for agent in agents.AGENTS:
        text = _host_branch_text(agent)
        for phrase in ("drop ddd first", "drop async first"):
            assert phrase not in text.lower(), (
                f"fanning-out/{agent}.md: named drop order still present"
            )


SCHEMA_HEADING = "### Child finding schema"
EVIDENCE_SCHEMA_HEADING = "### Child evidence schema"

# Phase 7a: judgement skills keep the P0/P1/P2 finding schema (severity is
# meaningful when a child is grading something). Recon skills -- where a
# child answers "where is X" rather than judging it -- get an evidence
# schema instead: no severity/confidence to fabricate for a location fact.
EVIDENCE_SCHEMA_SKILLS = ("research-codebase",)
REQUIRED_EVIDENCE_FIELDS = ("location", "excerpt", "answer")


def test_evidence_schema_present_and_parseable() -> None:
    for name in EVIDENCE_SCHEMA_SKILLS:
        text = _skill_text(name)
        assert EVIDENCE_SCHEMA_HEADING in text, f"{name}: missing child evidence schema"
        section = text[text.index(EVIDENCE_SCHEMA_HEADING) :]
        for field in REQUIRED_EVIDENCE_FIELDS:
            assert f"{field}:" in section, f"{name}: schema missing {field!r} field"
        block_end = section.index("```", section.index("```") + 3)
        assert "severity" not in section[:block_end], (
            f"{name}: evidence schema still carries a severity field"
        )


def test_absence_sentence_is_structured_for_evidence_skills() -> None:
    """Phase 7a: recon's structured absence is 'Not found. Searched: ...
    Expected to find: ...' -- not the judgement skills' 'No issues found.'
    sentence, which implies a verdict a recon child never makes.
    """
    for name in EVIDENCE_SCHEMA_SKILLS:
        text = _skill_text(name)
        assert "Not found. Searched:" in text, (
            f"{name}: absence rule is missing or not structured"
        )
        assert "Expected to find:" in text, (
            f"{name}: absence rule missing 'Expected to find:'"
        )


def test_create_plan_delegates_to_research_codebase() -> None:
    """Phase 7c: create-plan no longer reimplements research-codebase's
    child task template and schema as a second copy; it points at
    research-codebase's procedure instead.
    """
    text = _skill_text("create-plan")
    assert "research-codebase" in text
    assert SCHEMA_HEADING not in text
    assert EVIDENCE_SCHEMA_HEADING not in text
    assert "severity: P0" not in text


def test_review_verdict_vocabulary_complete() -> None:
    """Phase 1: review-plan verdict covers REVISE/COMMENT/APPROVE/INCOMPLETE,
    with any P0/P1 -> REVISE."""
    text = _skill_text("review-plan")
    for verdict in ("REVISE", "COMMENT", "APPROVE", "INCOMPLETE"):
        assert verdict in text, f"review-plan: missing verdict {verdict}"
    assert "any confirmed P0/P1" in text or "any P0" in text, (
        "review-plan: missing any-P0/P1 -> REVISE rule"
    )
    assert "2+ P1" not in text and "2 or more P1" not in text.lower(), (
        "review-plan: old 2+ P1 threshold still present"
    )


def test_research_absence_is_scoped() -> None:
    """Phase 1: research states 'not found within <scope>' unless exhaustive
    inventory proves absence."""
    text = _skill_text("research-codebase")
    assert "not found within" in text.lower(), (
        "research-codebase: missing scoped not-found language"
    )
    assert "exhaustive" in text.lower(), (
        "research-codebase: missing exhaustive-inventory qualifier"
    )


AGENTS_DIR = catalog.SKILLS_DIR.parent / "agents"


def test_agent_definitions_have_valid_frontmatter() -> None:
    """Phase 6 spike result: Pi's project-agent discovery
    (`agents/**/*.md`, per pi-subagents docs/agents.md) already picks these
    up with zero installer code, so this repo ships the definitions
    directly rather than building a second symlink/status/TUI target table.
    No subagent mechanism exists on Claude Code/Codex/OpenCode for these
    (Pi-only, as scoped).
    """
    files = sorted((AGENTS_DIR).glob("*.md"))
    assert len(files) >= 3, (
        f"expected the four Phase 6 agent definitions, found {files}"
    )
    for path in files:
        fm, body = catalog.parse_frontmatter(path.read_text())
        assert fm.get("name") == path.stem, f"{path}: name/filename mismatch"
        assert fm.get("tools"), f"{path}: missing tools"
        assert "write" not in fm["tools"].split(", "), f"{path}: has a write tool"
        assert "contact_supervisor" in fm["tools"], (
            f"{path}: missing contact_supervisor"
        )
        assert body.strip(), f"{path}: empty system prompt"


def test_no_reference_file_exceeds_budget() -> None:
    """No reference file balloons back into another 450-line
    AUDIT_STRATEGY.md: every references/*.md across every skill stays
    small enough that a fanned-out child reads only what it needs.
    """
    for name in catalog.discover_skills():
        refs_dir = catalog.SKILLS_DIR / name / "references"
        if not refs_dir.is_dir():
            continue
        for path in refs_dir.glob("*.md"):
            n = len(path.read_text(encoding="utf-8").splitlines())
            assert n <= 130, (
                f"{path.relative_to(catalog.SKILLS_DIR)}: {n} lines, budget is 130"
            )


def test_audit_strategy_file_is_gone() -> None:
    """Phase 4b: the 450-line monolith is replaced by references/*.md."""
    assert not (catalog.SKILLS_DIR / "testing-strategy" / "AUDIT_STRATEGY.md").exists()
    overview = catalog.SKILLS_DIR / "testing-strategy" / "references" / "overview.md"
    assert overview.is_file()
    assert "AUDIT_STRATEGY.md" not in _skill_text("testing-strategy")


def test_every_reference_is_linked_from_skill_md() -> None:
    """Exact bidirectional match between references/*.md on disk and the
    references/<file>.md paths named in SKILL.md — no orphan file, no
    dangling pointer. SKILL.md always spells the path as `references/<file>`,
    even though a symlinked SKILL.md can't itself hold an absolute path; the
    fan-out block absolutises it against the child's own filesystem view.
    """
    for name in catalog.discover_skills():
        refs_dir = catalog.SKILLS_DIR / name / "references"
        if not refs_dir.is_dir():
            continue
        on_disk = {p.relative_to(refs_dir).as_posix() for p in refs_dir.glob("*.md")}
        linked = set(re.findall(r"references/([\w.-]+\.md)", _skill_text(name)))
        assert on_disk == linked, (
            f"{name}: references/ on disk {on_disk} != linked from SKILL.md {linked}"
        )


def test_descriptions_have_anti_triggers() -> None:
    """Phase 7c: every skill description ends with a closing 'Not ...'
    clause naming what it isn't, so the catalog text itself carries the
    boundary a picker would otherwise have to discover by misfire.
    """
    for name in catalog.discover_skills():
        fm, _ = catalog.parse_frontmatter(_skill_text(name))
        description = fm.get("description", "").strip()
        assert re.search(r"\bNot [^.]+\.\s*$", description), (
            f"{name}: description has no closing anti-trigger clause"
        )


@pytest.mark.parametrize(
    "name",
    [
        "architecture-audit",
        "code-quality-audit",
        "review-plan",
        "testing-strategy",
        "review-implementation",
    ],
)
def test_shared_review_contract_is_bundled(name: str) -> None:
    reference = catalog.SKILLS_DIR / name / "references" / "review.md"
    canonical = catalog.SKILLS_DIR / "_shared" / "review.md"
    assert reference.resolve() == canonical.resolve()
    assert reference in agents._bundled_references(catalog.SKILLS_DIR / name)
    assert canonical.read_text() in agents._codex_body(name)


def test_bundled_agent_references_resolve() -> None:
    for name in _skills_with_fanout():
        for filename in re.findall(r"agents/([a-z-]+[.]md)", _skill_text(name)):
            assert (AGENTS_DIR / filename).is_file(), (name, filename)

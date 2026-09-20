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
        assert FANOUT_MARKER in section, f"{name}: fan-out section missing the splice marker"
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
        assert path.read_text(encoding="utf-8").strip(), f"{agent}: empty fan-out branch"


@pytest.mark.parametrize("agent", ["codex", "opencode"])
def test_serial_branch_states_ordering_and_budget(agent: str) -> None:
    text = _host_branch_text(agent)
    assert re.search(r"[Oo]rdering", text), f"{agent}.md: missing an ordering rule"
    assert re.search(r"[Cc]ontext budget", text), f"{agent}.md: missing a context budget"
    assert re.search(r"[Vv]erification collapses", text), (
        f"{agent}.md: missing the verification-collapse rule"
    )


def test_claude_branch_forbids_nesting() -> None:
    text = _host_branch_text("claude")
    assert re.search(r"cannot spawn\s+further children", text)
    assert "one level of fan-out" in text


FANOUT_ROSTER = {
    "code-quality-audit": "cq-dimension",
    "testing-strategy": "test-level",
    "review-plan": "plan-lens",
    "research-codebase": "repo-scout",
    "create-plan": "repo-scout",
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


MAP_DELEGATION_SKILLS = ("testing-strategy", "code-quality-audit")


def test_map_phase_delegates_to_scout() -> None:
    """Phase 5: both skills dispatch their mapping/recon step to
    `repo-scout` on Pi, and say explicitly that a scout must not judge.
    This is a different slice of the file than `FANOUT_ROSTER` -- the
    bundled *judgement* agent (`test-level`/`cq-dimension`) -- and a
    different concept: recon delegation for the mapping step, inserted
    before the mapping bullets, well above the '### Fanning out' heading.
    """
    for name in MAP_DELEGATION_SKILLS:
        text = _skill_text(name)
        assert "`repo-scout`" in text, f"{name}: mapping step doesn't name repo-scout"
        assert "Judge nothing at this stage" in text, (
            f"{name}: missing the judge-nothing constraint on recon children"
        )


SCHEMA_HEADING = "### Child finding schema"
EVIDENCE_SCHEMA_HEADING = "### Child evidence schema"

# Phase 7a: judgement skills keep the P0/P1/P2 finding schema (severity is
# meaningful when a child is grading something). Recon skills -- where a
# child answers "where is X" rather than judging it -- get an evidence
# schema instead: no severity/confidence to fabricate for a location fact.
FINDING_SCHEMA_SKILLS = (
    "code-quality-audit",
    "testing-strategy",
)
EVIDENCE_SCHEMA_SKILLS = ("research-codebase",)
REQUIRED_FINDING_FIELDS = ("severity", "confidence", "location", "excerpt", "finding")
REQUIRED_EVIDENCE_FIELDS = ("location", "excerpt", "answer")


def test_finding_schema_present_and_parseable() -> None:
    for name in FINDING_SCHEMA_SKILLS:
        text = _skill_text(name)
        assert SCHEMA_HEADING in text, f"{name}: missing child finding schema"
        section = text[text.index(SCHEMA_HEADING) :]
        for field in REQUIRED_FINDING_FIELDS:
            assert f"{field}:" in section, f"{name}: schema missing {field!r} field"


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


def test_empty_result_sentence_is_structured() -> None:
    """The empty-result rule is the structured sentence, not just the bare
    string -- a bare string can't feed an honesty/strengths section. Skills
    may still *mention* the bare string in prose to name the anti-pattern
    they're rejecting; this only requires the structured form to exist too.
    """
    for name in FINDING_SCHEMA_SKILLS:
        text = _skill_text(name)
        assert "No issues found. Checked:" in text, (
            f"{name}: empty-result rule is missing or not structured"
        )
        assert "Solid because:" in text, (
            f"{name}: empty-result rule missing 'Solid because:'"
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


TIERED_VERIFICATION_SKILLS = (
    "code-quality-audit",
    "testing-strategy",
    "research-codebase",
)


def test_no_skill_requires_full_reread() -> None:
    """Positive contract: three named verification tiers, each with its own
    depth — not just the absence of a banned phrase, which would pass
    vacuously if the unconditional rule were reworded rather than tiered.
    """
    for name in TIERED_VERIFICATION_SKILLS:
        text = _skill_text(name)
        assert (
            "top-line recommendation rests on" in text or "answer rests on" in text
        ), f"{name}: missing the load-bearing-finding tier"
        assert "corroborating finding" in text.lower(), (
            f"{name}: missing the corroborating-finding tier"
        )
        assert "everything else" in text.lower() and "spot-check" in text, (
            f"{name}: missing the spot-check tier"
        )
        assert "open each cited file yourself" not in text
        assert "open the key files yourself" not in text


def test_child_return_is_pointer_only() -> None:
    """Phase 6: the parent dispatches with `outputMode: "file-only"` and
    reads only as deep as the finding's verification tier requires --
    never the whole file for a spot-check-tier finding.
    """
    for name in TIERED_VERIFICATION_SKILLS:
        text = _skill_text(name)
        assert 'outputMode: "file-only"' in text, (
            f"{name}: missing the outputMode: file-only dispatch instruction"
        )
        assert "is a pointer, not their findings" in text, (
            f"{name}: missing the pointer-only child return contract"
        )
        assert "spot-check-tier" in text and "top-two-tier" in text, (
            f"{name}: missing a tier reference tied to the pointer-only rule"
        )


INDEX_FINDINGS_AGENTS = ("cq-dimension", "test-level", "plan-lens")


def test_agents_declare_index_then_findings_structure() -> None:
    """Phase 6: the three read-only judgement agents structure their single
    `output:` file as an index (for a cheap spot-check) followed by full
    findings (for a load-bearing one), since a read-only child's output
    file *is* its final message verbatim -- there's no separate short/long
    channel.
    """
    for name in INDEX_FINDINGS_AGENTS:
        path = AGENTS_DIR / f"{name}.md"
        text = path.read_text(encoding="utf-8")
        assert "## Index" in text, f"{name}.md: missing the '## Index' section"
        assert "## Findings" in text, f"{name}.md: missing the '## Findings' section"


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
    assert len(files) >= 4, (
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


DIMENSION_RUBRIC_FILES = (
    "code-quality-audit/references/solid.md",
    "code-quality-audit/references/dry.md",
    "code-quality-audit/references/kiss.md",
    "code-quality-audit/references/typing.md",
    "code-quality-audit/references/errors.md",
    "code-quality-audit/references/ddd.md",
)


def test_dimension_rubrics_are_substantive() -> None:
    """Phase 4a: each dimension rubric grew from a 6-8 line definition into
    a worked reference with a bad/good example pair, not just a longer
    restatement of the same principle.
    """
    for rel in DIMENSION_RUBRIC_FILES:
        path = catalog.SKILLS_DIR / rel
        lines = path.read_text(encoding="utf-8").splitlines()
        assert len(lines) >= 30, f"{rel}: only {len(lines)} lines, expected >= 30"
        text = "\n".join(lines)
        assert "\u274c" in text, f"{rel}: missing a bad-example marker (\u274c)"
        assert "\u2705" in text, f"{rel}: missing a good-example marker (\u2705)"


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
            assert n <= 120, f"{path.relative_to(catalog.SKILLS_DIR)}: {n} lines, budget is 120"


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


def test_single_severity_vocabulary() -> None:
    """Phase 7b: review-plan's children use the same P0/P1/P2 vocabulary as
    the other judgement skills -- no second vocabulary, no mapping
    paragraph translating between them. The human-facing output template
    (critical/major/minor, emoji) is a rendering choice for the reader, not
    a second child-facing vocabulary, and is untouched by this test.
    """
    text = _skill_text("review-plan")
    assert "severity (P0/P1/P2)" in text, (
        "review-plan: child task no longer asks for P0/P1/P2 severity"
    )
    assert "critical/major/minor/suggestion" not in text, (
        "review-plan: old four-value child vocabulary still present"
    )
    assert "the mapping is P0" not in text, (
        "review-plan: the P0->critical mapping paragraph should be deleted"
    )

    agent_text = (catalog.SKILLS_DIR.parent / "agents" / "plan-lens.md").read_text(
        encoding="utf-8"
    )
    assert "severity (P0/P1/P2)" in agent_text, (
        "plan-lens.md: bundled agent still asks for the old severity words"
    )
    assert "critical/major/minor/suggestion" not in agent_text


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

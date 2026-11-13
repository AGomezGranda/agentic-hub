// Audit swarm: scout -> parallel lens reviewers -> verifier. Read-only; the parent triages and fixes.
// args: { scope: "diff vs main" | "path/or/module", round?: 1, lenses?: ["correctness", ...], plan?: "plan path, phase N" }
// Reviewer skill paths are relative to the repository root.
const scope = args.scope || "uncommitted changes plus the last commit";
const round = args.round || 1;
const plan = args.plan ? "\nPlan under implementation: " + args.plan + ". Read it (that phase) before judging; the diff should deliver it." : "";
const S = "skills/";

const LENSES = [
  { key: "plan-conformance", brief: "Compare the diff to the plan phase: missing or half-done items, changes the plan does not call for, success criteria unmet, undocumented deviations. Requires the plan arg." },
  { key: "correctness", brief: "Logic bugs, unhandled edge cases, regressions, error paths that lose data. Judge from the code; no skill file." },
  { key: "architecture", brief: "Read " + S + "architecture-audit/SKILL.md and references/checks.md. Resolve the governing architecture contract as the skill directs. Audit boundaries, ownership and placement; inspect missing edges yourself." },
  { key: "quality", brief: "Apply SOLID, DI, DRY, KISS, typing and error-handling dimensions. Read " + S + "code-quality-audit/SKILL.md and its references/ first. Judge against the rubrics, not the repo's conventions." },
  { key: "tests", brief: "Is risky changed code untested, or are tests weak, flaky or mis-leveled? Read " + S + "testing-strategy/SKILL.md first." },
  { key: "simplicity", brief: "Read " + S + "code-quality-audit/references/checks.md, particularly KISS. Find unnecessary abstraction and work; preserve seams required by the adopted architecture contract." },
  { key: "security", brief: "Trust-boundary validation, injection, secrets, authz, unsafe deserialization; and what breaks under load (unbounded loops, N+1, blocking I/O). Judge from the code." },
];
const wanted = args.lenses || LENSES.filter((l) => plan || l.key !== "plan-conformance").map((l) => l.key);

const scout = await runs.run("scout-r" + round, {
  label: "Map swarm scope",
  agent: "scout",
  output: "swarm/r" + round + "-scout.md",
  task: "Recon only, change nothing. Scope: " + scope + "." + plan + "\n" +
    "Return under 250 lines: (1) files in scope with a one-line role each; (2) entry points and public interfaces; " +
    "(3) module boundaries and declared rules (ADRs, import contracts, AGENTS.md/CLAUDE.md); (4) the exact test and lint commands; " +
    "(5) the source tree to depth 4 (directories only, with file counts) and the output of any configured architecture checker (lint-imports, depcruise, eslint boundaries), or `none configured`; " +
    "(6) resolve the exact requested diff: for uncommitted work use git status --short, git diff HEAD and read untracked files; for a branch diff use its explicit base. Do not add committed history to a local review. Include relevant hunks and list omitted areas for reviewers to inspect.",
});
if (!scout.ok) return { failed: "scout", output: scout.output };

const rules = "\n\nRules: READ-ONLY, never edit or run mutating commands, never spawn agents. Stay inside the scope. " +
  "Read skills/_shared/review.md for finding, severity and coverage requirements. Report all confirmed findings, grouping systemic issues. " +
  "Use the shared contract and include coverage with remaining probes; a shortlist is not complete coverage.";

const lenses = LENSES.filter((l) => wanted.indexOf(l.key) >= 0);
const reviews = await runs.all(lenses.map((l) => ({
  key: l.key + "-r" + round,
  label: "Review " + l.key,
  agent: "audit-reviewer",
  output: "swarm/r" + round + "-" + l.key + ".md",
  task: "Lens: " + l.key + ". " + l.brief + "\nScope: " + scope + plan + "\n\nScout map:\n" + scout.output + rules,
})));

const reports = reviews.map((r, i) => "## Lens " + lenses[i].key + (r.ok ? "" : " (RUN FAILED, unchecked)") + "\n" + r.output).join("\n\n");

const verdict = await runs.run("verify-r" + round, {
  label: "Verify and rank findings",
  agent: "audit-reviewer",
  output: "swarm/r" + round + "-verified.md",
  task: "Read skills/_shared/review.md. Independent verifier. Below are findings from parallel lens reviewers. Scope: " + scope + ".\n" +
    "For EVERY finding: open the cited file:line yourself and check the excerpt and claim against current source. Merge duplicates across lenses (same file:line and rule ID). " +
    "Classify each as BLOCKER (concrete failure/repro/contract break), NON-BLOCKER (real, outside this slice), STALE, INVALID (cite the contradicting source), or SPECULATIVE. " +
    "Output: (1) a ranked table `ID | class | severity | file:line | one-line fix`; (2) accepted findings (BLOCKER + worthwhile NON-BLOCKER) grouped into fix batches, each batch one seam with the files it owns so one writer can take it; " +
    "(3) lenses that failed or areas left unchecked. Do not fix anything." +
    "\n\n" + reports,
});

return {
  round: round,
  verified: verdict.output,
  verifiedPath: verdict.outputReference,
  lensReports: reviews.map((r) => r.outputReference),
  failedLenses: reviews.map((r, i) => r.ok ? null : lenses[i].key).filter((k) => k),
};

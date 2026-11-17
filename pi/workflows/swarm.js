// Up to three reviewers total. The parent maps scope, verifies findings and fixes.
// args: { scope: "diff vs main" | "path/or/module", round?: 1, lenses?: ["correctness", ...], plan?: "plan path, phase N" }
// Reviewer skill paths are relative to the repository root.
const scope = args.scope || "uncommitted changes";
const round = args.round || 1;
const plan = args.plan ? "\nPlan under implementation: " + args.plan + ". Read it (that phase) before judging; the diff should deliver it." : "";
const S = "skills/";

const LENSES = [
  { key: "plan-conformance", brief: "Compare the diff to the plan phase: missing or half-done items, changes the plan does not call for, success criteria unmet, undocumented deviations. Requires the plan arg." },
  { key: "correctness", brief: "Logic bugs, unhandled edge cases, regressions, error paths that lose data. Trace atomic writes, duplicate-safe retries, concurrent updates and recovery after partial failure. Judge from the code; no skill file." },
  { key: "architecture", brief: "Read " + S + "architecture-audit/SKILL.md and references/checks.md. Resolve the governing architecture contract as the skill directs. Audit boundaries, ownership and placement; inspect missing edges yourself." },
  { key: "quality", brief: "Apply SOLID, DI, DRY, KISS, typing and error-handling dimensions. Read " + S + "code-quality-audit/SKILL.md and its references/ first. Judge against the rubrics, not the repo's conventions." },
  { key: "tests", brief: "Is risky changed code untested, or are tests weak, flaky or mis-leveled? Read " + S + "testing-strategy/SKILL.md first. Inspect timeout/cancellation, resource cleanup, bounded work and shutdown tests; establish how failures are observable without leaking secrets." },
  { key: "simplicity", brief: "Read " + S + "code-quality-audit/references/checks.md, particularly KISS. Find unnecessary abstraction and work; preserve seams required by the adopted architecture contract." },
  { key: "security", brief: "Trust-boundary validation, injection, secrets, authz, unsafe deserialization; and what breaks under load (unbounded loops, N+1, blocking I/O). Judge from the code." },
];
const wanted = args.lenses || LENSES.filter((l) => plan || l.key !== "plan-conformance").map((l) => l.key);

if (!Array.isArray(wanted) || !wanted.length || wanted.some((key) => !LENSES.some((lens) => lens.key === key))) {
  throw new Error("Select at least one known review lens");
}
if (wanted.includes("plan-conformance") && !plan) throw new Error("plan-conformance requires a plan");

const rules = "\n\nRules: READ-ONLY, never edit or run mutating commands, never spawn agents. Stay inside the scope. " +
  "Read skills/_shared/review.md for finding, severity and coverage requirements. Report all confirmed findings, grouping systemic issues. " +
  "Use the shared contract and include coverage with remaining probes; a shortlist is not complete coverage. " +
  "Resolve scope using git diff HEAD and untracked files for local changes, or the explicit branch base. Inspect callers and governing rules yourself; ask the parent for unavailable command evidence.";

const lenses = LENSES.filter((l) => wanted.indexOf(l.key) >= 0);
const groups = [
  { key: "behavior-safety", keys: ["plan-conformance", "correctness", "security"] },
  { key: "design-simplicity", keys: ["architecture", "quality", "simplicity"] },
  { key: "verification-operation", keys: ["tests"] },
].map((group) => ({ ...group, lenses: lenses.filter((lens) => group.keys.includes(lens.key)) }))
  .filter((group) => group.lenses.length > 0);
const reviews = await runs.all(groups.map((group) => ({
  key: group.key + "-r" + round,
  label: "Review " + group.key,
  agent: "audit-reviewer",
  output: "swarm/r" + round + "-" + group.key + ".md",
  task: group.lenses.map((lens) => "Lens: " + lens.key + ". " + lens.brief).join("\n") +
    "\nApply every assigned lens fully and report coverage per lens.\nScope: " + scope + plan +
    rules,
})));

const reports = reviews.map((r, i) => "## Group " + groups[i].key + (r.ok ? "" : " (RUN FAILED, unchecked)") + "\n" + r.output).join("\n\n");

return {
  round,
  status: "requires-parent-verification",
  reports,
  lensReports: reviews.map((r) => r.outputReference),
  failedLenses: reviews.flatMap((r, i) => r.ok ? [] : groups[i].lenses.map((lens) => lens.key)),
};

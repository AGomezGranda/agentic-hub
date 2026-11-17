const R = "skills/code-quality-audit/";
const scopes = [
  { k: "factory", s: "payo/modules/factory/src/ (domain, application and infrastructure)" },
  { k: "packages-adapters", s: "payo/packages/ and payo/adapters/; include port/adapter contracts" },
  { k: "apps", s: "payo/apps/ (server, CLI and web); include cross-app contracts" },
];
const rules = "\n\nRules: READ-ONLY, never edit or run mutating commands, never spawn agents. Stay in scope; read callers elsewhere only to judge contracts. " +
  "Read " + R + "SKILL.md, references/checks.md and references/review.md. Apply their evidence and coverage contract. " +
  "Review SOLID, DI, DRY, KISS, typing and errors against adopted requirements and concrete consequences. " +
  "Inspect tests and callers as needed. Report every confirmed finding, grouped by root cause, with coverage and unresolved concerns.";
// Parent must have three unused child slots; verify results in the parent.
const res = await runs.all(scopes.map((x) => ({
  key: "cq-" + x.k,
  label: "Code quality " + x.k,
  agent: "audit-reviewer",
  output: "cq-payo/" + x.k + ".md",
  task: "Code-quality audit. Key: " + x.k + ". Scope: " + x.s + ". Project payo/ in the current repository." + rules,
})));
return res.map((r, i) => ({ key: scopes[i].k, ok: r.ok, output: r.output }));

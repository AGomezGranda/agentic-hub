const R = "skills/code-quality-audit/";
const scopes = [
  { k: "factory-execution", s: "payo/modules/factory/src/execution.ts (2.3k lines) only; read its sibling execution-*.ts only for contracts" },
  { k: "factory-rest", s: "payo/modules/factory/src/ EXCEPT execution.ts (commands.ts, execution-review.ts, execution-roles.ts, execution-state.ts, read-models, roles, plans, etc.)" },
  { k: "packages", s: "payo/packages/ (config, contracts, kernel)" },
  { k: "adapters", s: "payo/adapters/ (checks-process, git, jira-acli, runner-fake, runner-pi, store-sqlite)" },
  { k: "apps-server-cli", s: "payo/apps/server and payo/apps/cli" },
  { k: "apps-web", s: "payo/apps/web/src (React UI)" },
];
const rules = "\n\nRules: READ-ONLY, never edit or run mutating commands, never spawn agents. Stay in scope; read callers elsewhere only to judge contracts. " +
  "Read " + R + "SKILL.md, references/checks.md and references/review.md. Apply their evidence and coverage contract. " +
  "Review SOLID, DI, DRY, KISS, typing and errors against adopted requirements and concrete consequences. " +
  "Inspect tests and callers as needed. Report every confirmed finding, grouped by root cause, with coverage and unresolved concerns.";
const res = await runs.all(scopes.map((x) => ({
  key: "cq-" + x.k,
  label: "Code quality " + x.k,
  agent: "audit-reviewer",
  output: "cq-payo/" + x.k + ".md",
  task: "Code-quality audit. Key: " + x.k + ". Scope: " + x.s + ". Project payo/ in the current repository." + rules,
})));
return res.map((r, i) => ({ key: scopes[i].k, ok: r.ok, output: r.output }));

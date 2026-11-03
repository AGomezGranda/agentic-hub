const R = "/Users/alvaro.gomez/.pi/agent/skills/code-quality-audit/";
const scopes = [
  { k: "factory-execution", s: "payo/modules/factory/src/execution.ts (2.3k lines) only; read its sibling execution-*.ts only for contracts" },
  { k: "factory-rest", s: "payo/modules/factory/src/ EXCEPT execution.ts (commands.ts, execution-review.ts, execution-roles.ts, execution-state.ts, read-models, roles, plans, etc.)" },
  { k: "packages", s: "payo/packages/ (config, contracts, kernel)" },
  { k: "adapters", s: "payo/adapters/ (checks-process, git, jira-acli, runner-fake, runner-pi, store-sqlite)" },
  { k: "apps-server-cli", s: "payo/apps/server and payo/apps/cli" },
  { k: "apps-web", s: "payo/apps/web/src (React UI)" },
];
const rules = "\n\nRules: READ-ONLY, never edit or run mutating commands, never spawn agents. Stay in scope; read callers elsewhere only to judge contracts. " +
  "FIRST read " + R + "SKILL.md sections 'Boundary', 'Child finding schema' and 'Judgement rules', then the five rubrics " + R + "references/{solid,dry,kiss,typing,errors}.md. " +
  "Dimensions: SOLID, DRY, KISS, typing, error handling. Judge against the repo's own conventions (payo/biome.json, tsconfig strictness) first. Skip *.test.* files except to check what contract they pin. " +
  "Out of scope (name in one line, do not analyse): architecture/boundaries, security, performance, test strategy. " +
  "Report at most 10 findings, ranked, in the finding schema (finding ID prefixed with your key, severity P0/P1/P2, confidence, location path:line, verbatim excerpt, violated contract, consequence, counterevidence considered, correction). " +
  "Group systemic issues once with representative instances. Also list dimensions that are solid as `No issues found. Checked: ... Solid because: ...`, and what you did not read.";
const res = await runs.all(scopes.map((x) => ({
  key: "cq-" + x.k,
  label: "Code quality " + x.k,
  agent: "reviewer",
  output: "cq-payo/" + x.k + ".md",
  task: "Code-quality audit. Key: " + x.k + ". Scope: " + x.s + ". Repo root /Users/alvaro.gomez/code/agentic-hub, project payo/." + rules,
})));
return res.map((r, i) => ({ key: scopes[i].k, ok: r.ok, output: r.output }));

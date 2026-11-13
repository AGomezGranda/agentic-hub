import { createMemoryRunStore } from "@payo/kernel";
import { describe, expect, it } from "vitest";
import {
	executionImplementerSpec,
	executionPreparerSpec,
	executionRepairSpec,
	executionReviewSpec,
	executionScoutSpec,
	executionVerifierSpec,
} from "./execution-roles.ts";
import { QUALITY_EXPECTATIONS } from "./quality.ts";
import { snapshotRole } from "./roles.ts";
import type { RoleSource } from "./types.ts";

const roleSource: RoleSource = {
	path: "skills/implement-plan/SKILL.md",
	sha: "implement-sha",
	content: "Implement the selected phase.",
	resources: {
		"skills/architecture-audit/references/checks.md":
			"Architecture rubric body.",
		"skills/architecture-audit/references/standard.md":
			"Architecture standard body.",
		"skills/_shared/review.md": "Architecture review contract.",
		"skills/code-quality-audit/references/checks.md": "Code quality checks.",
		"skills/code-quality-audit/references/review.md":
			"Quality review contract.",
		"skills/architecture-audit/SKILL.md": "Architecture audit skill.",
		"skills/code-quality-audit/SKILL.md": "Code quality audit skill.",
		"skills/testing-strategy/SKILL.md": "Testing strategy skill.",
		"skills/testing-strategy/references/unit.md": "Testing unit rubric.",
	},
};

function expectApprovalAuthority(instructions: string) {
	expect(instructions).toContain(
		"The human has approved this exact plan snapshot through Payo's approval gate",
	);
	expect(instructions).toContain(
		"status: draft, pending review/approval wording, and notices that a draft is not authorization",
	);
	expect(instructions).toContain(
		"Continue to report substantive scope conflicts, missing requirements, and unmet technical or operational prerequisites",
	);
}

function expectOutputShape(spec: { instructions: string }, shape: string) {
	expect(spec.instructions).toContain(shape);
	expect(spec.instructions).toContain(
		"fields at the top level, without a kind/mediaType/content wrapper",
	);
}

async function refs() {
	const store = createMemoryRunStore();
	const role = await snapshotRole(store, roleSource);
	const implementerRole = await snapshotRole(store, {
		...roleSource,
		addendum: QUALITY_EXPECTATIONS,
	});
	const reviewRole = await snapshotRole(store, {
		...roleSource,
		path: "skills/review-implementation/SKILL.md",
		addendum: QUALITY_EXPECTATIONS,
	});
	const plan = await store.putArtifact(
		new TextEncoder().encode("approved plan"),
		{
			kind: "approved-plan",
			mediaType: "text/markdown",
		},
	);
	const phase = await store.putArtifact(
		new TextEncoder().encode("phase data"),
		{
			kind: "phase",
			mediaType: "application/json",
		},
	);
	const instructions = await store.putArtifact(new TextEncoder().encode("{}"), {
		kind: "repository-instructions",
		mediaType: "application/json",
	});
	const findings = await store.putArtifact(
		new TextEncoder().encode("verified findings"),
		{
			kind: "findings",
			mediaType: "application/json",
		},
	);
	const checkLogs = await store.putArtifact(
		new TextEncoder().encode("check log"),
		{
			kind: "check-log",
			mediaType: "application/json",
		},
	);
	const diff = await store.putArtifact(new TextEncoder().encode("diff"), {
		kind: "diff",
		mediaType: "text/x-diff",
	});
	const scopeMap = await store.putArtifact(
		new TextEncoder().encode("scope map"),
		{
			kind: "scope-map",
			mediaType: "application/json",
		},
	);
	return {
		store,
		role,
		implementerRole,
		reviewRole,
		plan,
		phase,
		instructions,
		findings,
		checkLogs,
		diff,
		scopeMap,
	};
}

describe("execution role specs", () => {
	it("prepares only an exact, ordered manifest without writing", async () => {
		const { store, role, plan } = await refs();
		const spec = await executionPreparerSpec(
			store,
			role,
			plan,
			{
				id: "pr-1",
				title: "First change",
				phases: ["Add the boundary"],
			},
			{ model: null, timeoutMs: 1000 },
			"/repo",
		);

		expect(spec).toMatchObject({
			role: "execution-preparer",
			tools: "read-only",
			outputContract: "factory-execution-manifest-v1",
			roleSpecSha: "implement-sha",
		});
		expectOutputShape(spec, '"pr": {"id": string, "title": string}');
		expect(spec.instructions).toContain('"acceptanceCriteria": string[]');
		expect(spec.instructions).toContain(
			'"prerequisites": [{"description": string',
		);
		expect(spec.instructions).toContain("Do not implement or modify files");
		expect(spec.instructions).toContain("exact nonempty substring");
		expect(spec.instructions).toContain("one-to-one, in order");
		expectApprovalAuthority(spec.instructions);
		expect(spec.instructions).toContain(
			"Payo has already resolved the approved PR strategy references",
		);
		expect(spec.instructions).toContain(
			"this normalization is not a plan discrepancy",
		);
	});

	it("gives the writer only current-phase inputs and explicit engine overrides", async () => {
		const { store, implementerRole, plan, phase, instructions } = await refs();
		const spec = await executionImplementerSpec(store, implementerRole, {
			plan,
			phase,
			repositoryInstructions: instructions,
			cwd: "/worktree",
			model: "provider/model",
			timeoutMs: 1000,
			workspace: { path: "/worktree", branch: "payo/id", baseCommit: "base" },
		});

		expect(spec).toMatchObject({
			role: "implementer",
			tools: "write",
			cwd: "/worktree",
			outputContract: "factory-execution-implementation-v1",
			inputs: expect.arrayContaining([
				expect.objectContaining({ name: "approved-plan", ref: plan }),
				expect.objectContaining({ name: "phase", ref: phase }),
				expect.objectContaining({
					name: "repository-instructions",
					ref: instructions,
				}),
			]),
		});
		expect(spec.instructions).toContain(
			"Do not commit, reset, switch branches, push",
		);
		expect(spec.instructions).toContain(
			"trusted local-code execution boundary, not a sandbox",
		);
		expect(spec.instructions).toContain("Architecture rubric body.");
		expect(spec.instructions).toContain("Code quality checks.");
		expect(spec.instructions).toContain("Do not spawn agents or delegate");
		expect(spec.instructions).toContain(QUALITY_EXPECTATIONS);
		expectOutputShape(
			spec,
			'"completedCriteria": string[], "planIssues": string[]',
		);
		expectApprovalAuthority(spec.instructions);
	});

	it("wires eight independent review roles with scoped audit material", async () => {
		const {
			store,
			reviewRole,
			plan,
			phase,
			instructions,
			diff,
			checkLogs,
			scopeMap,
			findings,
		} = await refs();
		for (const [lens, expected] of [
			["architecture", "Architecture audit skill."],
			["code-quality", "Code quality audit skill."],
			["tests", "Testing strategy skill."],
		] as const) {
			const spec = await executionReviewSpec(store, reviewRole, {
				lens,
				plan,
				phase,
				diff,
				checks: checkLogs,
				scopeMap,
				repositoryInstructions: instructions,
				cwd: "/worktree",
				model: null,
				timeoutMs: 1000,
			});
			expect(spec.tools).toBe("read-only");
			expectOutputShape(spec, '"checked": string[], "findings": [');
			expect(spec.instructions).toContain('"suggestedFix": string');
			expectApprovalAuthority(spec.instructions);
			expect(spec.instructions).toContain(expected);
			expect(spec.instructions).toContain(
				"Do not converse with the user, commit, edit files, or spawn/delegate agents",
			);
			expect(spec.instructions).toContain(
				"Each report must list concrete items checked",
			);
			expect(spec.inputs.map((item) => item.name)).toEqual([
				"role-source",
				"approved-plan",
				"phase",
				"engine-diff",
				"engine-check-results",
				"changed-file-scope-map",
				"repository-instructions",
			]);
		}
		const architecture = await executionReviewSpec(store, reviewRole, {
			lens: "architecture",
			plan,
			phase,
			diff,
			checks: checkLogs,
			scopeMap,
			repositoryInstructions: instructions,
			cwd: "/worktree",
			model: null,
			timeoutMs: 1000,
		});
		const quality = await executionReviewSpec(store, reviewRole, {
			lens: "code-quality",
			plan,
			phase,
			diff,
			checks: checkLogs,
			scopeMap,
			repositoryInstructions: instructions,
			cwd: "/worktree",
			model: null,
			timeoutMs: 1000,
		});
		expect(architecture.instructions).toContain("Architecture rubric body.");
		expect(architecture.instructions).toContain("Architecture standard body.");
		expect(architecture.instructions).toContain(
			"Architecture review contract.",
		);
		expect(quality.instructions).toContain("Code quality checks.");
		expect(quality.instructions).toContain("Architecture review contract.");

		const scout = await executionScoutSpec(store, reviewRole, {
			plan,
			phase,
			diff,
			repositoryInstructions: instructions,
			cwd: "/worktree",
			model: null,
			timeoutMs: 1000,
		});
		expect(scout.tools).toBe("read-only");
		expectOutputShape(
			scout,
			'"summary": string, "files": [{"path": string, "purpose": string, "instructionPaths": string[]}], "planIssues": string[]',
		);
		expectApprovalAuthority(scout.instructions);
		expect(scout.instructions).toContain(
			"Do not run git, tests, subprocesses, or agents",
		);

		const verifier = await executionVerifierSpec(store, reviewRole, {
			plan,
			phase,
			diff,
			checks: checkLogs,
			scopeMap,
			repositoryInstructions: instructions,
			reports: findings,
			cwd: "/worktree",
			model: null,
			timeoutMs: 1000,
		});
		expect(verifier.tools).toBe("read-only");
		expectOutputShape(verifier, '"verdicts": [{"sourceIds": string[]');
		expect(verifier.instructions).toContain('"planIssues": string[]');
		expectApprovalAuthority(verifier.instructions);
		expect(verifier.instructions).toContain(
			"Cover every finding ID exactly once",
		);
		expect(verifier.inputs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "lens-reports", ref: findings }),
			]),
		);

		const repair = await executionRepairSpec(store, reviewRole, {
			plan,
			phase,
			repositoryInstructions: instructions,
			findings,
			cwd: "/worktree",
			model: null,
			timeoutMs: 1000,
			workspace: { path: "/worktree", branch: "payo/id", baseCommit: "base" },
			checkLogs,
			diff,
		});
		expect(repair).toMatchObject({
			tools: "write",
			outputContract: "factory-execution-repair-v1",
		});
		expectApprovalAuthority(repair.instructions);
		expectOutputShape(
			repair,
			'"addressedFindingIds": string[], "unresolvedFindingIds": string[], "planIssues": string[]',
		);
		expect(repair.instructions).toContain(
			"Return each supplied finding ID exactly once",
		);
	});
});

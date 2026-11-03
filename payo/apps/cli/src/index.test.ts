import type { RunSummary } from "@payo/contracts";
import { expect, it } from "vitest";
import { formatSummary } from "./index.ts";

it("renders linked execution status and engine-owned check results", () => {
	const summary: RunSummary = {
		runId: "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e",
		repo: "/repo",
		baseBranch: "main",
		status: "active",
		outcome: null,
		stage: "Escalated",
		workItem: null,
		startedAt: "2026-11-02T00:00:00.000Z",
		updatedAt: "2026-11-02T00:01:00.000Z",
		openGates: [],
		execution: {
			runId: "8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e",
			sourceRunId: "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e",
			prId: "pr-1",
			phaseCount: 2,
			completedPhases: [{ id: "phase-1", title: "One", resultCommit: "c1" }],
			resultCommit: null,
			artifactIssues: [],
			status: "active",
			outcome: null,
			stage: "Escalated",
			phaseIndex: 0,
			scope: "phase",
			branch: "payo/8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e",
			worktree: "/data/worktrees/execution",
			statusDetail: "checked-unreviewed",
			escalationReason: "review-unavailable",
			checks: [{ name: "unit", status: "passed" }],
			review: {
				lenses: ["architecture", "code-quality"],
				uncheckedLenses: ["tests"],
				findings: 2,
				unresolved: 1,
				acceptedFindingIds: ["architecture:1"],
				unresolvedFindingIds: ["code-quality:1"],
				round: 2,
			},
		},
	};

	const output = formatSummary(summary);
	expect(output).toContain("execution: 8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e");
	expect(output).toContain("phase: 1 of 2 (Escalated)");
	expect(output).toContain("completed phases: 1/2");
	expect(output).toContain("execution detail: checked-unreviewed");
	expect(output).toContain("execution gate: review-unavailable");
	expect(output).toContain("checks: unit=passed");
	expect(output).toContain(
		"review: 2/8 lenses; 2 findings; 1 unresolved; round 2 (phase)",
	);
	expect(output).toContain("unchecked lenses: tests");
	expect(output).toContain("accepted findings: architecture:1");
	expect(output).toContain("unresolved findings: code-quality:1");
});

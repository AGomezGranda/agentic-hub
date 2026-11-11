import { describe, expect, it } from "vitest";
import {
	accountRepair,
	applyExecutionCheckpoint,
	assertExecutionTransition,
	executionResumeConflict,
	executionResumeStage,
	initialExecutionCheckpoint,
	validateExecutionManifest,
	validationAction,
} from "./domain/execution.ts";

const markdown = `# Plan

## Phase 1
Implement the boundary.

Acceptance: the adapter no longer owns domain policy.
`;

const phase = {
	id: "phase-1",
	title: "Boundary",
	planExcerpt: "## Phase 1\nImplement the boundary.",
	acceptanceCriteria: ["Acceptance: the adapter no longer owns domain policy."],
};

const manifest = {
	pr: { id: "pr-1", title: "One" },
	phases: [phase],
	prerequisites: [{ description: "Source base", ref: "main" }],
	issues: [],
};

it("only repairs or retries checks while a validation cycle remains", () => {
	expect(validationAction("passed", 3)).toBe("review");
	expect(validationAction("failed", 2)).toBe("repair");
	expect(validationAction("dirty", 2)).toBe("retry");
	expect(validationAction("failed", 3)).toBe("escalate");
	expect(validationAction("dirty", 3)).toBe("escalate");
});

it("resumes preparation or rechecks retained work according to checkpoint evidence", () => {
	const checkpoint = initialExecutionCheckpoint();
	expect(() => executionResumeStage(checkpoint)).toThrow("not resumable");
	checkpoint.inFlight = { operation: "Repair", stepIds: ["step"] };
	expect(executionResumeStage(checkpoint)).toBe("Prepare");
	checkpoint.manifest = {
		sha256: "a".repeat(64),
		size: 1,
		kind: "manifest",
		mediaType: "application/json",
	};
	expect(executionResumeStage(checkpoint)).toBe("Check");
	checkpoint.inFlight.operation = "Implement";
	expect(executionResumeStage(checkpoint)).toBe("Implement");
	checkpoint.scope = "final";
	expect(executionResumeStage(checkpoint)).toBe("Finalize");
});

it("rejects unrelated gates and allows retry against the pinned plan", () => {
	const checkpoint = initialExecutionCheckpoint();
	expect(executionResumeConflict(checkpoint, [])).toBe(
		"execution is not resumable",
	);
	checkpoint.stage = "Escalated";
	checkpoint.inFlight = { operation: "Repair", stepIds: ["owned"] };
	const gate = { gateId: "gate", stepId: "other", status: "open" };
	expect(executionResumeConflict(checkpoint, [gate])).toBe(
		"unrelated open gate gate",
	);
	expect(
		executionResumeConflict(checkpoint, [{ ...gate, status: "resolved" }]),
	).toBeNull();
	expect(
		executionResumeConflict(checkpoint, [{ ...gate, stepId: "owned" }]),
	).toBeNull();
	checkpoint.statusDetail = "repair-plan-issue";
	expect(executionResumeConflict(checkpoint, [])).toBeNull();
});

describe("execution checklist", () => {
	it("accepts a legal transition and rejects the rest", () => {
		expect(() =>
			assertExecutionTransition("Prepare", "Implement"),
		).not.toThrow();
		expect(() => assertExecutionTransition("Check", "Repair")).not.toThrow();
		expect(() =>
			assertExecutionTransition("Implement", "Implement"),
		).not.toThrow();
		expect(() =>
			assertExecutionTransition("Review", "Implement"),
		).not.toThrow();
		expect(() => assertExecutionTransition("Completed", "Prepare")).toThrow(
			/illegal execution transition/,
		);
	});

	it("rejects stale and non-advancing checkpoint writes", () => {
		const current = initialExecutionCheckpoint();
		const next = { ...current, revision: 1, stage: "Implement" as const };
		expect(applyExecutionCheckpoint(current, 0, next)).toEqual(next);
		expect(() => applyExecutionCheckpoint(current, 1, next)).toThrow(/stale/);
		expect(() =>
			applyExecutionCheckpoint(current, 0, { ...next, revision: 2 }),
		).toThrow(/advance by one/);
		expect(() =>
			applyExecutionCheckpoint(current, 0, {
				...next,
				stage: "Review" as const,
			}),
		).toThrow(/illegal execution transition/);
	});

	it("requires a receipt for each single-step phase advance", () => {
		const current = {
			...initialExecutionCheckpoint(),
			stage: "Review" as const,
		};
		const receipt = {
			sha256: "a".repeat(64),
			size: 1,
			kind: "factory-execution-phase-receipt-v1",
			mediaType: "application/json",
		};
		expect(() =>
			applyExecutionCheckpoint(current, 0, {
				...current,
				revision: 1,
				stage: "Implement",
				phaseIndex: 1,
			}),
		).toThrow(/phase advance requires exactly one new receipt/);
		expect(
			applyExecutionCheckpoint(current, 0, {
				...current,
				revision: 1,
				stage: "Implement",
				phaseIndex: 1,
				receipts: [receipt],
			}),
		).toMatchObject({ phaseIndex: 1, receipts: [receipt] });
	});

	it("keeps phase progress and receipts append-only", () => {
		const receipt = {
			sha256: "a".repeat(64),
			size: 1,
			kind: "test",
			mediaType: "application/json",
		};
		const current = {
			...initialExecutionCheckpoint(),
			phaseIndex: 2,
			receipts: [receipt],
		};
		expect(() =>
			applyExecutionCheckpoint(current, 0, {
				...current,
				revision: 1,
				phaseIndex: 1,
			}),
		).toThrow(/phase index cannot regress/);
		expect(() =>
			applyExecutionCheckpoint(current, 0, {
				...current,
				revision: 1,
				receipts: [],
			}),
		).toThrow(/receipts cannot be removed/);
		expect(() =>
			applyExecutionCheckpoint(current, 0, {
				...current,
				revision: 1,
				receipts: [{ ...receipt, sha256: "b".repeat(64) }],
			}),
		).toThrow(/receipt 0 changed/);
	});

	it("validates excerpts, criteria, identifiers, and prerequisites", () => {
		expect(validateExecutionManifest(manifest, markdown)).toEqual(manifest);
		expect(() =>
			validateExecutionManifest(
				{ ...manifest, issues: ["stale strategy"] },
				markdown,
			),
		).toThrow(/issues/);
		expect(() =>
			validateExecutionManifest(
				{ ...manifest, phases: [{ ...phase, id: "phase-2" }] },
				markdown,
			),
		).toThrow(/deterministic id/);
		expect(() =>
			validateExecutionManifest(
				{ ...manifest, phases: [{ ...phase, planExcerpt: "missing" }] },
				markdown,
			),
		).toThrow(/excerpt/);
		expect(() =>
			validateExecutionManifest(
				{
					...manifest,
					phases: [{ ...phase, acceptanceCriteria: ["missing criterion"] }],
				},
				markdown,
			),
		).toThrow(/acceptance criterion/);
		expect(() =>
			validateExecutionManifest(
				{
					...manifest,
					prerequisites: [{ description: "unresolved" }],
				},
				markdown,
			),
		).toThrow(/requires ref or paths/);
	});

	it("binds the manifest to the approved PR strategy one-to-one", () => {
		const selected = {
			id: "pr-1",
			title: "One",
			phases: ["Implement the boundary"],
		};
		expect(validateExecutionManifest(manifest, markdown, selected)).toEqual(
			manifest,
		);
		expect(() =>
			validateExecutionManifest(
				{ ...manifest, pr: { id: "pr-2", title: "Other" } },
				markdown,
				selected,
			),
		).toThrow(/selected PR/);
		expect(() =>
			validateExecutionManifest(
				{ ...manifest, phases: [] },
				markdown,
				selected,
			),
		).toThrow(/phase count/);
		expect(() =>
			validateExecutionManifest(
				{
					...manifest,
					phases: [
						{
							...phase,
							planExcerpt:
								"Acceptance: the adapter no longer owns domain policy.",
						},
					],
				},
				markdown,
				selected,
			),
		).toThrow(/strategy phase/);
	});

	it("accounts for every repair finding exactly once", () => {
		expect(
			accountRepair(["a", "b"], {
				summary: "fixed",
				addressedFindingIds: ["a"],
				unresolvedFindingIds: ["b"],
				planIssues: [],
			}),
		).toEqual({ addressed: ["a"], unresolved: ["b"] });
		const output = {
			summary: "fixed",
			addressedFindingIds: [],
			unresolvedFindingIds: [],
			planIssues: [],
		};
		expect(() =>
			accountRepair(["a"], { ...output, addressedFindingIds: ["unknown"] }),
		).toThrow(/unknown/);
		expect(() =>
			accountRepair(["a", "b"], {
				...output,
				addressedFindingIds: ["a"],
			}),
		).toThrow(/missing repair finding id b/);
		expect(() => accountRepair(["a", "a"], output)).toThrow(/duplicate/);
		expect(() =>
			accountRepair(["a"], {
				...output,
				addressedFindingIds: ["a"],
				unresolvedFindingIds: ["a"],
			}),
		).toThrow(/duplicate/);
	});
});

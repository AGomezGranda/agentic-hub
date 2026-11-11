import {
	ExecutionCheckpoint,
	ExecutionManifest,
	type ExecutionStage,
	FactoryRunConfig,
	type Finding,
	type RepairOutput,
	type VerifiedOutput,
} from "@payo/contracts";

export const MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const MAX_VALIDATION_CYCLES = 3;

export function validationAction(
	status: "passed" | "failed" | "dirty",
	cycle: number,
): "review" | "retry" | "repair" | "escalate" {
	if (status === "passed") return "review";
	if (cycle >= MAX_VALIDATION_CYCLES) return "escalate";
	return status === "dirty" ? "retry" : "repair";
}

export function executionResumeStage(
	checkpoint: ExecutionCheckpoint,
): ExecutionStage {
	if (!checkpoint.inFlight) throw new Error("execution is not resumable");
	if (!checkpoint.manifest) return "Prepare";
	if (checkpoint.commitIntent) return "Review";
	if (checkpoint.scope === "final") return "Finalize";
	return ["Check", "Review", "Repair"].includes(checkpoint.inFlight.operation)
		? "Check"
		: "Implement";
}

export function executionResumeConflict(
	checkpoint: ExecutionCheckpoint,
	gates: Iterable<{ status: string; stepId: string; gateId: string }>,
): string | null {
	if (checkpoint.stage !== "Escalated" || !checkpoint.inFlight)
		return "execution is not resumable";
	const owned = new Set(checkpoint.inFlight.stepIds);
	for (const gate of gates)
		if (gate.status === "open" && !owned.has(gate.stepId))
			return `unrelated open gate ${gate.gateId}`;
	return null;
}

export function hasExecutionPlanConflict(
	checkpoint: Pick<ExecutionCheckpoint, "statusDetail" | "escalation">,
): boolean {
	const reason = checkpoint.escalation?.reason.toLowerCase() ?? "";
	return (
		checkpoint.statusDetail === "repair-plan-issue" ||
		reason.includes("approved-plan conflict") ||
		reason.includes("reported plan issues") ||
		reason.includes("reports approved-plan issues")
	);
}

// Same-stage writes record in-flight/status detail; Review may start the next phase.
const transitions: Record<ExecutionStage, readonly ExecutionStage[]> = {
	Prepare: ["Prepare", "Implement", "Escalated"],
	Implement: ["Implement", "Check", "Escalated"],
	Check: ["Check", "Review", "Repair", "Escalated"],
	Review: [
		"Review",
		"Implement",
		"Repair",
		"Finalize",
		"Completed",
		"Escalated",
	],
	Repair: ["Repair", "Check", "Escalated"],
	Finalize: ["Finalize", "Check", "Completed", "Repair", "Escalated"],
	Escalated: [
		"Escalated",
		"Prepare",
		"Implement",
		"Check",
		"Review",
		"Repair",
		"Finalize",
	],
	Completed: [],
};

export function assertExecutionTransition(
	from: ExecutionStage,
	to: ExecutionStage,
): void {
	if (!transitions[from].includes(to))
		throw new Error(`illegal execution transition ${from} -> ${to}`);
}

/** Rejects a write that is not based on the checkpoint the writer saw. */
export function applyExecutionCheckpoint(
	current: ExecutionCheckpoint,
	expectedRevision: number,
	next: ExecutionCheckpoint,
): ExecutionCheckpoint {
	if (current.revision !== expectedRevision)
		throw new Error(
			`stale execution checkpoint revision ${expectedRevision}; current is ${current.revision}`,
		);
	const parsed = ExecutionCheckpoint.parse(next);
	if (parsed.revision !== expectedRevision + 1)
		throw new Error("execution checkpoint revision must advance by one");
	if (parsed.phaseIndex < current.phaseIndex)
		throw new Error("execution checkpoint phase index cannot regress");
	if (parsed.phaseIndex > current.phaseIndex + 1)
		throw new Error("execution checkpoint cannot skip a phase");
	if (
		parsed.phaseIndex > current.phaseIndex &&
		parsed.receipts.length !== current.receipts.length + 1
	)
		throw new Error("phase advance requires exactly one new receipt");
	if (parsed.receipts.length < current.receipts.length)
		throw new Error("execution checkpoint receipts cannot be removed");
	for (const [index, receipt] of current.receipts.entries())
		if (parsed.receipts[index]?.sha256 !== receipt.sha256)
			throw new Error(`execution checkpoint receipt ${index} changed`);
	assertExecutionTransition(current.stage, parsed.stage);
	return parsed;
}

export function initialExecutionCheckpoint(): ExecutionCheckpoint {
	return {
		revision: 0,
		stage: "Prepare",
		phaseIndex: 0,
		scope: "phase",
		cycle: 1,
		round: 0,
		manifest: null,
		workspace: null,
		evidence: { diff: null, checks: null, review: null },
		commitIntent: null,
		acceptedFindingIds: [],
		pendingFindingIds: [],
		unresolvedFindingIds: [],
		receipts: [],
		inFlight: null,
		escalation: null,
		statusDetail: null,
	};
}

/** Structural checks that must pass before a writer sees the manifest. */
export function validateExecutionManifest(
	manifest: ExecutionManifest,
	markdown: string,
	expectedPr?: { id: string; title: string; phases: readonly string[] },
): ExecutionManifest {
	if (expectedPr && manifest.phases.length !== expectedPr.phases.length)
		throw new Error(
			"execution manifest phase count does not match PR strategy",
		);
	const parsed = ExecutionManifest.parse(manifest);
	if (parsed.issues.length > 0)
		throw new Error(`execution manifest issues: ${parsed.issues.join("; ")}`);
	if (expectedPr) {
		if (parsed.pr.id !== expectedPr.id || parsed.pr.title !== expectedPr.title)
			throw new Error("execution manifest does not identify the selected PR");
	}
	for (const [index, phase] of parsed.phases.entries()) {
		if (phase.id !== `phase-${index + 1}`)
			throw new Error(
				`phase ${index} must have deterministic id phase-${index + 1}`,
			);
		if (!markdown.includes(phase.planExcerpt))
			throw new Error(`phase ${phase.id} excerpt is not in the approved plan`);
		if (
			expectedPr &&
			!phase.planExcerpt.includes(expectedPr.phases[index] ?? "")
		)
			throw new Error(
				`phase ${phase.id} excerpt does not map to its strategy phase`,
			);
		if (phase.acceptanceCriteria.length === 0)
			throw new Error(`phase ${phase.id} has no acceptance criteria`);
		for (const criterion of phase.acceptanceCriteria)
			if (!markdown.includes(criterion))
				throw new Error(
					`phase ${phase.id} acceptance criterion is not in the approved plan`,
				);
	}
	for (const prerequisite of parsed.prerequisites)
		if (prerequisite.ref === undefined && prerequisite.paths === undefined)
			throw new Error(
				`prerequisite "${prerequisite.description}" requires ref or paths`,
			);
	return parsed;
}

/** The engine owns accepted IDs; a repair cannot invent or repeat them. */
export interface ImplementationReviewDecision {
	decision: "Repair" | "Accepted" | "Escalated";
	blockerIds: string[];
	reason: string | null;
}

/** Fail-closed implementation policy: every in-scope blocker, including P2, is repairable. */
export function decideImplementationReview(
	findings: Finding[],
	verified: VerifiedOutput,
	unchecked: string[],
	round: number,
	planIssues: string[] = [],
): ImplementationReviewDecision {
	const escalate = (
		reason: string,
		blockerIds: string[] = [],
	): ImplementationReviewDecision => ({
		decision: "Escalated",
		blockerIds,
		reason,
	});
	if (planIssues.length > 0)
		return escalate(`approved-plan conflict: ${planIssues.join("; ")}`);
	if (unchecked.length > 0)
		return escalate(
			`unchecked implementation review lenses: ${unchecked.join(", ")}`,
		);

	const ids = new Set(findings.map((finding) => finding.id));
	if (ids.size !== findings.length)
		return escalate(
			"duplicate finding IDs across implementation review lenses",
		);
	const covered = new Set<string>();
	for (const verdict of verified.verdicts) {
		if (
			verdict.classification === "INVALID" &&
			!verdict.counterEvidence?.trim()
		)
			return escalate("INVALID verdict requires counter-evidence");
		for (const id of verdict.sourceIds) {
			if (!ids.has(id))
				return escalate(`unknown finding ID ${id} in verifier output`);
			if (covered.has(id))
				return escalate(`duplicate verdict for finding ${id}`);
			covered.add(id);
		}
	}
	for (const id of ids)
		if (!covered.has(id))
			return escalate(`missing verifier verdict for finding ${id}`);

	const blockerIds = verified.verdicts
		.filter((verdict) => verdict.classification === "BLOCKER")
		.flatMap((verdict) => verdict.sourceIds);
	if (blockerIds.length === 0)
		return { decision: "Accepted", blockerIds: [], reason: null };
	if (round >= MAX_VALIDATION_CYCLES)
		return escalate(
			`implementation repair budget exhausted with blockers: ${blockerIds.join(", ")}`,
			blockerIds,
		);
	return { decision: "Repair", blockerIds, reason: null };
}

export function accountRepair(
	expectedFindingIds: readonly string[],
	output: RepairOutput,
): { addressed: string[]; unresolved: string[] } {
	const expected = new Set(expectedFindingIds);
	if (expected.size !== expectedFindingIds.length)
		throw new Error("duplicate accepted finding id");
	const seen = new Set<string>();
	for (const id of [
		...output.addressedFindingIds,
		...output.unresolvedFindingIds,
	]) {
		if (seen.has(id)) throw new Error(`duplicate repair finding id ${id}`);
		if (!expected.has(id)) throw new Error(`unknown repair finding id ${id}`);
		seen.add(id);
	}
	for (const id of expected)
		if (!seen.has(id)) throw new Error(`missing repair finding id ${id}`);
	return {
		addressed: [...output.addressedFindingIds],
		unresolved: [...output.unresolvedFindingIds],
	};
}

export function sourceEligibility(state: {
	status: string;
	outcome: string | null;
	config: { factory?: unknown };
}): "unapproved" | "not_planning" | null {
	if (state.status !== "ended" || state.outcome !== "approved")
		return "unapproved";
	return FactoryRunConfig.safeParse(state.config.factory).success
		? null
		: "not_planning";
}

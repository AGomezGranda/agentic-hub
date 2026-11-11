import type {
	FactoryCheckpoint,
	Finding,
	VerifiedOutput,
} from "@payo/contracts";
import type { RunState } from "@payo/kernel";
import { CommandError } from "../errors.ts";
import { resolveImplementation } from "./phase-outline.ts";

export function decideReview(
	findings: Finding[],
	verified: VerifiedOutput,
	unchecked: string[],
	round: number,
): "Approval" | "Revise" | "Escalated" {
	const remaining = new Set(findings.map((finding) => finding.id));
	if (remaining.size !== findings.length)
		throw new Error("duplicate finding id");
	for (const verdict of verified.verdicts) {
		if (
			verdict.classification === "INVALID" &&
			!verdict.counterEvidence?.trim()
		)
			throw new Error("INVALID verdict requires counter-evidence");
		for (const id of verdict.sourceIds)
			if (!remaining.delete(id))
				throw new Error(`unknown or duplicate finding id ${id}`);
	}
	if (remaining.size) throw new Error("missing verdicts");
	if (unchecked.length) return "Escalated";
	const blocking = verified.verdicts.some(
		(v) =>
			v.classification === "BLOCKER" &&
			(v.severity === "P0" || v.severity === "P1"),
	);
	return blocking ? (round >= 3 ? "Escalated" : "Revise") : "Approval";
}

export function approvalGate(state: RunState) {
	const gates = [...state.gates.values()].filter(
		(gate) => gate.status === "open",
	);
	const gate = gates.find((item) => item.kind === "approval");
	if (!gate || gates.length !== 1)
		throw new CommandError(
			"conflict",
			"approval gate unavailable or unrelated open gate",
		);
	return gate;
}

export function assertApprovalStage(stage: FactoryCheckpoint["stage"]): void {
	if (stage !== "Approval")
		throw new CommandError("conflict", "run is not awaiting approval");
}

export function assertPlanApprovable(
	state: Pick<RunState, "steps" | "attempts">,
	gateStepId: string,
	plan: import("@payo/contracts").PlanOutput,
	answers: Record<string, string>,
	markdown: string,
): void {
	if (
		[...state.steps.values()].some(
			(step) => step.status === "running" && step.stepId !== gateStepId,
		) ||
		[...state.attempts.values()].some((attempt) => attempt.status === "running")
	)
		throw new CommandError("conflict", "run has unrelated running work");
	if (plan.openQuestions.some((q) => !answers[q.id]?.trim()))
		throw new CommandError("conflict", "unanswered questions");
	const issues = resolveImplementation(markdown, plan.prStrategy).flatMap(
		(pr) => pr.issues.map((issue) => `${pr.id}: ${issue}`),
	);
	if (issues.length) throw new CommandError("conflict", issues.join("\n"));
}

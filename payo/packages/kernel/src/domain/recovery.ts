import type { RunEventBody } from "@payo/contracts";
import type { RunState } from "./state.ts";
import { incompleteUsage, UNKNOWN_USAGE } from "./usage.ts";

/**
 * Startup only: a running attempt after a restart was interrupted, and a running step with no running attempt
 * and no open gate (the window between attempts) gets a gate. Returns [] once nothing is left to gate.
 */
export function recover(state: RunState): RunEventBody[] {
	const bodies: RunEventBody[] = [];
	for (const attempt of state.attempts.values()) {
		if (attempt.status !== "running") continue;
		bodies.push({
			type: "attempt.finished",
			attemptId: attempt.attemptId,
			outcome: "interrupted",
			// Keep observed spend; recovery cannot claim the attempt was fully observed.
			usage:
				attempt.usage === null ? UNKNOWN_USAGE : incompleteUsage(attempt.usage),
		});
		bodies.push({
			type: "gate.raised",
			gateId: `interrupted:${attempt.attemptId}`,
			stepId: attempt.stepId,
			kind: "interrupted-attempt",
			allowedCommands: ["retry", "abandon"],
			reason: "attempt was running when the process stopped",
		});
	}
	for (const step of state.steps.values()) {
		if (step.status !== "running") continue;
		const busy = [...state.attempts.values()].some(
			(a) => a.stepId === step.stepId && a.status === "running",
		);
		const gated = [...state.gates.values()].some(
			(g) => g.stepId === step.stepId && g.status === "open",
		);
		if (busy || gated) continue;
		// The seq suffix keeps the id unique if a resolved gate is followed by another crash in the same window.
		bodies.push({
			type: "gate.raised",
			gateId: `interrupted-step:${step.stepId}:${state.lastSeq}`,
			stepId: step.stepId,
			kind: "interrupted-step",
			allowedCommands: ["retry", "abandon"],
			reason: "step had no running attempt when the process stopped",
		});
	}
	return bodies;
}

import {
	type ExecutionCheckpoint,
	type ExecutionRunConfig,
	ExecutionRunConfig as ExecutionRunConfigSchema,
	type ExecutionStage,
	type RunEventBody,
} from "@payo/contracts";
import type { RunState } from "@payo/kernel";
import { applyExecutionCheckpoint } from "../domain/execution.ts";
import { CommandError } from "../errors.ts";
import { storeExecutionCheckpoint } from "../execution-artifacts.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";

export const busy = () => new CommandError("busy", "execution command busy");

export const conflict = (message: string) =>
	new CommandError("conflict", message);

export const invalid = (message: string) =>
	new CommandError("invalid_request", message);

export async function checkpoint(
	handle: MutableExecutionHandle,
	update: Partial<ExecutionCheckpoint>,
	events: RunEventBody[] = [],
): Promise<void> {
	const current = handle.checkpoint;
	const next = applyExecutionCheckpoint(current, current.revision, {
		...current,
		...update,
		revision: current.revision + 1,
	});
	await handle.log.write([
		...events,
		await storeExecutionCheckpoint(handle.deps.store, next),
	]);
	handle.checkpoint = next;
}

export function openGateSteps(handle: MutableExecutionHandle): string[] {
	return [
		...new Set(
			[...handle.log.current().gates.values()]
				.filter((gate) => gate.status === "open")
				.map((gate) => gate.stepId),
		),
	];
}

export function runConfig(state: RunState): ExecutionRunConfig {
	return ExecutionRunConfigSchema.parse(state.config.factory);
}

export async function raiseExecutionGate(
	state: MutableExecutionHandle,
	operation: ExecutionStage,
	reason: string,
	ownedStepIds: readonly string[],
	statusDetail: string,
): Promise<void> {
	return raiseExecutionGateWithEvidence(
		state,
		operation,
		reason,
		ownedStepIds,
		statusDetail,
		{},
	);
}

// The kernel reports an operator cancel as a failed step, so callers check the signal before a report gate.

export async function raiseCancelledGate(
	state: MutableExecutionHandle,
	operation: ExecutionStage,
	ownedStepIds: readonly string[],
): Promise<void> {
	await raiseExecutionGate(
		state,
		operation,
		`execution cancelled during ${operation}; inspect the retained workspace and resume`,
		ownedStepIds,
		"execution-cancelled",
	);
}

export async function raiseExecutionGateWithEvidence(
	state: MutableExecutionHandle,
	operation: ExecutionStage,
	reason: string,
	ownedStepIds: readonly string[],
	statusDetail: string,
	evidence: Partial<ExecutionCheckpoint["evidence"]>,
): Promise<void> {
	const gateStepId = state.deps.newId();
	const stepIds = [...new Set([...ownedStepIds, gateStepId])];
	await checkpoint(
		state,
		{
			stage: "Escalated",
			inFlight: { operation, stepIds },
			escalation: { reason },
			statusDetail,
			evidence: { ...state.checkpoint.evidence, ...evidence },
		},
		[
			{
				type: "step.started",
				stepId: gateStepId,
				name: "execution escalation",
			},
			{
				type: "gate.raised",
				gateId: `execution:${gateStepId}`,
				stepId: gateStepId,
				kind: "execution-escalation",
				allowedCommands: ["resume"],
				reason,
			},
			{ type: "step.finished", stepId: gateStepId, outcome: "escalated" },
		],
	);
}

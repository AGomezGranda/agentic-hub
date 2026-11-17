import type { ExecutionStage, ResumeRequest } from "@payo/contracts";
import {
	type ExecutionHandle,
	type MutableExecutionHandle,
	mutableExecutionHandle,
} from "../execution-handle.ts";
import { readExecutionSummary as projectExecutionSummary } from "../execution-read-model.ts";
import { busy, conflict, raiseExecutionGate, runConfig } from "./checkpoint.ts";
import { reconcileCommitIntent } from "./commit.ts";
import { implementPhase } from "./implement.ts";
import { prepareManifest, prepareWorkspace } from "./prepare.ts";
import { prepareExecutionResume } from "./resume.ts";
import { validatePhase } from "./validation.ts";
import { describeError, requireExecutionPorts } from "./workspace.ts";

const VALIDATION_STAGES: readonly ExecutionStage[] = [
	"Check",
	"Review",
	"Repair",
	"Finalize",
];

/** Executes the preparation, one writer, and engine-owned checks, stopping at the review gate. */
export async function executeExecution(
	handle: ExecutionHandle,
	input: { signal: AbortSignal },
): Promise<ExecutionHandle> {
	const state = mutableExecutionHandle(handle);
	if (state.busy) throw busy();
	if (state.checkpoint.stage === "Completed")
		throw conflict("execution has completed");
	if (state.checkpoint.stage === "Escalated")
		throw conflict("execution is escalated; resume before executing");
	state.busy = true;
	try {
		await runOrGate(state, input.signal);
		return handle;
	} finally {
		state.busy = false;
	}
}

async function runOrGate(
	state: MutableExecutionHandle,
	signal: AbortSignal,
): Promise<void> {
	try {
		await runExecution(state, signal);
	} catch (error) {
		if (signal.aborted) throw error;
		const failedStage = state.checkpoint.stage as ExecutionStage;
		if (failedStage !== "Escalated")
			await raiseExecutionGate(
				state,
				failedStage,
				`execution failed safely: ${describeError(error)}`,
				state.checkpoint.inFlight?.stepIds ?? [],
				"execution-failed",
			);
	}
}

async function runExecution(
	state: MutableExecutionHandle,
	signal: AbortSignal,
): Promise<void> {
	const deps = requireExecutionPorts(state.deps);
	if (signal.aborted) throw new Error("execution cancelled");
	let config = runConfig(state.log.current());
	if (state.checkpoint.commitIntent) {
		await reconcileCommitIntent(state, deps.workspace, signal);
		if (state.checkpoint.stage === "Escalated") return;
		config = runConfig(state.log.current());
	}
	if (state.checkpoint.stage === "Prepare") {
		const prepared = await prepareWorkspace(
			state,
			config,
			deps.workspace,
			signal,
		);
		if (!prepared) return;
		config = runConfig(state.log.current());
		if (!state.checkpoint.manifest) {
			const manifestReady = await prepareManifest(state, config, deps, signal);
			if (!manifestReady) return;
		}
	}

	while (!signal.aborted) {
		if (state.checkpoint.stage === "Implement") {
			if (!(await implementPhase(state, config, deps, signal))) return;
			continue;
		}
		if (VALIDATION_STAGES.includes(state.checkpoint.stage)) {
			await validatePhase(state, config, deps, signal);
			if (state.checkpoint.stage === "Escalated") return;
			if (state.checkpoint.stage === "Completed") return;
			continue;
		}
		return;
	}
}

/** Resume inspects retained work, starts a fresh reconciliation context, and reruns checks. */
export async function resumeExecution(
	handle: ExecutionHandle,
	input: { signal: AbortSignal } & ResumeRequest,
): Promise<ExecutionHandle> {
	await prepareExecutionResume(handle, input);
	return executeExecution(handle, input);
}

export async function readExecutionSummary(
	handle: ExecutionHandle,
): Promise<import("@payo/contracts").ExecutionSummary> {
	return projectExecutionSummary(handle);
}

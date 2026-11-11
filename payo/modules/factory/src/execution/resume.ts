import { resolve } from "node:path";
import { ResumeRequest, type RunEventBody } from "@payo/contracts";
import type { ExecutionWorkspace } from "@payo/kernel";
import {
	executionResumeConflict,
	executionResumeStage,
} from "../domain/execution.ts";
import { expectedExecutionBranch } from "../domain/execution-naming.ts";
import {
	type ExecutionHandle,
	mutableExecutionHandle,
} from "../execution-handle.ts";

import { readExecutionSummary } from "../execution-read-model.ts";
import {
	busy,
	checkpoint,
	conflict,
	invalid,
	runConfig,
} from "./checkpoint.ts";
import {
	describeError,
	makeWorkspaceIdentity,
	requireDataDir,
	requireExecutionPorts,
} from "./workspace.ts";

/** Engine gates and then proceeds only after explicit resume reconciliation. */
export function assertExecutionResumable(handle: ExecutionHandle): void {
	const state = mutableExecutionHandle(handle);
	if (state.busy) throw busy();
	const reason = executionResumeConflict(
		state.checkpoint,
		state.log.current().gates.values(),
	);
	if (reason) throw conflict(reason);
}

/** Validate retained work and durably clear the gate before scheduling agents. */
export async function prepareExecutionResume(
	handle: ExecutionHandle,
	input: { signal: AbortSignal } & ResumeRequest,
): Promise<ExecutionHandle> {
	assertExecutionResumable(handle);
	const state = mutableExecutionHandle(handle);
	state.busy = true;
	try {
		const { signal: _signal, ...body } = input;
		const request = ResumeRequest.safeParse(body);
		if (!request.success) throw invalid("invalid resume request");
		const answers = request.data.answers ?? [];
		if (request.data.gateId !== undefined) {
			const gate = state.log.current().gates.get(request.data.gateId);
			if (
				gate?.status !== "open" ||
				!gate.allowedCommands.includes("resume") ||
				!state.checkpoint.inFlight?.stepIds.includes(gate.stepId)
			)
				throw conflict(
					"The execution pause changed. Refresh before answering.",
				);
			const summary = await readExecutionSummary(handle);
			if (answers.some(({ issue }) => !summary.planIssues?.includes(issue)))
				throw conflict(
					"The reported issues changed. Refresh before answering.",
				);
		}
		const config = runConfig(state.log.current());
		const marker = state.checkpoint.inFlight;
		if (!marker) throw conflict("execution is not resumable");
		const deps = requireExecutionPorts(state.deps);
		let workspace = state.checkpoint.workspace;
		if (workspace) {
			const expectedPath = resolve(
				requireDataDir(state.deps),
				"worktrees",
				state.log.current().runId,
			);
			if (
				resolve(workspace.path) !== expectedPath ||
				workspace.baseCommit !== config.baseCommit
			)
				throw conflict(
					"execution workspace path or pinned base identity changed; it remains gated",
				);
			let snapshot: Awaited<ReturnType<ExecutionWorkspace["inspect"]>>;
			try {
				snapshot = await deps.workspace.inspect(workspace.path, input.signal);
			} catch (error) {
				if (input.signal.aborted) throw error;
				throw conflict(
					`execution workspace is unavailable; edits were retained: ${describeError(error)}`,
				);
			}
			if (
				snapshot.branch !==
				expectedExecutionBranch(
					config,
					state.checkpoint,
					state.log.current().runId,
				)
			)
				throw conflict("execution branch changed; it remains gated");
			if (
				!state.checkpoint.commitIntent &&
				snapshot.head !== (workspace.head ?? config.baseCommit)
			)
				throw conflict(
					"Cannot resume: the workspace HEAD changed since the saved checkpoint. Inspect the retained worktree before retrying; execution remains paused.",
				);
			// Explicit resume refreshes repository-wide history; other branches may change while paused.
			workspace = makeWorkspaceIdentity(
				workspace.path,
				snapshot,
				config.baseCommit,
			);
		}
		const resumeStage = executionResumeStage(state.checkpoint);
		const events: RunEventBody[] = [];
		const owned = new Set(marker.stepIds);
		for (const gate of state.log.current().gates.values()) {
			if (gate.status !== "open" || !owned.has(gate.stepId)) continue;
			events.push({
				type: "gate.resolved",
				gateId: gate.gateId,
				command: gate.allowedCommands.includes("resume") ? "resume" : "retry",
				note: "operator resumed execution with retained workspace",
			});
		}
		for (const stepId of owned)
			if (state.log.current().steps.get(stepId)?.status === "running")
				events.push({ type: "step.finished", stepId, outcome: "failed" });
		await checkpoint(
			state,
			{
				stage: resumeStage,
				issueAnswers: [...(state.checkpoint.issueAnswers ?? []), ...answers],
				implementationFeedback:
					resumeStage === "Implement"
						? (state.checkpoint.escalation?.reason ??
							state.checkpoint.implementationFeedback)
						: null,
				workspace,
				cycle: state.checkpoint.cycle + 1,
				round: state.checkpoint.commitIntent ? state.checkpoint.round : 0,
				inFlight: null,
				escalation: null,
				statusDetail: state.checkpoint.commitIntent
					? "commit-reconciliation-required"
					: state.checkpoint.manifest
						? "reconciliation-required"
						: null,
			},
			events,
		);
		return handle;
	} finally {
		state.busy = false;
	}
}

import { join } from "node:path";
import {
	type ExecutionManifest,
	ExecutionManifest as ExecutionManifestSchema,
	type ExecutionRunConfig,
	jsonEnvelope,
} from "@payo/contracts";
import { type ExecutionWorkspace, runAgentStep } from "@payo/kernel";
import { validateExecutionManifest } from "../domain/execution.ts";
import { expectedExecutionBranch } from "../domain/execution-naming.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";
import { executionPreparerSpec } from "../execution-roles.ts";
import {
	putJsonArtifact,
	readApprovedVersion,
	storeJsonArtifact,
} from "./artifacts.ts";
import {
	checkpoint,
	raiseCancelledGate,
	raiseExecutionGate,
} from "./checkpoint.ts";
import { selectedPr } from "./lifecycle.ts";
import {
	assertKnownWorkspace,
	describeError,
	makeWorkspaceIdentity,
	requireDataDir,
	type requireExecutionPorts,
} from "./workspace.ts";

export async function prepareWorkspace(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	signal: AbortSignal,
): Promise<boolean> {
	if (state.checkpoint.workspace) return true;
	const run = state.log.current();
	const stepId = state.deps.newId();
	await checkpoint(
		state,
		{
			stage: "Prepare",
			inFlight: { operation: "Prepare", stepIds: [stepId] },
			statusDetail: "preparing-workspace",
		},
		[{ type: "step.started", stepId, name: "prepare execution workspace" }],
	);
	try {
		const worktreeRoot = join(requireDataDir(state.deps), "worktrees");
		const prepared = await workspace.prepare(
			{
				executionId: run.runId,
				repo: run.repo,
				worktreeRoot,
				branch: expectedExecutionBranch(config, state.checkpoint, run.runId),
				baseCommit: config.baseCommit,
			},
			signal,
		);
		const snapshot = await workspace.inspect(prepared.path, signal);
		assertKnownWorkspace(
			snapshot,
			config.baseCommit,
			expectedExecutionBranch(config, state.checkpoint, run.runId),
		);
		const instructions = await workspace.instructions(
			run.repo,
			config.baseCommit,
			signal,
		);
		const instructionRef = await storeJsonArtifact(
			state,
			instructions,
			"factory-execution-repository-instructions-v1",
		);
		await checkpoint(
			state,
			{
				workspace: makeWorkspaceIdentity(
					prepared.path,
					snapshot,
					config.baseCommit,
				),
				inFlight: null,
				statusDetail: null,
			},
			[
				{
					type: "artifact.recorded",
					artifact: instructionRef,
					attemptId: null,
				},
				{ type: "step.finished", stepId, outcome: "succeeded" },
			],
		);
		return true;
	} catch (error) {
		if (signal.aborted) throw error;
		await raiseExecutionGate(
			state,
			"Prepare",
			`workspace preparation failed: ${describeError(error)}`,
			[stepId],
			"workspace-preparation-failed",
		);
		return false;
	}
}

export async function prepareManifest(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	deps: ReturnType<typeof requireExecutionPorts>,
	signal: AbortSignal,
): Promise<boolean> {
	const approved = await readApprovedVersion(state.deps.store, config.plan);
	let pr: ReturnType<typeof selectedPr>;
	try {
		pr = selectedPr(approved.plan, config.prId);
	} catch (error) {
		await raiseExecutionGate(
			state,
			"Prepare",
			describeError(error),
			[],
			"manifest-invalid",
		);
		return false;
	}
	const settings = config.roles.preparer;
	const roleRef = config.roleArtifacts.preparer;
	if (!settings || !roleRef)
		throw new Error("execution preparer role snapshot is missing");
	const stepId = state.deps.newId();
	await checkpoint(state, {
		stage: "Prepare",
		inFlight: { operation: "Prepare", stepIds: [stepId] },
		statusDetail: "preparing-manifest",
	});
	const result = await runAgentStep(
		{
			scheduler: state.deps.scheduler,
			createRawLog: state.deps.createRawLog,
			store: state.deps.store,
			log: state.log,
			limiter: deps.limiter,
		},
		{
			stepId,
			stepName: "prepare approved execution manifest",
			attemptIds: [state.deps.newId(), state.deps.newId()],
			runner: deps.runner,
			spec: await executionPreparerSpec(
				state.deps.store,
				roleRef,
				config.plan,
				pr,
				{ ...settings, issueAnswers: state.checkpoint.issueAnswers },
				state.log.current().repo,
			),
			validate: jsonEnvelope(ExecutionManifestSchema),
			signal,
		},
	);
	if (result.outcome !== "succeeded") {
		if (signal.aborted) await raiseCancelledGate(state, "Prepare", [stepId]);
		else
			await raiseExecutionGate(
				state,
				"Prepare",
				"approved plan preparation failed; no writer was started",
				[stepId],
				"manifest-preparation-failed",
			);
		return false;
	}
	let manifest: ExecutionManifest;
	try {
		manifest = validateExecutionManifest(
			ExecutionManifestSchema.parse(result.value),
			approved.plan.markdown,
			pr,
		);
	} catch (error) {
		await raiseExecutionGate(
			state,
			"Prepare",
			`approved plan cannot be executed safely: ${describeError(error)}`,
			[stepId],
			"manifest-invalid",
		);
		return false;
	}
	manifest.phases.forEach((phase, index) => {
		phase.title = pr.phases[index] ?? phase.title;
	});
	// Outside the try: abort errors propagate to the caller, while infrastructure errors are not plan defects and reach the resumable execution-failed gate.
	const results = await deps.workspace.verifyPrerequisites(
		state.log.current().repo,
		config.baseCommit,
		manifest.prerequisites,
		signal,
	);
	const missing = results.filter((item) => !item.present);
	if (missing.length > 0) {
		await raiseExecutionGate(
			state,
			"Prepare",
			`approved plan cannot be executed safely: unavailable prerequisites: ${missing.map((item) => `${item.description} (${item.reason})`).join("; ")}`,
			[stepId],
			"manifest-invalid",
		);
		return false;
	}
	const ref = await putJsonArtifact(
		state.deps.store,
		manifest,
		"factory-execution-manifest-v1",
	);
	await checkpoint(
		state,
		{
			stage: "Implement",
			manifest: ref,
			workspace: state.checkpoint.workspace,
			inFlight: null,
			escalation: null,
			statusDetail: null,
		},
		[{ type: "artifact.recorded", artifact: ref, attemptId: null }],
	);
	return true;
}

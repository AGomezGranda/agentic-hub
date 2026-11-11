import {
	type ArtifactRef,
	ExecutionManifest as ExecutionManifestSchema,
	type ExecutionRunConfig,
	ImplementationOutput as ImplementationOutputSchema,
	jsonEnvelope,
} from "@payo/contracts";
import { runAgentStep } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import { expectedExecutionBranch } from "../domain/execution-naming.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";
import { executionImplementerSpec } from "../execution-roles.ts";
import {
	findArtifactRef,
	phaseStartCommit,
	putJsonArtifact,
	readPhaseReceipts,
	storeJsonArtifact,
	storeTextArtifact,
} from "./artifacts.ts";
import {
	checkpoint,
	raiseCancelledGate,
	raiseExecutionGate,
} from "./checkpoint.ts";
import {
	assertKnownWorkspace,
	captureDiffOrGate,
	makeWorkspaceIdentity,
	type requireExecutionPorts,
} from "./workspace.ts";

export async function implementPhase(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	deps: ReturnType<typeof requireExecutionPorts>,
	signal: AbortSignal,
): Promise<boolean> {
	const manifestRef = state.checkpoint.manifest;
	const workspaceIdentity = state.checkpoint.workspace;
	if (!manifestRef || !workspaceIdentity)
		throw new Error("execution is missing its manifest or workspace");
	const manifest = ExecutionManifestSchema.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(state.deps.store, manifestRef),
			),
		),
	);
	const phaseIndex = state.checkpoint.phaseIndex;
	const phase = manifest.phases[phaseIndex];
	if (!phase)
		throw new Error(`phase ${phaseIndex} is absent from the manifest`);
	const phaseStart = await phaseStartCommit(state, config);
	const current = await deps.workspace.inspect(workspaceIdentity.path, signal);
	assertKnownWorkspace(
		current,
		config.baseCommit,
		expectedExecutionBranch(
			config,
			state.checkpoint,
			state.log.current().runId,
		),
		phaseStart,
	);
	const feedback = state.checkpoint.implementationFeedback;
	const recovery =
		!!feedback || state.checkpoint.statusDetail === "reconciliation-required";
	let partialDiff: ArtifactRef | undefined;
	if (recovery && current.changedPaths.length > 0) {
		const diff = await captureDiffOrGate(
			state,
			deps.workspace,
			workspaceIdentity.path,
			phaseStart,
			signal,
			"Implement",
			[],
		);
		if (diff === null) return false;
		partialDiff = await storeTextArtifact(
			state,
			diff,
			"factory-execution-partial-diff-v1",
		);
	}
	const instructionsRef = findArtifactRef(
		state.log.current(),
		"factory-execution-repository-instructions-v1",
	);
	if (!instructionsRef)
		throw new Error("repository instruction snapshot is missing");
	const phaseInputRef = await putJsonArtifact(
		state.deps.store,
		{
			pr: manifest.pr,
			phase,
			phaseIndex,
			issueAnswers: state.checkpoint.issueAnswers ?? [],
			...(feedback ? { previousFailure: feedback } : {}),
			workspace: workspaceIdentity,
			receipts: await readPhaseReceipts(state),
		},
		"factory-execution-phase-input-v1",
	);
	const roleRef = config.roleArtifacts.implementer;
	const settings = config.roles.implementer;
	if (!roleRef || !settings)
		throw new Error("execution implementer role snapshot is missing");
	const stepId = state.deps.newId();
	await checkpoint(state, {
		stage: "Implement",
		workspace: makeWorkspaceIdentity(
			workspaceIdentity.path,
			current,
			config.baseCommit,
		),
		inFlight: { operation: "Implement", stepIds: [stepId] },
		statusDetail: recovery ? "reconciliation-required" : "implementing-phase",
	});
	const result = await runAgentStep(
		{ store: state.deps.store, log: state.log, limiter: deps.limiter },
		{
			stepId,
			stepName: feedback
				? `resolve reported issues in ${phase.id}`
				: recovery
					? "reconcile interrupted phase implementation"
					: `implement ${phase.id}`,
			attemptIds: [state.deps.newId(), state.deps.newId()],
			runner: deps.runner,
			spec: await executionImplementerSpec(state.deps.store, roleRef, {
				plan: config.plan,
				phase: phaseInputRef,
				repositoryInstructions: instructionsRef,
				cwd: workspaceIdentity.path,
				model: settings.model,
				timeoutMs: settings.timeoutMs,
				workspace: {
					path: workspaceIdentity.path,
					branch: workspaceIdentity.branch,
					baseCommit: config.baseCommit,
				},
				...(partialDiff ? { diff: partialDiff } : {}),
			}),
			validate: jsonEnvelope(ImplementationOutputSchema),
			signal,
		},
	);
	if (result.outcome !== "succeeded") {
		const failureReason = state.log
			.current()
			.gates.get(`escalation:${stepId}`)?.reason;
		if (signal.aborted) await raiseCancelledGate(state, "Implement", [stepId]);
		else
			await raiseExecutionGate(
				state,
				"Implement",
				result.outcome === "failed" && failureReason
					? `implementation failed: ${failureReason}; edits are preserved for reconciliation`
					: "implementation report could not be validated; edits are preserved for reconciliation",
				[stepId],
				"implementation-report-invalid",
			);
		return false;
	}
	const after = await deps.workspace.inspect(workspaceIdentity.path, signal);
	if (
		after.head !== current.head ||
		after.branch !== current.branch ||
		after.historyFingerprint !== current.historyFingerprint
	) {
		await raiseExecutionGate(
			state,
			"Implement",
			"writer changed HEAD, branch, refs, or reflog; unexpected Git history is preserved",
			[stepId],
			"unexpected-git-history",
		);
		return false;
	}
	const output = ImplementationOutputSchema.parse(result.value);
	const missingCriteria = phase.acceptanceCriteria.filter(
		(criterion) => !output.completedCriteria.includes(criterion),
	);
	if (output.planIssues.length > 0 || missingCriteria.length > 0) {
		await storeJsonArtifact(
			state,
			output,
			"factory-execution-implementation-report-v1",
		);
		const issues = [];
		if (output.planIssues.length)
			issues.push(
				`implementer reported plan issues: ${output.planIssues.join("; ")}`,
			);
		if (missingCriteria.length)
			issues.push(
				`implementation did not report all acceptance criteria: ${missingCriteria.join("; ")}`,
			);
		const problems = issues.join("\n");
		if (!feedback) {
			await checkpoint(state, {
				implementationFeedback: problems,
				workspace: makeWorkspaceIdentity(
					workspaceIdentity.path,
					after,
					config.baseCommit,
				),
				inFlight: null,
				statusDetail: "reconciling-implementation-report",
			});
			return true;
		}
		await raiseExecutionGate(
			state,
			"Implement",
			problems,
			[stepId],
			"implementation-report-incomplete",
		);
		return false;
	}
	const diff = await captureDiffOrGate(
		state,
		deps.workspace,
		workspaceIdentity.path,
		phaseStart,
		signal,
		"Implement",
		[stepId],
	);
	if (diff === null) return false;
	const reportRef = await putJsonArtifact(
		state.deps.store,
		output,
		"factory-execution-implementation-report-v1",
	);
	const diffRef = await storeTextArtifact(
		state,
		diff,
		"factory-execution-diff-v1",
	);
	const afterDiff = await deps.workspace.inspect(
		workspaceIdentity.path,
		signal,
	);
	if (afterDiff.fingerprint !== after.fingerprint) {
		await raiseExecutionGate(
			state,
			"Implement",
			"workspace changed while capturing the implementation diff",
			[stepId],
			"workspace-mutated-after-writer",
		);
		return false;
	}
	await checkpoint(
		state,
		{
			stage: "Check",
			implementationFeedback: null,
			workspace: makeWorkspaceIdentity(
				workspaceIdentity.path,
				afterDiff,
				config.baseCommit,
			),
			evidence: { diff: diffRef, checks: null, review: null },
			inFlight: null,
			statusDetail: null,
		},
		[
			{ type: "artifact.recorded", artifact: reportRef, attemptId: null },
			{ type: "artifact.recorded", artifact: diffRef, attemptId: null },
		],
	);
	return true;
}

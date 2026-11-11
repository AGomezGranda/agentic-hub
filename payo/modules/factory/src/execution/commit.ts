import {
	type ArtifactRef,
	ExecutionManifest as ExecutionManifestSchema,
	type ExecutionRunConfig,
	type RunEventBody,
} from "@payo/contracts";
import type { ExecutionWorkspace } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import { applyExecutionCheckpoint } from "../domain/execution.ts";
import { executionNaming } from "../domain/execution-naming.ts";
import { renderCommitSubject } from "../domain/naming.ts";
import {
	storeExecutionCheckpoint,
	storePhaseReceipt,
} from "../execution-artifacts.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";
import type { reviewMutableImplementation } from "../execution-review.ts";
import {
	findArtifactRef,
	implementationSummary,
	putJsonArtifact,
	readPhaseReceipts,
	storeJsonArtifact,
} from "./artifacts.ts";
import {
	checkpoint,
	openGateSteps,
	raiseExecutionGate,
	runConfig,
} from "./checkpoint.ts";
import { makeWorkspaceIdentity } from "./workspace.ts";

export async function finalizePhase(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	review: Awaited<ReturnType<typeof reviewMutableImplementation>>,
	signal: AbortSignal,
): Promise<void> {
	const identity = state.checkpoint.workspace;
	const checksRef = state.checkpoint.evidence.checks;
	const reviewRef = review.reviewRef;
	const reportRef = findArtifactRef(
		state.log.current(),
		"factory-execution-implementation-report-v1",
	);
	const manifestRef = state.checkpoint.manifest;
	if (
		!identity ||
		!checksRef ||
		!reviewRef ||
		!reportRef ||
		!manifestRef ||
		!review.diffRef
	)
		throw new Error("phase acceptance is missing report or review evidence");
	const manifest = ExecutionManifestSchema.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(state.deps.store, manifestRef),
			),
		),
	);
	const phase = manifest.phases[state.checkpoint.phaseIndex];
	if (!phase) throw new Error("accepted phase is absent from manifest");
	const summary = await implementationSummary(state, reportRef);
	const committed = await commitReviewedWorkspace(
		state,
		config,
		workspace,
		review,
		{
			scope: "phase",
			phaseId: phase.id,
			phaseIndex: state.checkpoint.phaseIndex,
			startCommit: review.startCommit,
			report: reportRef,
			checks: checksRef,
			review: reviewRef,
			summary,
			acceptedCriteria: phase.acceptanceCriteria,
			deviations: [],
		},
		signal,
	);
	if (!committed) return;
	await completePhase(
		state,
		config,
		workspace,
		{
			phaseId: phase.id,
			phaseIndex: state.checkpoint.phaseIndex,
			startCommit: review.startCommit,
			resultCommit: committed.resultCommit,
			report: reportRef,
			checks: checksRef,
			review: reviewRef,
			summary,
			acceptedCriteria: phase.acceptanceCriteria,
			deviations: [],
		},
		signal,
		committed.stepId,
	);
}

export async function finalizeExecution(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	review: Awaited<ReturnType<typeof reviewMutableImplementation>>,
	signal: AbortSignal,
): Promise<void> {
	const checksRef = state.checkpoint.evidence.checks;
	const reviewRef = review.reviewRef;
	const manifestRef = state.checkpoint.manifest;
	if (!checksRef || !reviewRef || !manifestRef || !review.diffRef)
		throw new Error("final PR acceptance is missing check or review evidence");
	const manifest = ExecutionManifestSchema.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(state.deps.store, manifestRef),
			),
		),
	);
	const receipts = await readPhaseReceipts(state);
	const summary = `Final PR-wide checks and review accepted after ${receipts.length} phase(s).`;
	const reportRef = await storeJsonArtifact(
		state,
		{
			summary,
			phases: receipts,
			finalChecks: checksRef,
			finalReview: reviewRef,
			planHash: config.plan.sha256,
		},
		"factory-execution-final-report-v1",
	);
	const committed = await commitReviewedWorkspace(
		state,
		config,
		workspace,
		review,
		{
			scope: "final",
			phaseId: "final",
			phaseIndex: state.checkpoint.phaseIndex,
			startCommit: review.startCommit,
			report: reportRef,
			checks: checksRef,
			review: reviewRef,
			summary,
			acceptedCriteria: manifest.phases.flatMap(
				(phase) => phase.acceptanceCriteria,
			),
			deviations: receipts.flatMap((receipt) => receipt.deviations),
		},
		signal,
	);
	if (!committed) return;
	await completeExecution(
		state,
		workspace,
		committed.resultCommit,
		summary,
		reportRef,
		signal,
		committed.stepId,
	);
}

async function commitReviewedWorkspace(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	review: Awaited<ReturnType<typeof reviewMutableImplementation>>,
	details: {
		scope: "phase" | "final";
		phaseId: string;
		phaseIndex: number;
		startCommit: string;
		report: ArtifactRef;
		checks: ArtifactRef;
		review: ArtifactRef;
		summary: string;
		acceptedCriteria: string[];
		deviations: string[];
	},
	signal: AbortSignal,
): Promise<{ resultCommit: string; stepId?: string } | null> {
	const identity = state.checkpoint.workspace;
	if (!identity) throw new Error("reviewed workspace identity is missing");
	const current = await workspace.inspect(identity.path, signal);
	if (
		current.fingerprint !== review.fingerprint ||
		current.head !== identity.head ||
		current.branch !== identity.branch
	) {
		await raiseExecutionGate(
			state,
			"Review",
			"workspace changed after review and before commit",
			openGateSteps(state),
			"workspace-mutated-before-commit",
		);
		return null;
	}
	const plan = await workspace.prepareCommit(
		identity.path,
		review.fingerprint,
		signal,
	);
	if (plan.parent !== current.head) {
		await raiseExecutionGate(
			state,
			"Review",
			"commit parent differs from the reviewed workspace HEAD",
			openGateSteps(state),
			"unexpected-commit-parent",
		);
		return null;
	}
	if (!plan.changed) {
		const unchanged = await workspace.inspect(identity.path, signal);
		if (
			unchanged.fingerprint !== plan.expectedSnapshot ||
			unchanged.head !== plan.parent
		) {
			await raiseExecutionGate(
				state,
				"Review",
				"workspace changed while confirming an already-satisfied scope",
				openGateSteps(state),
				"workspace-mutated-before-commit",
			);
			return null;
		}
		return { resultCommit: plan.parent };
	}
	const runId = state.log.current().runId;
	const trailer = `Payo-Execution: ${runId}/${details.phaseId}`;
	const naming = executionNaming(config, state.checkpoint);
	let subject = `${details.scope === "final" ? "Finalize" : "Implement"} ${details.phaseId}`;
	if (naming) {
		const manifestRef = state.checkpoint.manifest;
		if (!manifestRef) throw new Error("commit manifest missing");
		const manifest = ExecutionManifestSchema.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readArtifact(state.deps.store, manifestRef),
				),
			),
		);
		const description =
			details.scope === "final"
				? `Finalize ${manifest.pr.title}`
				: manifest.phases[details.phaseIndex]?.title;
		if (!description) throw new Error("commit manifest phase is missing");
		subject = renderCommitSubject(naming.policy, naming.ticketId, description);
	}
	const message = `${subject}\n\n${trailer}`;
	const intent = {
		scope: details.scope,
		phaseId: details.phaseId,
		phaseIndex: details.phaseIndex,
		startCommit: details.startCommit,
		parent: plan.parent,
		tree: plan.tree,
		expectedSnapshot: plan.expectedSnapshot,
		trailer,
		message,
		report: details.report,
		checks: details.checks,
		review: details.review,
		summary: details.summary,
		acceptedCriteria: details.acceptedCriteria,
		deviations: details.deviations,
	};
	const stepId = state.deps.newId();
	await checkpoint(
		state,
		{
			stage: "Review",
			commitIntent: intent,
			workspace: makeWorkspaceIdentity(
				identity.path,
				current,
				config.baseCommit,
			),
			inFlight: { operation: "Review", stepIds: [stepId] },
			statusDetail: "commit-pending",
		},
		[
			{
				type: "step.started",
				stepId,
				name: `commit accepted ${details.scope} ${details.phaseId}`,
			},
		],
	);
	const resultCommit = await workspace.commit(
		identity.path,
		intent.expectedSnapshot,
		intent.message,
		signal,
		{ parent: intent.parent, tree: intent.tree, trailer: intent.trailer },
	);
	const committed = await workspace.inspectCommit(identity.path, signal);
	const after = await workspace.inspect(identity.path, signal);
	if (
		committed.head !== resultCommit ||
		committed.parent !== intent.parent ||
		committed.tree !== intent.tree ||
		committed.message.trimEnd() !== intent.message.trimEnd() ||
		after.head !== resultCommit ||
		after.branch !== identity.branch ||
		after.changedPaths.length > 0
	)
		throw new Error("created commit does not match durable execution intent");
	return { resultCommit, stepId };
}

export async function reconcileCommitIntent(
	state: MutableExecutionHandle,
	workspace: ExecutionWorkspace,
	signal: AbortSignal,
): Promise<void> {
	const intent = state.checkpoint.commitIntent;
	const identity = state.checkpoint.workspace;
	if (!intent || !identity)
		throw new Error("commit recovery intent is incomplete");
	const snapshot = await workspace.inspect(identity.path, signal);
	if (snapshot.branch !== identity.branch) {
		await raiseExecutionGate(
			state,
			"Review",
			"execution branch changed during commit recovery",
			openGateSteps(state),
			"commit-reconciliation-failed",
		);
		return;
	}
	const commitInfo = await workspace.inspectCommit(identity.path, signal);
	let resultCommit: string;
	if (commitInfo.head === intent.parent) {
		if (snapshot.historyFingerprint !== identity.historyFingerprint) {
			await raiseExecutionGate(
				state,
				"Review",
				"unexpected Git history before intended commit",
				openGateSteps(state),
				"commit-reconciliation-failed",
			);
			return;
		}
		const staged = await workspace.prepareCommit(
			identity.path,
			intent.expectedSnapshot,
			signal,
		);
		if (
			staged.parent !== intent.parent ||
			staged.tree !== intent.tree ||
			staged.expectedSnapshot !== intent.expectedSnapshot
		) {
			await raiseExecutionGate(
				state,
				"Review",
				"staged tree no longer matches durable commit intent",
				openGateSteps(state),
				"commit-reconciliation-failed",
			);
			return;
		}
		resultCommit = await workspace.commit(
			identity.path,
			intent.expectedSnapshot,
			intent.message,
			signal,
			{
				parent: intent.parent,
				tree: intent.tree,
				trailer: intent.trailer,
			},
		);
	} else if (
		commitInfo.parent === intent.parent &&
		commitInfo.tree === intent.tree &&
		commitInfo.message.trimEnd() === intent.message.trimEnd() &&
		snapshot.head === commitInfo.head &&
		snapshot.changedPaths.length === 0
	)
		resultCommit = commitInfo.head;
	else {
		await raiseExecutionGate(
			state,
			"Review",
			"HEAD does not match the durable commit intent; unexpected history is preserved",
			openGateSteps(state),
			"commit-reconciliation-failed",
		);
		return;
	}
	const committed = await workspace.inspectCommit(identity.path, signal);
	if (
		committed.head !== resultCommit ||
		committed.parent !== intent.parent ||
		committed.tree !== intent.tree ||
		committed.message.trimEnd() !== intent.message.trimEnd()
	) {
		await raiseExecutionGate(
			state,
			"Review",
			"commit does not match durable intent during recovery",
			openGateSteps(state),
			"commit-reconciliation-failed",
		);
		return;
	}
	if (intent.scope === "final") {
		await completeExecution(
			state,
			workspace,
			resultCommit,
			intent.summary,
			intent.report,
			signal,
			state.checkpoint.inFlight?.stepIds[0],
		);
		return;
	}
	await completePhase(
		state,
		runConfig(state.log.current()),
		workspace,
		{
			phaseId: intent.phaseId,
			phaseIndex: intent.phaseIndex,
			startCommit: intent.startCommit,
			resultCommit,
			report: intent.report,
			checks: intent.checks,
			review: intent.review,
			summary: intent.summary,
			acceptedCriteria: intent.acceptedCriteria,
			deviations: intent.deviations,
		},
		signal,
		state.checkpoint.inFlight?.stepIds[0],
	);
}

async function completePhase(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	receipt: {
		phaseId: string;
		phaseIndex: number;
		startCommit: string;
		resultCommit: string;
		report: ArtifactRef;
		checks: ArtifactRef;
		review: ArtifactRef;
		summary: string;
		acceptedCriteria: string[];
		deviations: string[];
	},
	signal: AbortSignal,
	commitStepId?: string,
): Promise<void> {
	const identity = state.checkpoint.workspace;
	if (!identity) throw new Error("completed phase has no workspace");
	const snapshot = await workspace.inspect(identity.path, signal);
	if (
		snapshot.head !== receipt.resultCommit ||
		snapshot.branch !== identity.branch ||
		snapshot.changedPaths.length > 0
	)
		throw new Error(
			"workspace changed before recording the accepted phase receipt",
		);
	const manifestRef = state.checkpoint.manifest;
	if (!manifestRef) throw new Error("completed phase has no manifest");
	const manifest = ExecutionManifestSchema.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(state.deps.store, manifestRef),
			),
		),
	);
	const acceptedPhase = manifest.phases[receipt.phaseIndex];
	if (
		!acceptedPhase ||
		receipt.phaseIndex !== state.checkpoint.phaseIndex ||
		receipt.phaseId !== acceptedPhase.id ||
		state.checkpoint.receipts.length !== receipt.phaseIndex
	)
		throw new Error("phase receipt does not match the next approved phase");
	const storedReceipt = await storePhaseReceipt(state.deps.store, {
		...receipt,
		planHash: config.plan.sha256,
	});
	if (storedReceipt.type !== "artifact.recorded")
		throw new Error("phase receipt artifact was not stored");
	const hasNextPhase = receipt.phaseIndex + 1 < manifest.phases.length;
	const next = applyExecutionCheckpoint(
		state.checkpoint,
		state.checkpoint.revision,
		{
			...state.checkpoint,
			revision: state.checkpoint.revision + 1,
			stage: hasNextPhase ? "Implement" : "Finalize",
			phaseIndex: hasNextPhase ? receipt.phaseIndex + 1 : receipt.phaseIndex,
			scope: hasNextPhase ? "phase" : "final",
			round: 0,
			workspace: makeWorkspaceIdentity(
				identity.path,
				snapshot,
				config.baseCommit,
			),
			evidence: { diff: null, checks: null, review: null },
			receipts: [...state.checkpoint.receipts, storedReceipt.artifact],
			commitIntent: null,
			pendingFindingIds: [],
			inFlight: null,
			escalation: null,
			statusDetail: null,
		},
	);
	const events: RunEventBody[] = [storedReceipt];
	if (
		commitStepId &&
		state.log.current().steps.get(commitStepId)?.status === "running"
	)
		events.push({
			type: "step.finished",
			stepId: commitStepId,
			outcome: "succeeded",
		});
	events.push(await storeExecutionCheckpoint(state.deps.store, next));
	await state.log.write(events);
	state.checkpoint = next;
}

async function completeExecution(
	state: MutableExecutionHandle,
	workspace: ExecutionWorkspace,
	resultCommit: string,
	summary: string,
	report: ArtifactRef,
	signal: AbortSignal,
	commitStepId?: string,
): Promise<void> {
	const identity = state.checkpoint.workspace;
	const checks = state.checkpoint.evidence.checks;
	const review = state.checkpoint.evidence.review;
	if (!identity || !checks || !review)
		throw new Error("final execution evidence is incomplete");
	const snapshot = await workspace.inspect(identity.path, signal);
	if (
		snapshot.head !== resultCommit ||
		snapshot.branch !== identity.branch ||
		snapshot.changedPaths.length > 0
	)
		throw new Error("workspace changed before final execution completion");
	const resultRef = await putJsonArtifact(
		state.deps.store,
		{
			resultCommit,
			summary,
			report,
			checks,
			review,
			phaseReceipts: state.checkpoint.receipts,
		},
		"factory-execution-final-result-v1",
	);
	const next = applyExecutionCheckpoint(
		state.checkpoint,
		state.checkpoint.revision,
		{
			...state.checkpoint,
			revision: state.checkpoint.revision + 1,
			stage: "Completed",
			scope: "final",
			workspace: makeWorkspaceIdentity(
				identity.path,
				snapshot,
				runConfig(state.log.current()).baseCommit,
			),
			commitIntent: null,
			pendingFindingIds: [],
			inFlight: null,
			escalation: null,
			statusDetail: null,
		},
	);
	const events: RunEventBody[] = [
		{ type: "artifact.recorded", artifact: resultRef, attemptId: null },
	];
	if (
		commitStepId &&
		state.log.current().steps.get(commitStepId)?.status === "running"
	)
		events.push({
			type: "step.finished",
			stepId: commitStepId,
			outcome: "succeeded",
		});
	events.push(await storeExecutionCheckpoint(state.deps.store, next), {
		type: "run.ended",
		outcome: "reviewed",
	});
	await state.log.write(events);
	state.checkpoint = next;
}

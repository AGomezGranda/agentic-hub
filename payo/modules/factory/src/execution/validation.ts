import {
	type ArtifactRef,
	ExecutionManifest as ExecutionManifestSchema,
	type ExecutionRunConfig,
	jsonEnvelope,
	RepairOutput as RepairOutputSchema,
} from "@payo/contracts";
import {
	allChecksPassed,
	type CheckResult,
	type CheckStatus,
	type Checks,
	type ExecutionWorkspace,
	runAgentStep,
} from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import {
	accountRepair,
	MAX_VALIDATION_CYCLES,
	repairContinuation,
	validationAction,
} from "../domain/execution.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";
import { reviewMutableImplementation } from "../execution-review.ts";
import { executionRepairSpec } from "../execution-roles.ts";
import {
	findArtifactRef,
	phaseStartCommit,
	readPhaseReceipts,
	storeJsonArtifact,
	storeTextArtifact,
} from "./artifacts.ts";
import {
	checkpoint,
	openGateSteps,
	raiseCancelledGate,
	raiseExecutionGate,
	raiseExecutionGateWithEvidence,
} from "./checkpoint.ts";
import { finalizeExecution, finalizePhase } from "./commit.ts";
import {
	assertKnownWorkspace,
	captureDiffOrGate,
	describeError,
	makeWorkspaceIdentity,
	type requireExecutionPorts,
	toCheckCommand,
} from "./workspace.ts";

const checkStatuses = new Set<CheckStatus>([
	"passed",
	"failed",
	"timed_out",
	"cancelled",
	"spawn_failed",
]);

interface CheckCycleResult {
	status: "passed" | "failed" | "dirty";
	checkRef: ArtifactRef;
	diffRef: ArtifactRef | null;
	fingerprint: string;
	failedNames: string[];
}

export async function validatePhase(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	deps: ReturnType<typeof requireExecutionPorts>,
	signal: AbortSignal,
): Promise<void> {
	for (
		let cycle = state.checkpoint.round + 1;
		cycle <= MAX_VALIDATION_CYCLES;
		cycle++
	) {
		if (signal.aborted) throw new Error("execution validation cancelled");
		const checked = await runCheckCycle(
			state,
			config,
			deps.workspace,
			deps.checks,
			signal,
			cycle,
		);
		if (!checked) return;
		const action = validationAction(checked.status, cycle);
		if (checked.status === "dirty") {
			if (action === "escalate") {
				await raiseExecutionGate(
					state,
					"Check",
					`checks modified the workspace in ${MAX_VALIDATION_CYCLES} validation cycles`,
					[],
					"checks-kept-modifying-workspace",
				);
				return;
			}
			continue;
		}
		if (checked.status === "failed") {
			if (action === "escalate") {
				await raiseExecutionGate(
					state,
					"Check",
					`Checks still failing after ${cycle} validation cycles: ${checked.failedNames.join(", ")}`,
					[],
					"checks-repair-budget-exhausted",
				);
				return;
			}
			const repaired = await repairScope(state, config, deps, signal, {
				cycle,
				findingIds: [],
				findings: [],
				checkRef: checked.checkRef,
				diffRef: checked.diffRef,
			});
			if (!repaired) return;
			continue;
		}

		const scope = state.checkpoint.scope;
		const review = await reviewMutableImplementation(state, scope, signal);
		if (review.reviewRef) {
			const reviewWorkspace = state.checkpoint.workspace;
			if (!reviewWorkspace) throw new Error("review workspace is missing");
			const reviewedSnapshot = await deps.workspace.inspect(
				reviewWorkspace.path,
				signal,
			);
			await checkpoint(state, {
				stage: "Review",
				workspace: makeWorkspaceIdentity(
					reviewWorkspace.path,
					reviewedSnapshot,
					config.baseCommit,
				),
				evidence: {
					diff: review.diffRef,
					checks: checked.checkRef,
					review: review.reviewRef,
				},
				inFlight: null,
				statusDetail: null,
			});
		}
		if (review.decision === "Accepted") {
			const accepted = [
				...new Set([
					...state.checkpoint.acceptedFindingIds,
					...state.checkpoint.pendingFindingIds,
				]),
			];
			await checkpoint(state, {
				stage: "Review",
				acceptedFindingIds: accepted,
				pendingFindingIds: [],
				unresolvedFindingIds: [],
				evidence: {
					diff: review.diffRef,
					checks: checked.checkRef,
					review: review.reviewRef,
				},
			});
			if (scope === "phase")
				await finalizePhase(state, config, deps.workspace, review, signal);
			else
				await finalizeExecution(state, config, deps.workspace, review, signal);
			return;
		}
		if (review.decision === "Repair") {
			if (cycle === MAX_VALIDATION_CYCLES) {
				await checkpoint(state, { unresolvedFindingIds: review.blockerIds });
				await raiseExecutionGate(
					state,
					"Review",
					review.reason ??
						"verified blockers remain after three validation cycles",
					openGateSteps(state),
					"review-repair-budget-exhausted",
				);
				return;
			}
			const blockers = review.findings.filter((finding) =>
				review.blockerIds.includes(finding.id),
			);
			const findingsRef = await storeJsonArtifact(
				state,
				{ findings: blockers, acceptedFindingIds: review.blockerIds },
				"factory-execution-accepted-findings-v1",
			);
			const repaired = await repairScope(state, config, deps, signal, {
				cycle,
				findingIds: review.blockerIds,
				findings: blockers,
				findingsRef,
				checkRef: checked.checkRef,
				diffRef: review.diffRef,
			});
			if (!repaired) return;
			continue;
		}
		if (review.blockerIds.length > 0)
			await checkpoint(state, {
				unresolvedFindingIds: review.blockerIds,
			});
		const current = state.checkpoint.workspace;
		const snapshot = current
			? await deps.workspace.inspect(current.path, signal)
			: null;
		const mutated = review.reason?.includes("mutated") === true;
		await raiseExecutionGateWithEvidence(
			state,
			"Review",
			review.reason ?? "implementation review could not be accepted",
			openGateSteps(state),
			mutated
				? "workspace-mutated-during-review"
				: review.reason?.includes("budget exhausted")
					? "review-repair-budget-exhausted"
					: "implementation-review-failed",
			snapshot && mutated
				? { diff: null, checks: null, review: null }
				: {
						diff: review.diffRef,
						checks: checked.checkRef,
						review: review.reviewRef,
					},
		);
		return;
	}
}

async function runCheckCycle(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	workspace: ExecutionWorkspace,
	checks: Checks,
	signal: AbortSignal,
	cycle: number,
): Promise<CheckCycleResult | null> {
	const identity = state.checkpoint.workspace;
	if (!identity) throw new Error("execution workspace is missing");
	const commands = config.checks.map(toCheckCommand);
	if (commands.length === 0) {
		await raiseExecutionGate(
			state,
			"Check",
			"no configured checks; an empty suite cannot pass",
			[],
			"checks-missing",
		);
		return null;
	}
	const before = await workspace.inspect(identity.path, signal);
	assertKnownWorkspace(
		before,
		config.baseCommit,
		identity.branch,
		identity.head ?? config.baseCommit,
	);
	const stepId = state.deps.newId();
	await checkpoint(
		state,
		{
			stage: "Check",
			cycle: state.checkpoint.cycle + 1,
			round: cycle,
			workspace: makeWorkspaceIdentity(
				identity.path,
				before,
				config.baseCommit,
			),
			evidence: { diff: null, checks: null, review: null },
			inFlight: { operation: "Check", stepIds: [stepId] },
			statusDetail: "checking",
		},
		[
			{
				type: "step.started",
				stepId,
				name: `run configured checks (cycle ${cycle})`,
			},
		],
	);
	let results: CheckResult[];
	try {
		results = await checks.run(identity.path, commands, signal);
	} catch (error) {
		await checkpoint(
			state,
			{ inFlight: null, statusDetail: "check-runner-failed" },
			[{ type: "step.finished", stepId, outcome: "failed" }],
		);
		await raiseExecutionGate(
			state,
			"Check",
			`check execution failed: ${describeError(error)}`,
			[stepId],
			"checks-failed",
		);
		return null;
	}
	const structurallyValid =
		results.length === commands.length &&
		results.every(
			(result, index) =>
				result.name === commands[index]?.name &&
				checkStatuses.has(result.status),
		);
	if (!structurallyValid)
		results = [
			{
				name: "payo-check-adapter",
				status: "failed",
				exitCode: null,
				stdout: "",
				stderr: "check adapter returned missing, reordered, or invalid results",
				truncated: false,
			},
		];
	const after = await workspace.inspect(identity.path, signal);
	const passed = structurallyValid && allChecksPassed(results);
	const changed = after.fingerprint !== before.fingerprint;
	const checkRef = await storeJsonArtifact(
		state,
		{
			cycle,
			commands,
			results,
			beforeFingerprint: before.fingerprint,
			afterFingerprint: after.fingerprint,
			stable: !changed,
		},
		"factory-execution-check-results-v1",
	);
	let diffRef: ArtifactRef | null = null;
	if (!changed) {
		const diffBase =
			state.checkpoint.scope === "final"
				? config.baseCommit
				: await phaseStartCommit(state, config);
		const diff = await captureDiffOrGate(
			state,
			workspace,
			identity.path,
			diffBase,
			signal,
			"Check",
			[stepId],
		);
		if (diff === null) return null;
		const finalSnapshot = await workspace.inspect(identity.path, signal);
		if (finalSnapshot.fingerprint !== after.fingerprint) {
			await raiseExecutionGate(
				state,
				"Check",
				"workspace changed after checks while capturing evidence",
				[stepId],
				"workspace-mutated-after-checks",
			);
			return null;
		}
		diffRef = await storeTextArtifact(state, diff, "factory-execution-diff-v1");
	}
	await checkpoint(
		state,
		{
			stage: changed ? "Check" : passed ? "Review" : "Repair",
			workspace: makeWorkspaceIdentity(identity.path, after, config.baseCommit),
			evidence: { diff: diffRef, checks: checkRef, review: null },
			inFlight: null,
			statusDetail: changed
				? "checks-modified-workspace"
				: passed
					? null
					: "checks-failed",
		},
		[
			{
				type: "step.finished",
				stepId,
				outcome: passed && !changed ? "succeeded" : "failed",
			},
		],
	);
	return {
		status: changed ? "dirty" : passed ? "passed" : "failed",
		checkRef,
		diffRef,
		fingerprint: after.fingerprint,
		failedNames: results
			.filter((result) => result.status !== "passed")
			.map((result) => result.name),
	};
}

async function repairScope(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
	deps: ReturnType<typeof requireExecutionPorts>,
	signal: AbortSignal,
	input: {
		cycle: number;
		findingIds: string[];
		findings: unknown[];
		findingsRef?: ArtifactRef;
		checkRef: ArtifactRef;
		diffRef: ArtifactRef | null;
	},
): Promise<boolean> {
	const identity = state.checkpoint.workspace;
	const manifestRef = state.checkpoint.manifest;
	if (!identity || !manifestRef)
		throw new Error("repair is missing its phase or workspace");
	const manifest = ExecutionManifestSchema.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(state.deps.store, manifestRef),
			),
		),
	);
	const scope = state.checkpoint.scope;
	const phase = manifest.phases[state.checkpoint.phaseIndex];
	if (scope === "phase" && !phase)
		throw new Error("repair phase is absent from manifest");
	const before = await deps.workspace.inspect(identity.path, signal);
	assertKnownWorkspace(
		before,
		config.baseCommit,
		identity.branch,
		identity.head ?? config.baseCommit,
	);
	const instructionsRef = findArtifactRef(
		state.log.current(),
		"factory-execution-repository-instructions-v1",
	);
	const roleRef = config.roleArtifacts.implementer;
	const settings = config.roles.implementer;
	if (!instructionsRef || !roleRef || !settings)
		throw new Error("repair role inputs are missing");
	const phaseRef = await storeJsonArtifact(
		state,
		scope === "final"
			? {
					scope,
					issueAnswers: state.checkpoint.issueAnswers ?? [],
					pr: manifest.pr,
					phases: manifest.phases,
					phaseIndex: state.checkpoint.phaseIndex,
					workspace: identity,
					receipts: await readPhaseReceipts(state),
				}
			: {
					scope,
					issueAnswers: state.checkpoint.issueAnswers ?? [],
					pr: manifest.pr,
					phase,
					phaseIndex: state.checkpoint.phaseIndex,
					workspace: identity,
					receipts: await readPhaseReceipts(state),
				},
		"factory-execution-scope-input-v1",
	);
	const findingsRef =
		input.findingsRef ??
		(await storeJsonArtifact(
			state,
			{
				findings: input.findings,
				acceptedFindingIds: input.findingIds,
				checkFailure: input.findingIds.length === 0,
			},
			"factory-execution-repair-input-v1",
		));
	const stepId = state.deps.newId();
	await checkpoint(state, {
		stage: "Repair",
		round: input.cycle,
		workspace: makeWorkspaceIdentity(identity.path, before, config.baseCommit),
		inFlight: { operation: "Repair", stepIds: [stepId] },
		statusDetail: input.findingIds.length
			? "repairing-findings"
			: "repairing-check-failures",
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
			stepName: `repair ${scope} validation cycle ${input.cycle}`,
			attemptIds: [state.deps.newId(), state.deps.newId()],
			runner: deps.runner,
			spec: await executionRepairSpec(state.deps.store, roleRef, {
				plan: config.plan,
				phase: phaseRef,
				repositoryInstructions: instructionsRef,
				findings: findingsRef,
				cwd: identity.path,
				workspace: {
					path: identity.path,
					branch: identity.branch,
					baseCommit: config.baseCommit,
				},
				...settings,
				...(input.diffRef ? { diff: input.diffRef } : {}),
				checkLogs: input.checkRef,
				scope,
			}),
			validate: jsonEnvelope(RepairOutputSchema),
			signal,
		},
	);
	if (result.outcome !== "succeeded") {
		if (signal.aborted) await raiseCancelledGate(state, "Repair", [stepId]);
		else
			await raiseExecutionGate(
				state,
				"Repair",
				"repair report could not be validated; retained edits require reconciliation",
				[stepId],
				"repair-report-invalid",
			);
		return false;
	}
	const output = RepairOutputSchema.parse(result.value);
	let accounting: ReturnType<typeof accountRepair>;
	try {
		accounting = accountRepair(input.findingIds, output);
	} catch (error) {
		await raiseExecutionGate(
			state,
			"Repair",
			`invalid repair accounting: ${describeError(error)}`,
			[stepId],
			"repair-accounting-invalid",
		);
		return false;
	}
	const after = await deps.workspace.inspect(identity.path, signal);
	if (
		after.head !== before.head ||
		after.branch !== before.branch ||
		after.historyFingerprint !== before.historyFingerprint
	) {
		await raiseExecutionGate(
			state,
			"Repair",
			"repair writer changed Git history; edits are preserved",
			[stepId],
			"unexpected-git-history",
		);
		return false;
	}
	await storeJsonArtifact(state, output, "factory-execution-repair-report-v1");
	const continuation = repairContinuation(
		output.planIssues,
		accounting.unresolved,
	);
	if (continuation.stage === "Escalated") {
		await checkpoint(state, {
			unresolvedFindingIds: accounting.unresolved,
			workspace: makeWorkspaceIdentity(identity.path, after, config.baseCommit),
		});
		await raiseExecutionGate(
			state,
			"Repair",
			continuation.reason,
			[stepId],
			continuation.detail,
		);
		return false;
	}
	await checkpoint(state, {
		stage: "Check",
		workspace: makeWorkspaceIdentity(identity.path, after, config.baseCommit),
		pendingFindingIds: [
			...new Set([
				...state.checkpoint.pendingFindingIds,
				...accounting.addressed,
			]),
		],
		inFlight: null,
		statusDetail: null,
	});
	return true;
}

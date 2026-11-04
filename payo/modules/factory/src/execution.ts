import { join, resolve } from "node:path";
import {
	type ArtifactRef,
	type ExecutionCheck,
	type ExecutionCheckpoint,
	type ExecutionManifest,
	ExecutionManifest as ExecutionManifestSchema,
	type ExecutionRunConfig,
	ExecutionRunConfig as ExecutionRunConfigSchema,
	type ExecutionStage,
	ImplementationOutput as ImplementationOutputSchema,
	jsonEnvelope,
	PhaseReceipt as PhaseReceiptSchema,
	type PlanOutput,
	PlanVersion,
	RepairOutput as RepairOutputSchema,
	type RunEventBody,
} from "@payo/contracts";
import {
	type AgentRunner,
	allChecksPassed,
	type CheckCommand,
	type CheckResult,
	type CheckStatus,
	type Checks,
	commit,
	ExecutionDiffTooLargeError,
	type ExecutionWorkspace,
	fold,
	type Limiter,
	openRun,
	openRunLog,
	type RunState,
	type RunStore,
	runAgentStep,
	sha256Hex,
} from "@payo/kernel";
import { readArtifact } from "./artifacts.ts";
import { CommandError } from "./errors.ts";
import {
	loadExecutionCheckpoint,
	storeExecutionCheckpoint,
	storePhaseReceipt,
} from "./execution-artifacts.ts";
import {
	createExecutionHandle,
	type ExecutionDeps,
	type ExecutionHandle,
	type MutableExecutionHandle,
	mutableExecutionHandle,
} from "./execution-handle.ts";
import { readExecutionSummary as projectExecutionSummary } from "./execution-read-model.ts";
import { reviewMutableImplementation } from "./execution-review.ts";
import {
	executionImplementerSpec,
	executionPreparerSpec,
	executionRepairSpec,
} from "./execution-roles.ts";
import {
	accountRepair,
	applyExecutionCheckpoint,
	initialExecutionCheckpoint,
	MAX_DIFF_BYTES,
	MAX_VALIDATION_CYCLES,
	sourceEligibility,
	validateExecutionManifest,
} from "./execution-state.ts";
import { resolveImplementation } from "./phase-outline.ts";
import { validateRunId } from "./plans.ts";
import { loadCheckpoint } from "./state.ts";

export type { ExecutionDeps, ExecutionHandle } from "./execution-handle.ts";

const VALIDATION_STAGES: readonly ExecutionStage[] = [
	"Check",
	"Review",
	"Repair",
	"Finalize",
];
const checkStatuses = new Set<CheckStatus>([
	"passed",
	"failed",
	"timed_out",
	"cancelled",
	"spawn_failed",
]);

export interface ExecutionRoleSettings {
	model: string | null;
	timeoutMs: number;
}

export interface ExecutionRoleProvenance {
	path: string;
	sha: string;
}

export interface BeginExecutionInput {
	sourceRunId: string;
	prId: string;
	baseBranch?: string;
	baseCommit?: string;
	/** True when the operator selected an explicit base; an implicit repeat keeps its pinned one. */
	explicitBase?: boolean;
	checks: ExecutionCheck[];
	roles: Record<string, ExecutionRoleSettings>;
	roleArtifacts: Record<string, ArtifactRef>;
	roleProvenance: Record<string, ExecutionRoleProvenance>;
	maxConcurrentAgents: number;
}

const busy = () => new CommandError("busy", "execution command busy");
const conflict = (message: string) => new CommandError("conflict", message);
const invalid = (message: string) =>
	new CommandError("invalid_request", message);

async function checkpoint(
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

function selectedPr(plan: PlanOutput, prId: string) {
	const pr = resolveImplementation(plan.markdown, plan.prStrategy).find(
		(item) => item.id === prId,
	);
	if (!pr)
		throw new CommandError(
			"not_found",
			`PR ${prId} is not in the approved plan`,
		);
	if (!pr.phases.length)
		throw conflict(`PR ${prId} has no phases: ${pr.issues.join(", ")}`);
	if (pr.issues.length) throw conflict(pr.issues.join("\n"));
	return {
		id: pr.id,
		title: pr.title,
		phases: pr.phases.map((phase) => phase.title),
	};
}

function executionId(
	sourceRunId: string,
	planSha: string,
	prId: string,
): string {
	const raw = sha256Hex(
		new TextEncoder().encode(`${sourceRunId}\n${planSha}\n${prId}`),
	).slice(0, 32);
	const variant = "89ab"[Number.parseInt(raw[16] as string, 16) & 3];
	return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

async function approvedPlan(
	store: RunStore,
	events: Awaited<ReturnType<RunStore["read"]>>,
): Promise<{ ref: ArtifactRef; version: PlanVersion }> {
	const checkpoint = await loadCheckpoint(store, events);
	if (!checkpoint.plan) throw conflict("source run has no approved plan");
	const version = PlanVersion.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(store, checkpoint.plan)),
		),
	);
	const markdown = new TextDecoder().decode(
		await readArtifact(store, version.markdown),
	);
	if (markdown !== version.plan.markdown)
		throw new Error("approved plan markdown does not match its version");
	return { ref: checkpoint.plan, version };
}

async function source(
	deps: ExecutionDeps,
	sourceRunId: string,
): Promise<{
	state: RunState;
	plan: Awaited<ReturnType<typeof approvedPlan>>;
}> {
	const events = await deps.store.read(sourceRunId);
	if (events.length === 0) throw invalid(`source run ${sourceRunId} not found`);
	const state = fold(events);
	const eligibility = sourceEligibility(state);
	if (eligibility === "unapproved")
		throw conflict(`source run ${sourceRunId} has not been approved`);
	if (eligibility === "not_planning")
		throw conflict(`source run ${sourceRunId} is not a planning run`);
	return { state, plan: await approvedPlan(deps.store, events) };
}

/** Acceptance is serialized so concurrent duplicates return the same run. */
let acceptanceTail: Promise<void> = Promise.resolve();

function serializeAcceptance<T>(work: () => Promise<T>): Promise<T> {
	const result = acceptanceTail.then(work, work);
	acceptanceTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/**
 * Persists the execution run and its initial checkpoint atomically. It validates
 * the approved source but starts no agents and does not touch the repository.
 */
export function beginExecution(
	deps: ExecutionDeps,
	input: BeginExecutionInput,
): Promise<ExecutionHandle> {
	return serializeAcceptance(() => beginExecutionLocked(deps, input));
}

async function beginExecutionLocked(
	deps: ExecutionDeps,
	input: BeginExecutionInput,
): Promise<ExecutionHandle> {
	validateRunId(input.sourceRunId);
	if (!input.prId.trim()) throw invalid("PR id is required");
	if (input.checks.length === 0) throw invalid("execution checks are required");
	const approved = await source(deps, input.sourceRunId);

	const runId = executionId(
		input.sourceRunId,
		approved.plan.ref.sha256,
		input.prId,
	);
	const existing = await deps.store.read(runId);
	if (existing.length > 0) {
		const config = ExecutionRunConfigSchema.safeParse(
			fold(existing).config.factory,
		);
		if (
			!config.success ||
			config.data.sourceRunId !== input.sourceRunId ||
			config.data.prId !== input.prId ||
			config.data.plan.sha256 !== approved.plan.ref.sha256
		)
			throw conflict(`execution ${runId} identity does not match the source`);
		if (input.explicitBase) {
			const requestedCommit = await selectedBaseCommit(
				deps,
				approved.state.repo,
				input.baseBranch ?? approved.state.baseBranch,
				input.baseCommit,
			);
			if (config.data.baseCommit !== requestedCommit)
				throw conflict(
					`execution ${runId} already exists with base commit ${config.data.baseCommit}`,
				);
		}
		return openExecution(deps, runId, { recover: false });
	}

	selectedPr(approved.plan.version.plan, input.prId);
	const baseBranch = input.baseBranch ?? approved.state.baseBranch;
	const baseCommit = await selectedBaseCommit(
		deps,
		approved.state.repo,
		baseBranch,
		input.baseCommit,
	);
	const config: ExecutionRunConfig = ExecutionRunConfigSchema.parse({
		kind: "factory-execution",
		sourceRunId: input.sourceRunId,
		sourceBaseBranch: approved.state.baseBranch,
		plan: approved.plan.ref,
		prId: input.prId,
		baseCommit,
		checks: input.checks,
		roles: input.roles,
		roleArtifacts: input.roleArtifacts,
		roleProvenance: input.roleProvenance,
		maxConcurrentAgents: input.maxConcurrentAgents,
	});
	const initial = initialExecutionCheckpoint();
	const artifacts = new Map<string, ArtifactRef>();
	for (const ref of [approved.plan.ref, ...Object.values(input.roleArtifacts)])
		artifacts.set(ref.sha256, ref);
	const state = await commit(deps.store, null, [
		{
			type: "run.created",
			runId,
			repo: approved.state.repo,
			baseBranch,
			config: { factory: config },
		},
		...[...artifacts.values()].map((artifact) => ({
			type: "artifact.recorded" as const,
			artifact,
			attemptId: null,
		})),
		await storeExecutionCheckpoint(deps.store, initial),
	]);
	return createExecutionHandle({
		deps,
		log: openRunLog(deps.store, state),
		checkpoint: initial,
		busy: false,
	});
}

async function selectedBaseCommit(
	deps: ExecutionDeps,
	repo: string,
	baseBranch: string,
	provided?: string,
): Promise<string> {
	if (provided?.trim()) return provided;
	if (!deps.workspace)
		throw invalid(
			"execution workspace adapter is required to resolve the base commit",
		);
	return deps.workspace.resolveBase(
		repo,
		baseBranch,
		new AbortController().signal,
	);
}

/** Returns an existing deterministic execution before loading roles or resolving an implicit moving base. */
export async function findExistingExecution(
	deps: ExecutionDeps,
	input: {
		sourceRunId: string;
		prId: string;
		baseBranch?: string;
		explicitBase?: boolean;
		baseCommit?: string;
	},
): Promise<ExecutionHandle | null> {
	validateRunId(input.sourceRunId);
	const approved = await source(deps, input.sourceRunId);

	const runId = executionId(
		input.sourceRunId,
		approved.plan.ref.sha256,
		input.prId,
	);
	const events = await deps.store.read(runId);
	if (events.length === 0) {
		selectedPr(approved.plan.version.plan, input.prId);
		return null;
	}
	const config = ExecutionRunConfigSchema.parse(fold(events).config.factory);
	if (input.explicitBase) {
		const requestedCommit = await selectedBaseCommit(
			deps,
			approved.state.repo,
			input.baseBranch ?? approved.state.baseBranch,
			input.baseCommit,
		);
		if (config.baseCommit !== requestedCommit)
			throw conflict(
				`execution ${runId} already exists with base commit ${config.baseCommit}`,
			);
	}
	return openExecution(deps, runId, { recover: false });
}

/** Opens without scheduling; server startup turns any active execution into a resume gate. */
export async function openExecution(
	deps: ExecutionDeps,
	runId: string,
	options: { recover?: boolean } = {},
): Promise<ExecutionHandle> {
	validateRunId(runId);
	const state = await openRun(deps.store, runId);
	const config = ExecutionRunConfigSchema.safeParse(state.config.factory);
	if (!config.success) throw conflict(`run ${runId} is not an execution run`);
	const current = await loadExecutionCheckpoint(
		deps.store,
		await deps.store.read(runId),
	);
	const mutable: MutableExecutionHandle = {
		deps,
		log: openRunLog(deps.store, state),
		checkpoint: current,
		busy: false,
	};
	if (
		options.recover !== false &&
		state.status === "active" &&
		!(current.stage === "Escalated" && current.inFlight)
	) {
		await raiseExecutionGate(
			mutable,
			current.inFlight?.operation ?? current.stage,
			"execution interrupted by server restart; inspect the retained workspace and resume",
			current.inFlight?.stepIds ?? [],
			"restart-reconciliation-required",
		);
	}
	return createExecutionHandle(mutable);
}

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
		await runExecution(state, input.signal);
		return handle;
	} catch (error) {
		if (input.signal.aborted) throw error;
		const failedStage = state.checkpoint.stage as ExecutionStage;
		if (failedStage !== "Escalated")
			await raiseExecutionGate(
				state,
				failedStage,
				`execution failed safely: ${describeError(error)}`,
				state.checkpoint.inFlight?.stepIds ?? [],
				"execution-failed",
			);
		return handle;
	} finally {
		state.busy = false;
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

function requireExecutionPorts(deps: ExecutionDeps): {
	runner: AgentRunner;
	limiter: Limiter;
	workspace: ExecutionWorkspace;
	checks: Checks;
	dataDir: string;
} {
	if (
		!deps.runner ||
		!deps.limiter ||
		!deps.workspace ||
		!deps.checks ||
		!deps.dataDir
	)
		throw new Error(
			"execution adapters are not configured; writable execution is unavailable",
		);
	if (process.platform === "win32")
		throw new Error("writable execution requires POSIX process-group cleanup");
	return {
		runner: deps.runner,
		limiter: deps.limiter,
		workspace: deps.workspace,
		checks: deps.checks,
		dataDir: deps.dataDir,
	};
}

async function prepareWorkspace(
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
				branch: `payo/${run.runId}`,
				baseCommit: config.baseCommit,
			},
			signal,
		);
		const snapshot = await workspace.inspect(prepared.path, signal);
		assertKnownWorkspace(snapshot, config.baseCommit, `payo/${run.runId}`);
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

async function prepareManifest(
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
				settings,
				state.log.current().repo,
			),
			validate: jsonEnvelope(ExecutionManifestSchema),
			signal,
		},
	);
	if (result.outcome !== "succeeded") {
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
	// Outside the try: abort or infrastructure errors are not plan defects, so they reach the resumable execution-failed gate.
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

async function implementPhase(
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
		`payo/${state.log.current().runId}`,
		phaseStart,
	);
	const recovery = state.checkpoint.statusDetail === "reconciliation-required";
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
			stepName: recovery
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
		await raiseExecutionGate(
			state,
			"Implement",
			"implementation report could not be validated; edits are preserved for reconciliation",
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
		await raiseExecutionGate(
			state,
			"Implement",
			output.planIssues.length > 0
				? `implementer reported plan issues: ${output.planIssues.join("; ")}`
				: `implementation did not report all acceptance criteria: ${missingCriteria.join("; ")}`,
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

async function captureDiffOrGate(
	state: MutableExecutionHandle,
	workspace: ExecutionWorkspace,
	path: string,
	baseCommit: string,
	signal: AbortSignal,
	operation: ExecutionStage,
	stepIds: readonly string[],
): Promise<string | null> {
	try {
		const diff = await workspace.diff(path, baseCommit, signal, MAX_DIFF_BYTES);
		if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES)
			throw new ExecutionDiffTooLargeError(MAX_DIFF_BYTES);
		return diff;
	} catch (error) {
		if (!(error instanceof ExecutionDiffTooLargeError)) throw error;
		await raiseExecutionGate(
			state,
			operation,
			error.message,
			stepIds,
			"diff-too-large",
		);
		return null;
	}
}

interface CheckCycleResult {
	status: "passed" | "failed" | "dirty";
	checkRef: ArtifactRef;
	diffRef: ArtifactRef | null;
	fingerprint: string;
	reason?: string;
}

async function validatePhase(
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
		if (checked.status === "dirty") {
			if (cycle === MAX_VALIDATION_CYCLES) {
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
			if (cycle === MAX_VALIDATION_CYCLES) {
				await raiseExecutionGate(
					state,
					"Check",
					"configured checks still fail after three validation cycles",
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
					pr: manifest.pr,
					phases: manifest.phases,
					phaseIndex: state.checkpoint.phaseIndex,
					workspace: identity,
					receipts: await readPhaseReceipts(state),
				}
			: {
					scope,
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
		{ store: state.deps.store, log: state.log, limiter: deps.limiter },
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
	if (output.planIssues.length > 0 || accounting.unresolved.length > 0) {
		await checkpoint(state, {
			unresolvedFindingIds: accounting.unresolved,
			workspace: makeWorkspaceIdentity(identity.path, after, config.baseCommit),
		});
		await raiseExecutionGate(
			state,
			"Repair",
			output.planIssues.length
				? `repair reports approved-plan issues: ${output.planIssues.join("; ")}`
				: `repair left blockers unresolved: ${accounting.unresolved.join(", ")}`,
			[stepId],
			output.planIssues.length ? "repair-plan-issue" : "repair-unresolved",
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

async function finalizePhase(
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

async function finalizeExecution(
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
	const message = `${details.scope === "final" ? "Finalize" : "Implement"} ${details.phaseId}\n\n${trailer}`;
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
		!committed.message.split(/\r?\n/).includes(intent.trailer) ||
		after.head !== resultCommit ||
		after.branch !== identity.branch ||
		after.changedPaths.length > 0
	)
		throw new Error("created commit does not match durable execution intent");
	return { resultCommit, stepId };
}

async function reconcileCommitIntent(
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
		commitInfo.message.split(/\r?\n/).includes(intent.trailer) &&
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
		!committed.message.split(/\r?\n/).includes(intent.trailer)
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

async function phaseStartCommit(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
): Promise<string> {
	const ref = state.checkpoint.receipts.at(-1);
	if (!ref) return config.baseCommit;
	const receipt = PhaseReceiptSchema.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(state.deps.store, ref)),
		),
	);
	return receipt.resultCommit;
}

async function readPhaseReceipts(
	state: MutableExecutionHandle,
): Promise<import("@payo/contracts").PhaseReceipt[]> {
	return Promise.all(
		state.checkpoint.receipts.map(async (ref) =>
			PhaseReceiptSchema.parse(
				JSON.parse(
					new TextDecoder().decode(await readArtifact(state.deps.store, ref)),
				),
			),
		),
	);
}

async function implementationSummary(
	state: MutableExecutionHandle,
	reportRef: ArtifactRef,
): Promise<string> {
	const value = ImplementationOutputSchema.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(state.deps.store, reportRef)),
		),
	);
	return value.summary;
}

function openGateSteps(handle: MutableExecutionHandle): string[] {
	return [
		...new Set(
			[...handle.log.current().gates.values()]
				.filter((gate) => gate.status === "open")
				.map((gate) => gate.stepId),
		),
	];
}

/** Engine gates and then proceeds only after explicit resume reconciliation. */
export function assertExecutionResumable(handle: ExecutionHandle): void {
	const state = mutableExecutionHandle(handle);
	if (state.busy) throw busy();
	if (state.checkpoint.stage !== "Escalated" || !state.checkpoint.inFlight)
		throw conflict("execution is not resumable");
	const owned = new Set(state.checkpoint.inFlight.stepIds);
	for (const gate of state.log.current().gates.values())
		if (gate.status === "open" && !owned.has(gate.stepId))
			throw conflict(`unrelated open gate ${gate.gateId}`);
	const reason = state.checkpoint.escalation?.reason.toLowerCase() ?? "";
	if (
		state.checkpoint.statusDetail === "manifest-invalid" ||
		state.checkpoint.statusDetail === "repair-plan-issue" ||
		reason.includes("approved-plan conflict") ||
		reason.includes("reported plan issues")
	)
		throw conflict(
			"execution is gated by the pinned approved plan; create and approve a corrected planning run before starting a new execution",
		);
}

/** Resume inspects retained work, starts a fresh reconciliation context, and reruns checks. */
export async function resumeExecution(
	handle: ExecutionHandle,
	input: { signal: AbortSignal },
): Promise<ExecutionHandle> {
	assertExecutionResumable(handle);
	const state = mutableExecutionHandle(handle);
	state.busy = true;
	try {
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
			if (snapshot.branch !== `payo/${state.log.current().runId}`)
				throw conflict("execution branch changed; it remains gated");
			if (
				!state.checkpoint.commitIntent &&
				(snapshot.head !== (workspace.head ?? config.baseCommit) ||
					(snapshot.historyFingerprint !== workspace.historyFingerprint &&
						workspace.historyFingerprint !== null))
			)
				throw conflict(
					"execution workspace has an unexpected HEAD, refs, or reflog; it remains gated",
				);
			workspace = makeWorkspaceIdentity(
				workspace.path,
				snapshot,
				config.baseCommit,
			);
		}
		const resumeStage: ExecutionStage = !state.checkpoint.manifest
			? "Prepare"
			: state.checkpoint.commitIntent
				? "Review"
				: state.checkpoint.scope === "final"
					? "Finalize"
					: ["Check", "Review", "Repair"].includes(marker.operation)
						? "Check"
						: "Implement";
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
		await runExecution(state, input.signal);
		return handle;
	} finally {
		state.busy = false;
	}
}

export async function readExecutionSummary(
	handle: ExecutionHandle,
): Promise<import("@payo/contracts").ExecutionSummary> {
	return projectExecutionSummary(handle);
}

async function readApprovedVersion(
	store: RunStore,
	ref: ArtifactRef,
): Promise<PlanVersion> {
	return PlanVersion.parse(
		JSON.parse(new TextDecoder().decode(await readArtifact(store, ref))),
	);
}

function runConfig(state: RunState): ExecutionRunConfig {
	return ExecutionRunConfigSchema.parse(state.config.factory);
}

function toCheckCommand(check: ExecutionCheck): CheckCommand {
	return {
		name: check.name,
		command: check.command,
		args: check.args,
		timeoutMs: check.timeout_ms,
	};
}

function makeWorkspaceIdentity(
	path: string,
	snapshot: Awaited<ReturnType<ExecutionWorkspace["inspect"]>>,
	baseCommit: string,
): NonNullable<ExecutionCheckpoint["workspace"]> {
	return {
		path,
		branch: snapshot.branch,
		baseCommit,
		head: snapshot.head,
		fingerprint: snapshot.fingerprint,
		historyFingerprint: snapshot.historyFingerprint,
	};
}

function assertKnownWorkspace(
	snapshot: Awaited<ReturnType<ExecutionWorkspace["inspect"]>>,
	baseCommit: string,
	branch: string,
	expectedHead = baseCommit,
): void {
	if (snapshot.head !== expectedHead || snapshot.branch !== branch)
		throw new Error("execution worktree has an unexpected HEAD or branch");
}

async function storeJsonArtifact(
	state: MutableExecutionHandle,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	const ref = await putJsonArtifact(state.deps.store, value, kind);
	await state.log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return ref;
}

function putJsonArtifact(
	store: RunStore,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	return store.putArtifact(new TextEncoder().encode(JSON.stringify(value)), {
		kind,
		mediaType: "application/json",
	});
}

async function storeTextArtifact(
	state: MutableExecutionHandle,
	value: string,
	kind: string,
): Promise<ArtifactRef> {
	const ref = await state.deps.store.putArtifact(
		new TextEncoder().encode(value),
		{
			kind,
			mediaType: "text/x-diff",
		},
	);
	await state.log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return ref;
}

function findArtifactRef(state: RunState, kind: string): ArtifactRef | null {
	const event = state.artifacts.findLast((artifact) => artifact.kind === kind);
	return event ?? null;
}

async function raiseExecutionGate(
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

async function raiseExecutionGateWithEvidence(
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

function requireDataDir(deps: ExecutionDeps): string {
	if (!deps.dataDir)
		throw new Error("execution data directory is not configured");
	return deps.dataDir;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

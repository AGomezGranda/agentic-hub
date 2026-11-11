import {
	type ArtifactRef,
	type ExecutionCheck,
	type ExecutionRunConfig,
	ExecutionRunConfig as ExecutionRunConfigSchema,
	type ImplementRequest,
	type PublicationPolicy,
} from "@payo/contracts";
import { commit, fold, openRun, openRunLog } from "@payo/kernel";
import { initialExecutionCheckpoint } from "../domain/execution.ts";
import { validatePublicationPolicy } from "../domain/naming.ts";
import {
	loadExecutionCheckpoint,
	storeExecutionCheckpoint,
} from "../execution-artifacts.ts";
import {
	createExecutionHandle,
	type ExecutionDeps,
	type ExecutionHandle,
	type MutableExecutionHandle,
} from "../execution-handle.ts";
import { validateRunId } from "../plans.ts";
import { conflict, invalid, raiseExecutionGate } from "./checkpoint.ts";
import { previewExecutionNaming } from "./naming.ts";

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
	naming?: ImplementRequest["naming"];
	policy?: Partial<PublicationPolicy>;
}

export {
	executionId,
	readApprovedExecutionSource,
	selectedPr,
} from "./source.ts";

import {
	executionId,
	readApprovedExecutionSource,
	selectedPr,
} from "./source.ts";

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

	const approved = await readApprovedExecutionSource(deps, input.sourceRunId);

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
		assertMatchingNaming(config.data.naming, input.naming);
		return openExecution(deps, runId, { recover: false });
	}

	if (input.checks.length === 0) throw invalid("execution checks are required");
	if (!input.naming)
		throw invalid("naming confirmation is required for a new execution");
	if (!deps.workspace) throw invalid("execution workspace adapter is required");
	const preview = await previewExecutionNaming(
		deps as ExecutionDeps & {
			workspace: NonNullable<ExecutionDeps["workspace"]>;
		},
		input.sourceRunId,
		{
			prId: input.prId,
			base: input.baseBranch,
			ticketId: input.naming.ticketId,
			slug: input.naming.slug,
		},
		input.policy ?? {},
		new AbortController().signal,
	);
	if (!preview.previewHash || preview.previewHash !== input.naming.previewHash)
		throw conflict("naming preview is stale; refresh confirmation");
	const naming = {
		version: 1 as const,
		ticketId: input.naming.ticketId,
		slug: preview.slug,
		branch: preview.branch!,
		policy: validatePublicationPolicy(input.policy ?? {}),
	};
	selectedPr(approved.plan.version.plan, input.prId);
	const baseBranch = input.baseBranch ?? approved.state.baseBranch;
	const baseCommit = preview.baseCommit!;
	if (input.baseCommit && input.baseCommit !== baseCommit)
		throw conflict("naming preview base is stale");
	const config: ExecutionRunConfig = ExecutionRunConfigSchema.parse({
		kind: "factory-execution",
		naming,
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
		naming?: ImplementRequest["naming"];
	},
): Promise<ExecutionHandle | null> {
	validateRunId(input.sourceRunId);
	const approved = await readApprovedExecutionSource(deps, input.sourceRunId);

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
	assertMatchingNaming(config.naming, input.naming);
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

function assertMatchingNaming(
	stored: import("@payo/contracts").ExecutionNamingSnapshot | undefined,
	supplied: ImplementRequest["naming"],
) {
	if (
		supplied &&
		(!stored ||
			stored.ticketId !== supplied.ticketId ||
			stored.slug !== supplied.slug)
	)
		throw conflict(
			"execution already exists with a different naming selection",
		);
}

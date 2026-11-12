import type {
	ExecutionCheck,
	ImplementRequest,
	PublicationPolicy,
} from "@payo/contracts";
import { fold } from "@payo/kernel";
import { ApplicationError } from "./errors.ts";
import { beginExecution, type ExecutionDeps } from "./execution.ts";
import { QUALITY_EXPECTATIONS } from "./quality.ts";
import { snapshotRole } from "./roles.ts";
import type { RoleSource } from "./types.ts";

type PreparationRole = {
	model: { provider: string; id: string } | null;
	timeoutMs: number;
};
export interface ExecutionPreparation {
	checks: ExecutionCheck[];
	publication?: Partial<PublicationPolicy>;
	roles: {
		implementer?: PreparationRole;
		verifier: PreparationRole;
		reviewer: PreparationRole;
	};
	allowUnconfiguredModel: boolean;
	platformSupported: boolean;
	maxConcurrentAgents: number;
	loadRoleSources?: (
		repo: string,
		base: string,
	) => Promise<
		Record<
			"preparer" | "implementer" | "scout" | "reviewer" | "verifier",
			RoleSource
		>
	>;
	logFailure: (message: string, error: unknown) => void;
}
export async function prepareExecution(
	deps: ExecutionDeps,
	sourceRunId: string,
	input: ImplementRequest,
	options: ExecutionPreparation,
	signal: AbortSignal,
) {
	const { store } = deps;
	if (options.checks.length === 0)
		throw new ApplicationError(
			"invalid_request",
			"implement requires a nonempty [execution].checks suite",
		);
	if (!options.platformSupported)
		throw new ApplicationError(
			"execution_platform_unsupported",
			"writable execution requires POSIX process-group cleanup",
		);
	const implementer = options.roles.implementer;
	if (!options.allowUnconfiguredModel && !implementer?.model)
		throw new ApplicationError(
			"invalid_request",
			"implement requires [roles.implementer].model; configure the writer model before accepting execution",
		);
	if (!deps.workspace || !deps.checks)
		throw new ApplicationError(
			"execution_unavailable",
			"execution workspace and engine-check adapters are not configured",
		);
	if (!options.loadRoleSources)
		throw new ApplicationError(
			"execution_unavailable",
			"execution role-source loader is not configured",
		);
	let sources: Awaited<
		ReturnType<NonNullable<ExecutionPreparation["loadRoleSources"]>>
	>;
	let pinnedBase: string;
	const sourceEvents = await store.read(sourceRunId);
	if (sourceEvents.length === 0)
		throw new ApplicationError(
			"not_found",
			`source run ${sourceRunId} not found`,
		);
	const sourceState = fold(sourceEvents);
	try {
		pinnedBase = await deps.workspace.resolveBase(
			sourceState.repo,
			input.base ?? sourceState.baseBranch,
			signal,
		);
	} catch (error) {
		options.logFailure("cannot resolve execution base", error);
		const message = `cannot resolve execution base: ${error instanceof Error ? error.message : String(error)}`;
		// Without a caller base, the base is the stored run's server-side state, not bad input.
		throw input.base === undefined
			? new ApplicationError("execution_unavailable", message)
			: new ApplicationError("execution_base_unavailable", message);
	}
	try {
		sources = await options.loadRoleSources(sourceState.repo, pinnedBase);
	} catch (error) {
		options.logFailure("cannot load execution role sources", error);
		throw new ApplicationError(
			"execution_unavailable",
			`cannot load execution role sources: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const roleArtifacts = {
		preparer: await snapshotRole(store, sources.preparer),
		implementer: await snapshotRole(store, {
			...sources.implementer,
			addendum: QUALITY_EXPECTATIONS,
		}),
		scout: await snapshotRole(store, {
			...sources.scout,
			addendum: QUALITY_EXPECTATIONS,
		}),
		reviewer: await snapshotRole(store, {
			...sources.reviewer,
			addendum: QUALITY_EXPECTATIONS,
		}),
		verifier: await snapshotRole(store, {
			...sources.verifier,
			addendum: QUALITY_EXPECTATIONS,
		}),
	};
	const roleSettings = (role: PreparationRole | undefined) => ({
		model: role?.model ? `${role.model.provider}/${role.model.id}` : null,
		timeoutMs: role?.timeoutMs ?? 300_000,
	});
	const roleMap = {
		preparer: roleSettings(options.roles.verifier),
		implementer: roleSettings(implementer),
		scout: roleSettings(options.roles.verifier),
		reviewer: roleSettings(options.roles.reviewer),
		verifier: roleSettings(options.roles.verifier),
	};
	return beginExecution(
		deps,
		{
			sourceRunId,
			naming: input.naming,
			policy: options.publication,
			prId: input.prId,
			baseBranch: input.base,
			baseCommit: pinnedBase,
			explicitBase: input.base !== undefined,
			checks: options.checks,
			roles: roleMap,
			roleArtifacts,
			roleProvenance: Object.fromEntries(
				Object.entries(sources).map(([name, source]) => [
					name,
					{
						path: source.path,
						sha: source.sha,
					},
				]),
			),
			maxConcurrentAgents: options.maxConcurrentAgents,
		},
		signal,
	);
}

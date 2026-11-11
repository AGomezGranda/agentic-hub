import type {
	ExecutionNamingRequest,
	ImplementPreview,
	ImplementPreviewRequest,
	ImplementRequest,
	PlanRestoreRequest,
	PlanUpdateRequest,
	PlanVersionDetail,
	PublicationPreview,
	PublishRequest,
	ResumeRequest,
	RunEvent,
	RunReview,
	RunSummary,
	WorkCostTree,
	WorkItemRequest,
} from "@payo/contracts";
import {
	ExecutionRunConfig as ExecutionRunConfigSchema,
	PublicationRunConfig as PublicationRunConfigSchema,
} from "@payo/contracts";
import type {
	ExecutionDeps,
	ExecutionPreparation,
	PublicationDeps,
	StartInput,
} from "@payo/factory";
import {
	acceptPlanUpdate,
	answer as answerRun,
	approve as approveRun,
	assertChangeable,
	assertExecutionResumable,
	assertResumable,
	beginFactory,
	beginPublication,
	correctExecutionNaming,
	type ExecutionHandle,
	executeExecution,
	executeFactory,
	executePublication,
	type FactoryDeps,
	type FactoryHandle,
	findExistingExecution,
	openExecution,
	openFactory,
	openPublication,
	type PublicationHandle,
	prepareExecution,
	prepareExecutionResume,
	preparePublicationResume,
	previewExecutionNaming,
	previewPublication,
	readPlanVersion,
	readPlanVersions,
	readRunReview,
	readWorkCosts,
	requestChanges as requestChangesRun,
	resume as resumeRun,
} from "@payo/factory";
import type {
	CodeHost,
	RepositoryPublication,
	RunState,
	RunStore,
} from "@payo/kernel";
import { ApplicationError } from "./errors.ts";
import { readRunSummary } from "./run-summary.ts";

export interface RunApplication {
	implementPreview(
		sourceRunId: string,
		input: ImplementPreviewRequest,
	): Promise<ImplementPreview>;
	executionNaming(
		runId: string,
		input: ExecutionNamingRequest,
	): Promise<ImplementPreview>;
	implement(sourceRunId: string, input: ImplementRequest): Promise<string>;
	publicationPreview(executionId: string): Promise<PublicationPreview>;
	publish(executionId: string, input: PublishRequest): Promise<string>;
	summary(runId: string): Promise<RunSummary>;
	costs(runId: string): Promise<WorkCostTree>;
	review(runId: string): Promise<RunReview>;
	planVersions(runId: string): Promise<PlanVersionDetail[]>;
	planVersion(runId: string, number: number): Promise<PlanVersionDetail>;
	planUpdate(
		runId: string,
		input: PlanUpdateRequest | PlanRestoreRequest,
	): Promise<void>;
	listRuns(): Promise<RunSummary[]>;
	readEvents(runId: string, fromSeq?: number): Promise<RunEvent[]>;
	hasRun(runId: string): boolean;
	isActive(runId: string): boolean;
	start(input: {
		workItemRequest: WorkItemRequest;
		repo: string;
		baseBranch: string;
	}): Promise<string>;
	answer(
		runId: string,
		input: { questionId: string; text: string },
	): Promise<RunSummary>;
	approve(runId: string): Promise<RunSummary>;
	requestChanges(runId: string): Promise<void>;
	resume(runId: string, input?: ResumeRequest): Promise<void>;
}
export interface RunApplicationOptions {
	store: RunStore;
	ids: string[];
	states: ReadonlyMap<string, RunState>;
	depsForRun: () => FactoryDeps;
	executionDeps: () => ExecutionDeps;
	publication?: {
		repository: RepositoryPublication;
		codeHost: CodeHost;
	};
	roles: StartInput["roles"];
	preparation: ExecutionPreparation;
	maxConcurrentAgents: number;
	newId: () => string;
	track: <T>(work: () => Promise<T>) => Promise<T>;
	schedule: (work: (signal: AbortSignal) => Promise<unknown>) => void;
	withSignal: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
	isStopping: () => boolean;
	logFailure: (prefix: string, error: unknown) => void;
}
export async function createRunApplication(
	options: RunApplicationOptions,
): Promise<RunApplication> {
	const {
		store,
		ids,
		states,
		depsForRun,
		executionDeps,
		publication,
		roles,
		preparation,
		maxConcurrentAgents,
		newId,
		track,
		schedule,
		withSignal,
		isStopping,
		logFailure,
	} = options;
	const handles = new Map<string, FactoryHandle>();
	const executionHandles = new Map<string, ExecutionHandle>();
	const publicationHandles = new Map<string, PublicationHandle>();
	const summaryOf = (runId: string) =>
		readRunSummary(
			store,
			runId,
			handles.get(runId),
			executionHandles.get(runId),
			publicationHandles.get(runId),
		);
	const publicationDeps = (): PublicationDeps => {
		const deps = executionDeps();
		if (!publication || !deps.workspace)
			throw new ApplicationError(
				"execution_unavailable",
				"publication adapters are not configured",
			);
		return {
			store,
			newId,
			workspace: deps.workspace,
			repository: publication.repository,
			codeHost: publication.codeHost,
		};
	};
	for (const runId of ids) {
		try {
			const saved = states.get(runId);
			if (
				saved &&
				PublicationRunConfigSchema.safeParse(saved.config.factory).success
			)
				publicationHandles.set(
					runId,
					await openPublication(publicationDeps(), runId),
				);
			else if (
				saved &&
				ExecutionRunConfigSchema.safeParse(saved.config.factory).success
			)
				executionHandles.set(
					runId,
					await openExecution(executionDeps(), runId),
				);
			else handles.set(runId, await openFactory(depsForRun(), runId));
		} catch (error) {
			// One unrecoverable record must not block recovery of the others.
			logFailure(`could not recover run ${runId}`, error);
		}
	}

	function handleOf(runId: string): FactoryHandle {
		const handle = handles.get(runId);
		if (!handle)
			throw new ApplicationError("not_found", `run ${runId} not found`);
		return handle;
	}
	return {
		async implementPreview(sourceRunId, input) {
			const deps = executionDeps();
			if (!deps.workspace)
				throw new ApplicationError(
					"execution_unavailable",
					"execution workspace is not configured",
				);
			return withSignal((signal) =>
				previewExecutionNaming(
					{ store, workspace: deps.workspace! },
					sourceRunId,
					input,
					preparation.publication ?? {},
					signal,
				),
			);
		},
		async executionNaming(runId, input) {
			const handle = executionHandles.get(runId);
			if (!handle)
				throw new ApplicationError("not_found", `execution ${runId} not found`);
			return track(() =>
				withSignal((signal) => correctExecutionNaming(handle, input, signal)),
			);
		},
		async publicationPreview(executionId) {
			if (!executionHandles.has(executionId))
				throw new ApplicationError(
					"not_found",
					`execution ${executionId} not found`,
				);
			const deps = publicationDeps();
			return withSignal((signal) =>
				previewPublication(deps, executionId, signal),
			);
		},
		async publish(executionId, input) {
			if (isStopping())
				throw new ApplicationError("busy", "server is shutting down");
			if (!executionHandles.has(executionId))
				throw new ApplicationError(
					"not_found",
					`execution ${executionId} not found`,
				);
			const deps = publicationDeps();
			return track(() =>
				withSignal(async (signal) => {
					const { handle, created } = await beginPublication(
						deps,
						executionId,
						input,
						signal,
					);
					const publicationId = handle.log.current().runId;
					publicationHandles.set(publicationId, handle);
					if (created)
						schedule((signal) => executePublication(handle, { signal }));
					return publicationId;
				}),
			);
		},
		async summary(runId) {
			return summaryOf(runId);
		},
		async costs(runId) {
			const publication = publicationHandles.get(runId);
			if (publication)
				return readWorkCosts(
					store,
					PublicationRunConfigSchema.parse(
						publication.log.current().config.factory,
					).sourceRunId,
				);
			const execution = executionHandles.get(runId);
			const sourceRunId = execution
				? ExecutionRunConfigSchema.parse(execution.log.current().config.factory)
						.sourceRunId
				: runId;
			return readWorkCosts(store, sourceRunId);
		},

		async review(runId) {
			return readRunReview(handleOf(runId));
		},

		async planVersions(runId) {
			return readPlanVersions(handleOf(runId));
		},
		async planVersion(runId, number) {
			return readPlanVersion(handleOf(runId), number);
		},
		async planUpdate(runId, input) {
			if (isStopping())
				throw new ApplicationError("busy", "server is shutting down");
			const handle = handleOf(runId);
			await track(() => acceptPlanUpdate(handle, input));
			schedule((signal) => executeFactory(handle, { signal }));
		},

		async listRuns() {
			const summaries = await Promise.all(
				[
					...new Set([
						...handles.keys(),
						...executionHandles.keys(),
						...publicationHandles.keys(),
					]),
				].map((runId) =>
					summaryOf(runId).catch((error) => {
						logFailure(`skipping unreadable run ${runId} in list`, error);
						return null;
					}),
				),
			);
			return summaries
				.filter((run): run is RunSummary => run !== null)
				.sort(
					(a, b) =>
						b.startedAt.localeCompare(a.startedAt) ||
						b.runId.localeCompare(a.runId),
				);
		},

		async readEvents(runId, fromSeq) {
			if (
				!handles.has(runId) &&
				!executionHandles.has(runId) &&
				!publicationHandles.has(runId)
			)
				throw new ApplicationError("not_found", `run ${runId} not found`);
			return store.read(runId, fromSeq);
		},

		hasRun(runId) {
			return (
				handles.has(runId) ||
				executionHandles.has(runId) ||
				publicationHandles.has(runId)
			);
		},

		isActive(runId) {
			return (
				(
					handles.get(runId) ??
					executionHandles.get(runId) ??
					publicationHandles.get(runId)
				)?.log.current().status === "active"
			);
		},

		async implement(sourceRunId, input) {
			if (isStopping())
				throw new ApplicationError("busy", "server is shutting down");
			return track(() =>
				withSignal(async (signal) => {
					const deps = executionDeps();
					const existing = await findExistingExecution(deps, {
						sourceRunId,
						prId: input.prId,
						naming: input.naming,
						baseBranch: input.base,
						explicitBase: input.base !== undefined,
					});
					if (existing) {
						const runId = existing.log.current().runId;
						if (!executionHandles.has(runId))
							executionHandles.set(runId, existing);
						return runId;
					}
					const handle = await prepareExecution(
						deps,
						sourceRunId,
						input,
						preparation,
						signal,
					);
					const runId = handle.log.current().runId;
					if (executionHandles.has(runId)) return runId;
					executionHandles.set(runId, handle);
					schedule((signal) => executeExecution(handle, { signal }));
					return runId;
				}),
			);
		},

		async start(input) {
			if (isStopping())
				throw new ApplicationError("busy", "server is shutting down");
			return track(async () => {
				const runId = newId();
				const handle = await beginFactory(depsForRun(), {
					runId,
					workItemRequest: input.workItemRequest,
					repo: input.repo,
					baseBranch: input.baseBranch,
					roles,
					maxConcurrentAgents,
				});
				handles.set(runId, handle);
				schedule((signal) => executeFactory(handle, { signal }));
				return runId;
			});
		},

		async answer(runId, input) {
			const handle = handleOf(runId);
			if (handle.busy)
				throw new ApplicationError("busy", "factory command busy");
			await track(() => answerRun(handle, input));
			return summaryOf(runId);
		},

		async approve(runId) {
			const handle = handleOf(runId);
			if (handle.busy)
				throw new ApplicationError("busy", "factory command busy");
			await track(() => approveRun(handle));
			return summaryOf(runId);
		},

		async requestChanges(runId) {
			const handle = handleOf(runId);
			assertChangeable(handle);
			schedule((signal) => requestChangesRun(handle, { signal }));
		},

		async resume(runId, input = {}) {
			const publication = publicationHandles.get(runId);
			if (publication) {
				if (input.answers !== undefined)
					throw new ApplicationError(
						"invalid_request",
						"Issue answers are not valid for a publication run",
					);
				await track(() => preparePublicationResume(publication));
				if (!isStopping())
					schedule((signal) => executePublication(publication, { signal }));
				return;
			}
			const execution = executionHandles.get(runId);
			if (execution) {
				assertExecutionResumable(execution);
				await withSignal(async (signal) => {
					await track(() =>
						prepareExecutionResume(execution, { signal, ...input }),
					);
					if (!isStopping())
						schedule((signal) => executeExecution(execution, { signal }));
				});
				return;
			}
			if (input.answers !== undefined)
				throw new ApplicationError(
					"invalid_request",
					"Issue answers require an execution run",
				);
			const handle = handleOf(runId);
			assertResumable(handle);
			schedule((signal) => resumeRun(handle, { signal }));
		},
	};
}

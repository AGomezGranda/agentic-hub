import { randomUUID } from "node:crypto";
import type {
	DoctorReport,
	ImplementRequest,
	PlanRestoreRequest,
	PlanUpdateRequest,
	PlanVersionDetail,
	RunEvent,
	RunReview,
	RunSummary,
	WorkItemRequest,
} from "@payo/contracts";
import {
	ExecutionRunConfig as ExecutionRunConfigSchema,
	FactoryRunConfig as FactoryRunConfigSchema,
} from "@payo/contracts";
import {
	acceptPlanUpdate,
	answer as answerRun,
	approve as approveRun,
	assertChangeable,
	assertExecutionResumable,
	assertResumable,
	beginExecution,
	beginFactory,
	type ExecutionHandle,
	executeExecution,
	executeFactory,
	type FactoryDeps,
	type FactoryHandle,
	findExistingExecution,
	openExecution,
	openFactory,
	QUALITY_EXPECTATIONS,
	readExecutionSummary,
	readPlanVersion,
	readPlanVersions,
	readRunReview,
	requestChanges as requestChangesRun,
	resumeExecution,
	resume as resumeRun,
	snapshotRole,
} from "@payo/factory";
import {
	createLimiter,
	fold,
	type Limiter,
	type RunState,
	type RunStore,
} from "@payo/kernel";
import { createSqliteRunStore } from "@payo/store-sqlite";
import type { AdapterSet } from "./adapters.ts";
import { createAdapterSet } from "./adapters.ts";
import type { ServerConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { ApiFailure, busy, notFound } from "./errors.ts";

export interface Composition {
	readonly config: ServerConfig;
	readonly store: RunStore;
	implement(sourceRunId: string, input: ImplementRequest): Promise<string>;
	summary(runId: string): Promise<RunSummary>;
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
	resume(runId: string): Promise<void>;
	doctor(): Promise<DoctorReport>;
	waitForIdle(): Promise<void>;
	shutdown(): Promise<void>;
}

/** Effective ceiling is the configured value capped by every active run's recorded value. */
export function effectiveConcurrency(
	configured: number,
	activeLimits: ReadonlyArray<number | undefined>,
): number {
	const recorded = activeLimits.filter(
		(value): value is number =>
			typeof value === "number" && Number.isInteger(value) && value >= 1,
	);
	return recorded.length ? Math.min(configured, ...recorded) : configured;
}

function recordedLimit(state: RunState): number | undefined {
	const factory = state.config.factory as
		| { maxConcurrentAgents?: unknown }
		| undefined;
	const value = factory?.maxConcurrentAgents;
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? value
		: undefined;
}

export interface CompositionOptions {
	config: ServerConfig;
	store?: RunStore;
	adapters?: AdapterSet;
	doctor?: () => Promise<DoctorReport>;
}

function runRole(role: ServerConfig["roles"]["planner"]) {
	return {
		model: role.model ? `${role.model.provider}/${role.model.id}` : null,
		timeoutMs: role.timeoutMs,
	};
}

export async function createComposition(
	options: CompositionOptions,
): Promise<Composition> {
	const { config } = options;
	if (config.scenario !== null && !config.devFakes)
		throw new Error("fake scenarios require --dev-fakes");
	const store =
		options.store ?? (await createSqliteRunStore({ dataDir: config.dataDir }));
	let adapters: AdapterSet;
	try {
		adapters = options.adapters ?? (await createAdapterSet(config, store));
	} catch (error) {
		await store.close().catch(() => {});
		throw error;
	}
	const doctor = options.doctor ?? (() => runDoctor(config));
	const roles = {
		planner: runRole(config.roles.planner),
		reviewer: runRole(config.roles.reviewer),
		verifier: runRole(config.roles.verifier),
		reviser: runRole(config.roles.reviser),
	};
	const handles = new Map<string, FactoryHandle>();
	const executionHandles = new Map<string, ExecutionHandle>();
	const tasks = new Set<Promise<unknown>>();
	const controllers = new Set<AbortController>();
	let stopping = false;

	const ids = await store.listRunIds();
	const states = new Map<string, RunState>();
	for (const runId of ids) {
		try {
			states.set(runId, fold(await store.read(runId)));
		} catch (error) {
			logFailure(`skipping unreadable run ${runId}`, error);
		}
	}
	const activeLimits = [...states.values()]
		.filter((state) => state.status === "active")
		.map(recordedLimit);
	const cap = effectiveConcurrency(config.maxConcurrentAgents, activeLimits);
	const limiter: Limiter = createLimiter(cap);

	const depsForRun = (): FactoryDeps => ({
		store,
		runner: adapters.runner(),
		limiter,
		workItems: adapters.workItems,
		workspace: adapters.workspace,
		dataDir: config.dataDir,
		roleSources: adapters.roleSources,
	});
	const executionDeps = () => ({
		store,
		runner: (adapters.executionRunner ?? adapters.runner)(),
		limiter,
		workspace: adapters.executionWorkspace,
		checks: adapters.checks,
		dataDir: config.dataDir,
		loadReviewRoleSnapshots: async (
			sourceRunId: string,
			pinnedBase: string,
		) => {
			if (!adapters.loadExecutionRoleSources)
				throw new Error("execution role-source loader is not configured");
			const sourceEvents = await store.read(sourceRunId);
			if (sourceEvents.length === 0)
				throw new Error(`source run ${sourceRunId} not found`);
			const sourceState = fold(sourceEvents);
			const sourceConfig = FactoryRunConfigSchema.parse(
				sourceState.config.factory,
			);
			const sources = await adapters.loadExecutionRoleSources(
				sourceState.repo,
				pinnedBase,
			);
			const settings = (role: "reviewer" | "verifier") => ({
				model: sourceConfig.roles[role].model,
				timeoutMs: sourceConfig.roles[role].timeoutMs,
			});
			return {
				roleArtifacts: {
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
				},
				roles: {
					scout: settings("verifier"),
					reviewer: settings("reviewer"),
					verifier: settings("verifier"),
				},
			};
		},
	});

	for (const runId of ids) {
		try {
			const saved = states.get(runId);
			if (
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
		if (!handle) throw notFound(`run ${runId} not found`);
		return handle;
	}

	function track<T>(work: () => Promise<T>): Promise<T> {
		const promise = work();
		tasks.add(promise);
		void promise
			.finally(() => {
				tasks.delete(promise);
			})
			.catch(() => {});
		return promise;
	}

	function schedule(work: (signal: AbortSignal) => Promise<unknown>): void {
		const controller = new AbortController();
		controllers.add(controller);
		const promise = track(() => work(controller.signal));
		void promise
			.catch((error) => {
				if (!stopping) logFailure("background command failed", error);
			})
			.finally(() => {
				controllers.delete(controller);
			});
	}

	async function summaryOf(runId: string): Promise<RunSummary> {
		const factory = handles.get(runId);
		const execution = executionHandles.get(runId);
		if (!factory && !execution) throw notFound(`run ${runId} not found`);
		const state = (factory ?? execution)?.log.current();
		if (!state) throw notFound(`run ${runId} not found`);
		const events = await store.read(runId);
		const first = events[0]?.at;
		const last = events.at(-1)?.at;
		if (!first || !last) throw notFound(`run ${runId} not found`);
		const workItem = factory?.checkpoint.workItem;
		const executionSummary = execution
			? await readExecutionSummary(execution)
			: undefined;
		return {
			runId,
			repo: state.repo,
			baseBranch: state.baseBranch,
			status: state.status,
			outcome: state.outcome,
			stage: execution?.checkpoint.stage ?? factory?.checkpoint.stage ?? null,
			workItem: workItem
				? {
						source: workItem.origin.source,
						title: workItem.title,
						key: workItem.origin.source === "jira" ? workItem.origin.key : null,
					}
				: null,
			startedAt: first,
			updatedAt: last,
			openGates: [...state.gates.values()]
				.filter((gate) => gate.status === "open")
				.map((gate) => ({
					gateId: gate.gateId,
					stepId: gate.stepId,
					kind: gate.kind,
					allowedCommands: [...gate.allowedCommands],
					reason: gate.reason,
				})),
			...(executionSummary ? { execution: executionSummary } : {}),
		};
	}

	async function waitForIdle(): Promise<void> {
		while (tasks.size > 0) {
			await Promise.allSettled([...tasks]);
		}
	}

	return {
		config,
		store,

		async summary(runId) {
			return summaryOf(runId);
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
			if (stopping) throw busy("server is shutting down");
			const handle = handleOf(runId);
			await track(() => acceptPlanUpdate(handle, input));
			schedule((signal) => executeFactory(handle, { signal }));
		},

		async listRuns() {
			const summaries = await Promise.all(
				[...new Set([...handles.keys(), ...executionHandles.keys()])].map(
					(runId) => summaryOf(runId).catch(() => null),
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
			if (!handles.has(runId) && !executionHandles.has(runId))
				throw notFound(`run ${runId} not found`);
			return store.read(runId, fromSeq);
		},

		hasRun(runId) {
			return handles.has(runId) || executionHandles.has(runId);
		},

		isActive(runId) {
			return (
				(handles.get(runId) ?? executionHandles.get(runId))?.log.current()
					.status === "active"
			);
		},

		async implement(sourceRunId, input) {
			if (stopping) throw busy("server is shutting down");
			const deps = executionDeps();
			const existing = await findExistingExecution(deps, {
				sourceRunId,
				prId: input.prId,
				baseBranch: input.base,
				explicitBase: input.base !== undefined,
			});
			if (existing) {
				const runId = existing.log.current().runId;
				if (!executionHandles.has(runId)) executionHandles.set(runId, existing);
				return runId;
			}
			if (config.checks.length === 0)
				throw new ApiFailure(
					400,
					"invalid_request",
					"implement requires a nonempty [execution].checks suite",
				);
			if (process.platform === "win32")
				throw new ApiFailure(
					400,
					"execution_unavailable",
					"writable execution requires POSIX process-group cleanup",
				);
			const implementer = config.roles.implementer;
			if (!config.devFakes && !implementer?.model)
				throw new ApiFailure(
					400,
					"invalid_request",
					"implement requires [roles.implementer].model; configure the writer model before accepting execution",
				);
			if (!adapters.executionWorkspace || !adapters.checks)
				throw new ApiFailure(
					503,
					"execution_unavailable",
					"execution workspace and engine-check adapters are not configured",
				);
			if (!adapters.loadExecutionRoleSources)
				throw new ApiFailure(
					503,
					"execution_unavailable",
					"execution role-source loader is not configured",
				);
			let sources: Awaited<
				ReturnType<NonNullable<AdapterSet["loadExecutionRoleSources"]>>
			>;
			let pinnedBase: string;
			const sourceEvents = await store.read(sourceRunId);
			if (sourceEvents.length === 0)
				throw notFound(`source run ${sourceRunId} not found`);
			const sourceState = fold(sourceEvents);
			try {
				pinnedBase = await adapters.executionWorkspace.resolveBase(
					sourceState.repo,
					input.base ?? sourceState.baseBranch,
					new AbortController().signal,
				);
				sources = await adapters.loadExecutionRoleSources(
					sourceState.repo,
					pinnedBase,
				);
			} catch (error) {
				throw new ApiFailure(
					400,
					"execution_roles_unavailable",
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
			const roleSettings = (
				role: ServerConfig["roles"]["planner"] | undefined,
			) => ({
				model: role?.model ? `${role.model.provider}/${role.model.id}` : null,
				timeoutMs: role?.timeoutMs ?? 300_000,
			});
			const roleMap = {
				preparer: roleSettings(config.roles.verifier),
				implementer: roleSettings(implementer),
				scout: roleSettings(config.roles.verifier),
				reviewer: roleSettings(config.roles.reviewer),
				verifier: roleSettings(config.roles.verifier),
			};
			const handle = await beginExecution(deps, {
				sourceRunId,
				prId: input.prId,
				baseBranch: input.base,
				baseCommit: pinnedBase,
				explicitBase: input.base !== undefined,
				checks: config.checks,
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
				maxConcurrentAgents: cap,
			});
			const runId = handle.log.current().runId;
			if (executionHandles.has(runId)) return runId;
			executionHandles.set(runId, handle);
			schedule((signal) => executeExecution(handle, { signal }));
			return runId;
		},

		async start(input) {
			if (stopping) throw busy("server is shutting down");
			const runId = randomUUID();
			const handle = await beginFactory(depsForRun(), {
				runId,
				workItemRequest: input.workItemRequest,
				repo: input.repo,
				baseBranch: input.baseBranch,
				roles,
				maxConcurrentAgents: cap,
			});
			handles.set(runId, handle);
			schedule((signal) => executeFactory(handle, { signal }));
			return runId;
		},

		async answer(runId, input) {
			const handle = handleOf(runId);
			if (handle.busy) throw busy("factory command busy");
			await track(() => answerRun(handle, input));
			return summaryOf(runId);
		},

		async approve(runId) {
			const handle = handleOf(runId);
			if (handle.busy) throw busy("factory command busy");
			await track(() => approveRun(handle));
			return summaryOf(runId);
		},

		async requestChanges(runId) {
			const handle = handleOf(runId);
			assertChangeable(handle);
			schedule((signal) => requestChangesRun(handle, { signal }));
		},

		async resume(runId) {
			const execution = executionHandles.get(runId);
			if (execution) {
				assertExecutionResumable(execution);
				schedule((signal) => resumeExecution(execution, { signal }));
				return;
			}
			const handle = handleOf(runId);
			assertResumable(handle);
			schedule((signal) => resumeRun(handle, { signal }));
		},

		async doctor() {
			return doctor();
		},

		waitForIdle,

		async shutdown() {
			stopping = true;
			for (const controller of controllers) controller.abort();
			await waitForIdle();
			await store.close();
		},
	};
}

function logFailure(prefix: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`payo: ${prefix}: ${message}`);
}

import { randomUUID } from "node:crypto";
import type { DoctorReport } from "@payo/contracts";
import { FactoryRunConfig as FactoryRunConfigSchema } from "@payo/contracts";
import {
	type FactoryDeps,
	QUALITY_EXPECTATIONS,
	readPlan,
	snapshotRole,
	validatePublicationPolicy,
	writePlan,
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
import {
	createRunApplication,
	type RunApplication,
} from "./run-application.ts";

export interface Composition extends RunApplication {
	readonly config: ServerConfig;
	readonly store: RunStore;
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
	validatePublicationPolicy(config.publication);
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
		newId: randomUUID,
		store,
		runner: adapters.runner(),
		limiter,
		workItems: adapters.workItems,
		workspace: adapters.workspace,
		dataDir: config.dataDir,
		readPlan: (runId) => readPlan(config.dataDir, runId),
		writePlan: (runId, markdown) => writePlan(config.dataDir, runId, markdown),
		roleSources: adapters.roleSources,
	});
	const executionDeps = () => ({
		newId: randomUUID,
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
		if (stopping) return;
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

	async function waitForIdle(): Promise<void> {
		while (tasks.size > 0) {
			await Promise.allSettled([...tasks]);
		}
	}

	const application = await createRunApplication({
		store,
		ids,
		states,
		depsForRun,
		executionDeps,
		publication:
			adapters.repository && adapters.codeHost
				? {
						repository: adapters.repository,
						codeHost: adapters.codeHost,
					}
				: undefined,
		roles,
		preparation: {
			publication: config.publication,
			checks: config.checks,
			roles: config.roles,
			allowUnconfiguredModel: config.devFakes,
			platformSupported: process.platform !== "win32",
			maxConcurrentAgents: cap,
			loadRoleSources: adapters.loadExecutionRoleSources,
			logFailure,
		},
		maxConcurrentAgents: cap,
		newId: randomUUID,
		track,
		schedule,
		async withSignal(work) {
			const controller = new AbortController();
			controllers.add(controller);
			try {
				return await work(controller.signal);
			} finally {
				controllers.delete(controller);
			}
		},
		isStopping: () => stopping,
		logFailure,
	});
	return {
		...application,
		config,
		store,
		doctor,
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
	const message =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	console.error(`payo: ${prefix}: ${message}`);
}

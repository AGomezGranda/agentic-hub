import { randomUUID } from "node:crypto";
import type {
	DoctorReport,
	FactoryStage,
	RunEvent,
	RunSummary,
} from "@payo/contracts";
import {
	answer as answerRun,
	approve as approveRun,
	assertChangeable,
	assertResumable,
	beginFactory,
	executeFactory,
	type FactoryDeps,
	type FactoryHandle,
	openFactory,
	requestChanges as requestChangesRun,
	resume as resumeRun,
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
import { busy, notFound } from "./errors.ts";

export interface Composition {
	readonly config: ServerConfig;
	readonly store: RunStore;
	summary(runId: string): Promise<RunSummary>;
	listRuns(): Promise<RunSummary[]>;
	readEvents(runId: string, fromSeq?: number): Promise<RunEvent[]>;
	hasRun(runId: string): boolean;
	isActive(runId: string): boolean;
	start(input: {
		ticketKey: string;
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

export async function createComposition(
	options: CompositionOptions,
): Promise<Composition> {
	const { config } = options;
	if (config.scenario !== null && !config.devFakes)
		throw new Error("fake scenarios require --dev-fakes");
	const adapters = options.adapters ?? (await createAdapterSet(config));
	const doctor = options.doctor ?? (() => runDoctor(config));
	const roles = {
		planner: { model: config.model, timeoutMs: 120_000 },
		reviewer: { model: config.model, timeoutMs: 120_000 },
		verifier: { model: config.model, timeoutMs: 120_000 },
		reviser: { model: config.model, timeoutMs: 120_000 },
	};
	const store =
		options.store ?? (await createSqliteRunStore({ dataDir: config.dataDir }));
	const handles = new Map<string, FactoryHandle>();
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
		tickets: adapters.tickets,
		workspace: adapters.workspace,
		dataDir: config.dataDir,
		roleSources: adapters.roleSources,
	});

	for (const runId of ids) {
		try {
			handles.set(runId, await openFactory(depsForRun(), runId));
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
		const handle = handleOf(runId);
		const state = handle.log.current();
		const events = await store.read(runId);
		const first = events[0]?.at;
		const last = events.at(-1)?.at;
		if (!first || !last) throw notFound(`run ${runId} not found`);
		return {
			runId,
			repo: state.repo,
			baseBranch: state.baseBranch,
			status: state.status,
			outcome: state.outcome,
			stage: handle.checkpoint.stage as FactoryStage,
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

		async listRuns() {
			const summaries = await Promise.all(
				[...handles.keys()].map((runId) => summaryOf(runId).catch(() => null)),
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
			if (!handles.has(runId)) throw notFound(`run ${runId} not found`);
			return store.read(runId, fromSeq);
		},

		hasRun(runId) {
			return handles.has(runId);
		},

		isActive(runId) {
			return handles.get(runId)?.log.current().status === "active";
		},

		async start(input) {
			if (stopping) throw busy("server is shutting down");
			const runId = randomUUID();
			const handle = await beginFactory(depsForRun(), {
				runId,
				ticketKey: input.ticketKey,
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

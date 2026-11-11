import {
	type ArtifactRef,
	type FactoryCheckpoint,
	FactoryRunConfig,
	PlanVersion,
	type RunEventBody,
	WorkItemRequest,
} from "@payo/contracts";
import { commit, openRun, openRunLog } from "@payo/kernel";
import { loadCheckpoint, readArtifact, storeCheckpoint } from "../artifacts.ts";
import { renderAnswers, validateRunId } from "../plans.ts";
import { QUALITY_EXPECTATIONS } from "../quality.ts";
import { lenses, snapshotRole } from "../roles.ts";
import {
	createFactoryHandle,
	type FactoryDeps,
	type FactoryHandle,
	type MutableFactoryHandle,
	mutableFactoryHandle,
	required,
	type StartInput,
} from "../types.ts";
import {
	busy,
	checkpoint,
	conflict,
	hash,
	savePlan,
	version,
} from "./checkpoint.ts";
import { run } from "./run.ts";

/** Persists the run and its initial checkpoint atomically, without starting any agent work. */
export async function beginFactory(
	deps: FactoryDeps,
	input: Omit<StartInput, "signal">,
): Promise<FactoryHandle> {
	validateRunId(input.runId);
	const roleArtifacts: Record<string, ArtifactRef> = {};
	for (const [role, source] of Object.entries(deps.roleSources))
		roleArtifacts[role] = await snapshotRole(deps.store, {
			...source,
			addendum: QUALITY_EXPECTATIONS,
		});
	const request = WorkItemRequest.parse(input.workItemRequest);
	const promptArtifact =
		request.source === "prompt"
			? await deps.store.putArtifact(new TextEncoder().encode(request.text), {
					kind: "factory-work-item-request-v1",
					mediaType: "text/plain",
				})
			: null;
	const workItemRequest =
		request.source === "prompt"
			? {
					source: "prompt" as const,
					artifact: required(promptArtifact, "prompt artifact"),
				}
			: request;
	const config = FactoryRunConfig.parse({
		workItemRequest,
		roles: input.roles,
		maxConcurrentAgents: input.maxConcurrentAgents,
		roleArtifacts,
		lenses: Object.keys(lenses),
		roleProvenance: Object.fromEntries(
			Object.entries(deps.roleSources).map(([role, source]) => [
				role,
				{ path: source.path, sha: source.sha },
			]),
		),
	});
	const checkpoint: FactoryCheckpoint = {
		revision: 0,
		stage: "ResolveWorkItem",
		cycle: 1,
		round: 0,
		workItem: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
		pendingPlanUpdate: null,
		inFlight: null,
	};
	const state = await commit(deps.store, null, [
		{
			type: "run.created",
			runId: input.runId,
			repo: input.repo,
			baseBranch: input.baseBranch,
			config: { factory: config },
		},
		...Object.values(roleArtifacts).map((artifact) => ({
			type: "artifact.recorded" as const,
			artifact,
			attemptId: null,
		})),
		...(promptArtifact
			? [
					{
						type: "artifact.recorded" as const,
						artifact: promptArtifact,
						attemptId: null,
					},
				]
			: []),
		await storeCheckpoint(deps.store, checkpoint),
	]);
	return createFactoryHandle({
		deps,
		log: openRunLog(deps.store, state),
		busy: false,
		roleArtifacts,
		checkpoint,
	});
}

/** Runs the state machine for a handle created by `beginFactory` or `openFactory`. */

export async function executeFactory(
	handle: FactoryHandle,
	input: { signal: AbortSignal },
): Promise<FactoryHandle> {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	state.busy = true;
	try {
		await run(state, input.signal);
		return handle;
	} finally {
		state.busy = false;
	}
}

export async function start(
	deps: FactoryDeps,
	input: StartInput,
): Promise<FactoryHandle> {
	const handle = await beginFactory(deps, input);
	return executeFactory(handle, { signal: input.signal });
}

export async function openFactory(
	deps: FactoryDeps,
	runId: string,
): Promise<FactoryHandle> {
	validateRunId(runId);
	const state = await openRun(deps.store, runId);
	const current = await loadCheckpoint(
		deps.store,
		await deps.store.read(runId),
	);
	const config = FactoryRunConfig.parse(state.config.factory);
	const handle: MutableFactoryHandle = {
		deps,
		log: openRunLog(deps.store, state),
		checkpoint: current,
		roleArtifacts: config.roleArtifacts,
		busy: false,
	};
	// Any active nonterminal run must expose a command to continue it, even when a
	// crash landed between a stage transition and the next operation marker.
	const openGate = [...handle.log.current().gates.values()].some(
		(gate) => gate.status === "open",
	);
	if (
		state.status === "active" &&
		!(current.stage === "Escalated" && current.inFlight) &&
		(current.inFlight || !openGate)
	) {
		const stepId = handle.deps.newId();
		const operation = current.inFlight ?? {
			stage: current.stage,
			stepIds: [],
		};
		await checkpoint(
			handle,
			{
				stage: "Escalated",
				inFlight: {
					...operation,
					stepIds: [...operation.stepIds, stepId],
				},
			},
			[
				{ type: "step.started", stepId, name: "factory recovery" },
				{
					type: "gate.raised",
					gateId: `factory:${stepId}`,
					stepId,
					kind: "factory-escalation",
					allowedCommands: ["resume"],
					reason: "interrupted factory operation",
				},
				{ type: "step.finished", stepId, outcome: "escalated" },
			],
		);
	}
	return createFactoryHandle(handle);
}

export function assertResumable(handle: FactoryHandle): void {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	if (state.checkpoint.stage !== "Escalated" || !state.checkpoint.inFlight)
		throw conflict("run is not resumable");
	const owned = new Set(state.checkpoint.inFlight.stepIds);
	for (const gate of state.log.current().gates.values())
		if (gate.status === "open" && !owned.has(gate.stepId))
			throw conflict(`unrelated open gate ${gate.gateId}`);
}

export async function resume(
	handle: FactoryHandle,
	input: { signal: AbortSignal },
): Promise<FactoryHandle> {
	assertResumable(handle);
	const state = mutableFactoryHandle(handle);
	state.busy = true;
	try {
		const marker = required(state.checkpoint.inFlight, "in-flight operation");
		const owned = new Set(marker.stepIds);
		const events: RunEventBody[] = [];
		for (const gate of state.log.current().gates.values()) {
			if (gate.status !== "open" || !owned.has(gate.stepId)) continue;
			events.push({
				type: "gate.resolved",
				gateId: gate.gateId,
				command: gate.kind === "factory-escalation" ? "resume" : "retry",
				note: null,
			});
		}
		for (const stepId of owned)
			if (state.log.current().steps.get(stepId)?.status === "running")
				events.push({ type: "step.finished", stepId, outcome: "failed" });
		const stage = marker.stage;
		if (state.checkpoint.pendingPlanUpdate) {
			const pending = state.checkpoint.pendingPlanUpdate;
			const markdown = await state.deps.readPlan(state.log.current().runId);
			const savedResult = pending.result
				? PlanVersion.parse(
						JSON.parse(
							new TextDecoder().decode(
								await readArtifact(state.deps.store, pending.result),
							),
						),
					)
				: null;
			if (
				hash(markdown) !== pending.expectedWorkingCopyHash &&
				markdown !== savedResult?.plan.markdown
			) {
				const current = await version(state);
				const answered =
					current.source === "answer" &&
					state.checkpoint.plan?.sha256 !== pending.base.sha256 &&
					state.checkpoint.plan?.sha256 !== pending.result?.sha256;
				const basis = answered ? current : (savedResult ?? current);
				const answers = answered
					? state.checkpoint.answers
					: (savedResult?.answers ?? state.checkpoint.answers);
				const saved = await savePlan(
					state,
					{ ...basis.plan, markdown: renderAnswers(markdown, answers) },
					"human",
					answers,
				);
				await checkpoint(
					state,
					{
						stage: "PlanReview",
						plan: saved.ref,
						answers,
						pendingPlanUpdate: {
							...pending,
							result: saved.ref,
							expectedWorkingCopyHash: hash(markdown),
						},
						inFlight: null,
					},
					[...events, ...saved.events],
				);
			} else {
				await checkpoint(state, { stage, inFlight: null }, events);
			}
		} else if (
			state.checkpoint.plan &&
			(stage === "PlanReview" || stage === "Revise")
		) {
			let markdown: string;
			try {
				markdown = await state.deps.readPlan(state.log.current().runId);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				markdown = (await version(state)).plan.markdown;
			}
			const plan = {
				...(await version(state)).plan,
				markdown: renderAnswers(markdown, state.checkpoint.answers),
			};
			const saved = await savePlan(state, plan, "human");
			events.push(...saved.events);
			await checkpoint(
				state,
				{
					stage: "PlanReview",
					plan: saved.ref,
					cycle: state.checkpoint.cycle + 1,
					round: 1,
					inFlight: null,
				},
				events,
			);
		} else
			await checkpoint(
				state,
				{ stage, cycle: state.checkpoint.cycle + 1, inFlight: null },
				events,
			);
		await run(state, input.signal);
		return handle;
	} finally {
		state.busy = false;
	}
}

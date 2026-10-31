import { randomUUID } from "node:crypto";
import {
	type AgentInput,
	type ArtifactRef,
	FactoryCheckpoint,
	FactoryRunConfig,
	jsonEnvelope,
	PlanOutput,
	PlanVersion,
	RevisionOutput,
	type RunEventBody,
	Ticket,
} from "@payo/contracts";
import { commit, openRun, openRunLog, runAgentStep } from "@payo/kernel";
import { readArtifact, savePlanVersion, storeCheckpoint } from "./artifacts.ts";
import { CommandError } from "./errors.ts";
import { approvalDiff } from "./metrics.ts";
import { readPlan, renderAnswers, validateRunId, writePlan } from "./plans.ts";
import { review } from "./review.ts";
import { lenses, roleSpec, snapshotRole } from "./roles.ts";
import { loadCheckpoint } from "./state.ts";
import {
	createFactoryHandle,
	type FactoryDeps,
	type FactoryHandle,
	type MutableFactoryHandle,
	mutableFactoryHandle,
	required,
	type StartInput,
} from "./types.ts";

const id = () => randomUUID();
const refOf = (event: RunEventBody): ArtifactRef => {
	if (event.type !== "artifact.recorded") throw new Error("artifact expected");
	return event.artifact;
};
const busy = () => new CommandError(409, "busy", "factory command busy");
const conflict = (message: string) =>
	new CommandError(409, "conflict", message);
const invalid = (message: string) =>
	new CommandError(400, "invalid_request", message);
const configOf = (handle: MutableFactoryHandle) =>
	FactoryRunConfig.parse(handle.log.current().config.factory);

async function checkpoint(
	handle: MutableFactoryHandle,
	update: Partial<FactoryCheckpoint>,
	events: RunEventBody[] = [],
) {
	const next = FactoryCheckpoint.parse({
		...handle.checkpoint,
		...update,
		revision: handle.checkpoint.revision + 1,
	});
	const end = events.find((event) => event.type === "run.ended");
	await handle.log.write([
		...events.filter((event) => event.type !== "run.ended"),
		await storeCheckpoint(handle.deps.store, next),
		...(end ? [end] : []),
	]);
	handle.checkpoint = next;
}
async function marker(
	handle: MutableFactoryHandle,
	stage: FactoryCheckpoint["stage"],
	stepIds: string[],
) {
	await checkpoint(handle, { stage, inFlight: { stage, stepIds } });
}
async function artifact(
	handle: MutableFactoryHandle,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	return handle.deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(value)),
		{ kind, mediaType: "application/json" },
	);
}
async function version(handle: MutableFactoryHandle): Promise<PlanVersion> {
	if (!handle.checkpoint.plan) throw new Error("missing plan");
	return PlanVersion.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(handle.deps.store, handle.checkpoint.plan),
			),
		),
	);
}
async function savePlan(
	handle: MutableFactoryHandle,
	plan: PlanOutput,
	source: "agent" | "human" | "answer",
	answers = handle.checkpoint.answers,
) {
	const events = await savePlanVersion(handle.deps.store, {
		number:
			(await handle.deps.store.read(handle.log.current().runId)).filter(
				(e) =>
					e.type === "artifact.recorded" &&
					e.artifact.kind === "factory-plan-version-v1",
			).length + 1,
		source,
		plan,
		answers,
	});
	const ref = refOf(required(events[1], "plan version"));
	return { events, ref };
}
async function pause(handle: MutableFactoryHandle, reason: string) {
	const stepId = id();
	const operation = handle.checkpoint.inFlight;
	if (!operation) throw new Error("missing in-flight operation");
	await checkpoint(
		handle,
		{
			stage: "Escalated",
			inFlight: { ...operation, stepIds: [...operation.stepIds, stepId] },
		},
		[
			{ type: "step.started", stepId, name: "factory escalation" },
			{
				type: "gate.raised",
				gateId: `factory:${stepId}`,
				stepId,
				kind: "factory-escalation",
				allowedCommands: ["resume"],
				reason,
			},
			{ type: "step.finished", stepId, outcome: "escalated" },
		],
	);
	if (handle.checkpoint.plan)
		await writePlan(
			handle.deps.dataDir,
			handle.log.current().runId,
			(await version(handle)).plan.markdown,
		);
}
async function run(handle: MutableFactoryHandle, signal: AbortSignal) {
	const { deps, log } = handle;
	const config = configOf(handle);
	while (true) {
		const stage = handle.checkpoint.stage;
		if (stage === "FetchTicket") {
			const stepId = id();
			await marker(handle, stage, [stepId]);
			await log.write([
				{ type: "step.started", stepId, name: "fetch ticket and workspace" },
			]);
			try {
				if (signal.aborted) throw new Error("cancelled");
				const ticket = Ticket.parse(await deps.tickets.get(config.ticketKey));
				const workspace = await deps.workspace.create(
					log.current().runId,
					log.current().repo,
					log.current().baseBranch,
				);
				if (signal.aborted) throw new Error("cancelled");
				const ticketRef = await artifact(handle, ticket, "factory-ticket-v1");
				await checkpoint(
					handle,
					{ stage: "Plan", ticket, workspace, inFlight: null },
					[
						{ type: "artifact.recorded", artifact: ticketRef, attemptId: null },
						{ type: "step.finished", stepId, outcome: "succeeded" },
					],
				);
			} catch (error) {
				await log.write([{ type: "step.finished", stepId, outcome: "failed" }]);
				await pause(
					handle,
					`run ${log.current().runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			continue;
		}
		if (stage === "Plan" || stage === "Revise") {
			const stepId = id();
			await marker(handle, stage, [stepId]);
			const role = stage === "Plan" ? "planner" : "reviser";
			const ticket = await artifact(
				handle,
				handle.checkpoint.ticket,
				"factory-ticket-v1",
			);
			const inputs: AgentInput[] = [{ name: "ticket", ref: ticket }];
			if (handle.checkpoint.plan)
				inputs.push({ name: "plan", ref: handle.checkpoint.plan });
			if (handle.checkpoint.review)
				inputs.push({ name: "review", ref: handle.checkpoint.review });
			const shape = jsonEnvelope(
				stage === "Plan" ? PlanOutput : RevisionOutput,
			);
			const reviewData =
				stage === "Revise" && handle.checkpoint.review
					? (JSON.parse(
							new TextDecoder().decode(
								await readArtifact(deps.store, handle.checkpoint.review),
							),
						) as { findings: { id: string }[] })
					: null;
			const spec = await roleSpec(
				deps.store,
				required(handle.roleArtifacts[role], "role source"),
				role,
				required(handle.checkpoint.workspace, "workspace"),
				config.roles[role],
				inputs,
			);
			const result = await runAgentStep(
				{ ...deps, log },
				{
					stepId,
					stepName: role,
					attemptIds: [`${stepId}:1`, `${stepId}:2`],
					runner: deps.runner,
					spec,
					validate(text) {
						const parsed = shape(text);
						if (!parsed.ok || !reviewData) return parsed;
						const ids = RevisionOutput.parse(
							parsed.value,
						).unreconciledFindingIds;
						const known = new Set(reviewData.findings.map((f) => f.id));
						if (
							new Set(ids).size !== ids.length ||
							ids.some((id) => !known.has(id))
						)
							return {
								ok: false,
								error: "unknown or duplicate unreconciled finding id",
							};
						return parsed;
					},
					signal,
				},
			).catch(async (error: unknown) => {
				await pause(
					handle,
					error instanceof Error ? error.message : String(error),
				);
				return null;
			});
			if (!result) return;
			if (result.outcome !== "succeeded") {
				await pause(handle, `${role} ${result.outcome}`);
				return;
			}
			const revised =
				stage === "Revise" ? RevisionOutput.parse(result.value) : null;
			const plan = revised ? revised.plan : PlanOutput.parse(result.value);
			const saved = await savePlan(handle, plan, "agent");
			await checkpoint(
				handle,
				{
					stage: "PlanReview",
					plan: saved.ref,
					lastAgentPlan: saved.ref,
					round:
						handle.checkpoint.round +
						(revised?.unreconciledFindingIds.length ? 0 : 1),
					inFlight: revised?.unreconciledFindingIds.length
						? { stage: "Revise", stepIds: [stepId] }
						: null,
				},
				saved.events,
			);
			if (revised?.unreconciledFindingIds.length) {
				await pause(handle, "unreconciled revision findings");
				return;
			}
			continue;
		}
		if (stage === "PlanReview") {
			const ids = Array.from({ length: Object.keys(lenses).length + 1 }, id);
			await marker(handle, stage, ids);
			const ticket = await artifact(
				handle,
				handle.checkpoint.ticket,
				"factory-ticket-v1",
			);
			const result = await review(
				handle,
				ids,
				[
					{ name: "ticket", ref: ticket },
					{ name: "plan", ref: required(handle.checkpoint.plan, "plan") },
				],
				signal,
				config.roles,
			);
			if (result.decision === "Escalated") {
				await checkpoint(handle, { review: result.ref });
				await pause(handle, "review could not converge");
				return;
			}
			if (result.decision === "Approval") {
				await writePlan(
					deps.dataDir,
					log.current().runId,
					(await version(handle)).plan.markdown,
				);
				const stepId = id();
				await checkpoint(
					handle,
					{ stage: "Approval", review: result.ref, inFlight: null },
					[
						{ type: "step.started", stepId, name: "approval" },
						{
							type: "gate.raised",
							gateId: `approval:${stepId}`,
							stepId,
							kind: "approval",
							allowedCommands: ["approve", "requestChanges"],
							reason: "awaiting approval",
						},
					],
				);
				return;
			}
			await checkpoint(handle, {
				stage: "Revise",
				review: result.ref,
				inFlight: null,
			});
			continue;
		}
		return;
	}
}

/** Persists the run and its initial checkpoint atomically, without starting any agent work. */
export async function beginFactory(
	deps: FactoryDeps,
	input: Omit<StartInput, "signal">,
): Promise<FactoryHandle> {
	validateRunId(input.runId);
	const roleArtifacts: Record<string, ArtifactRef> = {};
	for (const [role, source] of Object.entries(deps.roleSources))
		roleArtifacts[role] = await snapshotRole(deps.store, source);
	const config = FactoryRunConfig.parse({
		ticketKey: input.ticketKey,
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
		stage: "FetchTicket",
		cycle: 1,
		round: 0,
		ticket: null,
		workspace: null,
		plan: null,
		lastAgentPlan: null,
		answers: {},
		review: null,
		approvalMetric: null,
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
		const stepId = id();
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
		if (
			state.checkpoint.plan &&
			(stage === "PlanReview" || stage === "Revise")
		) {
			let markdown: string;
			try {
				markdown = await readPlan(
					state.deps.dataDir,
					state.log.current().runId,
				);
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

function approvalGate(handle: MutableFactoryHandle) {
	const gates = [...handle.log.current().gates.values()].filter(
		(gate) => gate.status === "open",
	);
	const gate = gates.find((item) => item.kind === "approval");
	if (!gate || gates.length !== 1)
		throw conflict("approval gate unavailable or unrelated open gate");
	return gate;
}

export function assertChangeable(handle: FactoryHandle): void {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	if (state.checkpoint.stage !== "Approval")
		throw conflict("run is not awaiting approval");
	approvalGate(state);
}

export async function answer(
	handle: FactoryHandle,
	input: { questionId: string; text: string },
): Promise<FactoryHandle> {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	state.busy = true;
	try {
		if (
			state.checkpoint.stage !== "Approval" &&
			state.checkpoint.stage !== "Escalated"
		)
			throw conflict("run cannot accept answers");
		const current = await version(state);
		if (!current.plan.openQuestions.some((q) => q.id === input.questionId))
			throw invalid("unknown question");
		if (!input.text.trim()) throw invalid("answer must not be blank");
		const answers = {
			...state.checkpoint.answers,
			[input.questionId]: input.text,
		};
		const markdown = renderAnswers(
			await readPlan(state.deps.dataDir, state.log.current().runId),
			answers,
		);
		const saved = await savePlan(
			state,
			{ ...current.plan, markdown },
			"answer",
			answers,
		);
		await writePlan(state.deps.dataDir, state.log.current().runId, markdown);
		await checkpoint(state, { plan: saved.ref, answers }, saved.events);
		return handle;
	} finally {
		state.busy = false;
	}
}

export async function requestChanges(
	handle: FactoryHandle,
	input: { signal: AbortSignal },
): Promise<FactoryHandle> {
	assertChangeable(handle);
	const state = mutableFactoryHandle(handle);
	state.busy = true;
	try {
		const gate = approvalGate(state);
		const current = await version(state);
		const markdown = renderAnswers(
			await readPlan(state.deps.dataDir, state.log.current().runId),
			state.checkpoint.answers,
		);
		const saved = await savePlan(state, { ...current.plan, markdown }, "human");
		await checkpoint(
			state,
			{
				stage: "PlanReview",
				plan: saved.ref,
				cycle: state.checkpoint.cycle + 1,
				round: 1,
			},
			[
				...saved.events,
				{
					type: "gate.resolved",
					gateId: gate.gateId,
					command: "requestChanges",
					note: null,
				},
				{ type: "step.finished", stepId: gate.stepId, outcome: "succeeded" },
			],
		);
		await run(state, input.signal);
		return handle;
	} finally {
		state.busy = false;
	}
}

export async function approve(handle: FactoryHandle): Promise<FactoryHandle> {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	state.busy = true;
	try {
		if (state.checkpoint.stage !== "Approval")
			throw conflict("run is not awaiting approval");
		const gate = approvalGate(state);
		if (
			[...state.log.current().steps.values()].some(
				(step) => step.status === "running" && step.stepId !== gate.stepId,
			) ||
			[...state.log.current().attempts.values()].some(
				(attempt) => attempt.status === "running",
			)
		)
			throw conflict("run has unrelated running work");
		const current = await version(state);
		if (
			current.plan.openQuestions.some(
				(q) => !state.checkpoint.answers[q.id]?.trim(),
			)
		)
			throw conflict("unanswered questions");
		const markdown = renderAnswers(
			await readPlan(state.deps.dataDir, state.log.current().runId),
			state.checkpoint.answers,
		);
		const saved = await savePlan(state, { ...current.plan, markdown }, "human");
		const agent = PlanVersion.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readArtifact(
						state.deps.store,
						required(state.checkpoint.lastAgentPlan, "agent plan"),
					),
				),
			),
		);
		const metric = await artifact(
			state,
			approvalDiff(agent.plan.markdown, markdown),
			"factory-approval-diff-v1",
		);
		await state.deps.workspace.remove(
			required(state.checkpoint.workspace, "workspace"),
		);
		await writePlan(state.deps.dataDir, state.log.current().runId, markdown);
		await checkpoint(
			state,
			{ stage: "Approved", plan: saved.ref, approvalMetric: metric },
			[
				...saved.events,
				{ type: "artifact.recorded", artifact: metric, attemptId: null },
				{
					type: "gate.resolved",
					gateId: gate.gateId,
					command: "approve",
					note: null,
				},
				{ type: "step.finished", stepId: gate.stepId, outcome: "succeeded" },
				{ type: "run.ended", outcome: "approved" },
			],
		);
		return handle;
	} finally {
		state.busy = false;
	}
}

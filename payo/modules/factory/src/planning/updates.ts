import type { ArtifactRef, RunEventBody } from "@payo/contracts";
import {
	loadPlanVersions,
	readArtifact,
	savePlanVersion,
} from "../artifacts.ts";
import { approvalGate, assertApprovalStage } from "../domain/planning.ts";
import { CommandError } from "../errors.ts";
import { renderAnswers } from "../plans.ts";
import {
	type FactoryHandle,
	mutableFactoryHandle,
	required,
} from "../types.ts";
import {
	busy,
	checkpoint,
	conflict,
	hash,
	invalid,
	refOf,
	savePlan,
	version,
} from "./checkpoint.ts";
import { executeFactory } from "./lifecycle.ts";
import { run } from "./run.ts";

export function assertChangeable(handle: FactoryHandle): void {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	assertApprovalStage(state.checkpoint.stage);
	approvalGate(state.log.current());
}

type PlanUpdateInput = {
	expectedVersion: number;
	expectedWorkingCopyHash: string;
} & ({ prompt: string } | { version: number });

/** Accepts and checkpoints an update before any agent work starts. */

export async function acceptPlanUpdate(
	handle: FactoryHandle,
	input: PlanUpdateInput,
): Promise<void> {
	assertChangeable(handle);
	const state = mutableFactoryHandle(handle);
	state.busy = true;
	try {
		const gate = approvalGate(state.log.current());
		const current = await version(state);
		const versions = await loadPlanVersions(
			state.deps.store,
			await state.deps.store.read(state.log.current().runId),
		);
		const selected =
			"version" in input
				? versions.find((item) => item.number === input.version)
				: undefined;
		if ("prompt" in input && !input.prompt.trim())
			throw invalid("prompt must not be blank");
		if ("version" in input && !selected)
			throw new CommandError("not_found", "plan version not found");
		const markdown = await state.deps.readPlan(state.log.current().runId);
		if (
			current.number !== input.expectedVersion ||
			hash(markdown) !== input.expectedWorkingCopyHash
		)
			throw conflict("plan changed; inspect and retry");
		const events: RunEventBody[] = [];
		let base = required(state.checkpoint.plan, "plan");
		let nextNumber = versions.length + 1;
		if (markdown !== current.plan.markdown) {
			const saved = await savePlanVersion(state.deps.store, {
				number: nextNumber++,
				source: "human",
				plan: { ...current.plan, markdown },
				answers: state.checkpoint.answers,
			});
			events.push(...saved);
			base = refOf(required(saved[1], "plan version"));
		}
		let result: ArtifactRef | null = null;
		let prompt: ArtifactRef | null = null;
		if (selected) {
			const savedMarkdown = new TextDecoder().decode(
				await readArtifact(state.deps.store, selected.markdown),
			);
			if (savedMarkdown !== selected.plan.markdown)
				throw new Error("invalid plan markdown artifact");
			const saved = await savePlanVersion(state.deps.store, {
				number: nextNumber,
				source: "restore",
				plan: selected.plan,
				answers: selected.answers,
			});
			events.push(...saved);
			result = refOf(required(saved[1], "plan version"));
		} else if ("prompt" in input) {
			prompt = await state.deps.store.putArtifact(
				new TextEncoder().encode(input.prompt),
				{ kind: "factory-plan-update-prompt-v1", mediaType: "text/plain" },
			);
			events.push({
				type: "artifact.recorded",
				artifact: prompt,
				attemptId: null,
			});
		}
		await checkpoint(
			state,
			{
				stage: selected ? "PlanReview" : "Revise",
				plan: base,
				review: null,
				cycle: state.checkpoint.cycle + 1,
				round: 1,
				inFlight: null,
				pendingPlanUpdate: {
					kind: selected ? "restore" : "prompt",
					base,
					expectedWorkingCopyHash: hash(markdown),
					prompt,
					version: selected?.number ?? null,
					result,
				},
			},
			[
				...events,
				{
					type: "gate.resolved",
					gateId: gate.gateId,
					command: "requestChanges",
					note: null,
				},
				{ type: "step.finished", stepId: gate.stepId, outcome: "succeeded" },
			],
		);
	} finally {
		state.busy = false;
	}
}

export async function updatePlan(
	handle: FactoryHandle,
	input: {
		prompt: string;
		expectedVersion: number;
		expectedWorkingCopyHash: string;
		signal: AbortSignal;
	},
): Promise<FactoryHandle> {
	await acceptPlanUpdate(handle, input);
	return executeFactory(handle, { signal: input.signal });
}

export async function restorePlan(
	handle: FactoryHandle,
	input: {
		version: number;
		expectedVersion: number;
		expectedWorkingCopyHash: string;
		signal: AbortSignal;
	},
): Promise<FactoryHandle> {
	await acceptPlanUpdate(handle, input);
	return executeFactory(handle, { signal: input.signal });
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
		const workingCopy = await state.deps.readPlan(state.log.current().runId);
		const markdown = renderAnswers(workingCopy, answers);
		const saved = await savePlan(
			state,
			{ ...current.plan, markdown },
			"answer",
			answers,
		);
		if ((await state.deps.readPlan(state.log.current().runId)) !== workingCopy)
			throw conflict("plan changed while saving answer; inspect and retry");
		await state.deps.writePlan(state.log.current().runId, markdown);
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
		const gate = approvalGate(state.log.current());
		const current = await version(state);
		const workingCopy = await state.deps.readPlan(state.log.current().runId);
		const markdown = renderAnswers(workingCopy, state.checkpoint.answers);
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

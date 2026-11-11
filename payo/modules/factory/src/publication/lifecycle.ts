import {
	ExecutionRunConfig,
	type PublicationCheckpoint,
	PublicationRunConfig,
	type PublicationSummary,
	PublishRequest,
	type RunEventBody,
} from "@payo/contracts";
import { commit, fold, openRun, openRunLog } from "@payo/kernel";
import { CommandError } from "../errors.ts";
import { loadExecutionCheckpoint } from "../execution-artifacts.ts";
import {
	loadPublicationCheckpoint,
	storePublicationCheckpoint,
} from "./artifacts.ts";
import {
	type MutablePublication,
	mutablePublication,
	type PublicationDeps,
	type PublicationHandle,
	publicationHandle,
} from "./handle.ts";
import {
	previewPublication,
	publicationContent,
	publicationId,
} from "./preview.ts";

let acceptanceTail: Promise<void> = Promise.resolve();
export function beginPublication(
	deps: PublicationDeps,
	executionId: string,
	request: PublishRequest,
	signal: AbortSignal,
): Promise<{ handle: PublicationHandle; created: boolean }> {
	const result = acceptanceTail.then(() =>
		accept(deps, executionId, request, signal),
	);
	acceptanceTail = result.then(
		() => {},
		() => {},
	);
	return result;
}
async function accept(
	deps: PublicationDeps,
	executionId: string,
	request: PublishRequest,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const input = PublishRequest.parse(request);
	const id = publicationId(executionId);
	const existing = await deps.store.read(id);
	if (existing.length) {
		const config = PublicationRunConfig.parse(fold(existing).config.factory);
		if (
			config.executionRunId !== executionId ||
			config.previewHash !== input.previewHash ||
			(input.title !== undefined && input.title !== config.title) ||
			(input.body !== undefined &&
				`${input.body}\n\n<!-- payo-publication:${id} -->` !== config.body)
		)
			throw new CommandError(
				"conflict",
				"publication already accepted with different content or destination",
			);
		return {
			handle: await openPublication(deps, id, { recover: false }),
			created: false,
		};
	}
	const preview = await previewPublication(deps, executionId, signal);
	if (!preview.eligible || !preview.previewHash)
		throw new CommandError("conflict", preview.errors.join("; "));
	if (input.previewHash !== preview.previewHash)
		throw new CommandError(
			"conflict",
			"publication preview is stale; refresh before publishing",
		);
	const source = fold(await deps.store.read(executionId));
	const execution = ExecutionRunConfig.parse(source.config.factory);
	const checkpoint = await loadExecutionCheckpoint(
		deps.store,
		await deps.store.read(executionId),
	);
	const naming = checkpoint.naming ?? execution.naming;
	if (!naming || !checkpoint.workspace)
		throw new CommandError("conflict", "execution naming/workspace missing");
	const content = publicationContent(preview, input, naming, id);
	const config = PublicationRunConfig.parse({
		kind: "factory-publication",
		sourceRunId: execution.sourceRunId,
		executionRunId: executionId,
		plan: execution.plan,
		reviewedCommit: preview.reviewedCommit,
		baseCommit: execution.baseCommit,
		branch: preview.branch,
		worktree: checkpoint.workspace.path,
		target: preview.target,
		pushUrl: preview.pushUrl,
		previewHash: preview.previewHash,
		...content,
	});
	const initial: PublicationCheckpoint = {
		revision: 0,
		stage: "Push",
		intent: null,
		observedRemoteSha: null,
		pr: null,
		pausedOperation: null,
		reason: null,
	};
	const state = await commit(deps.store, null, [
		{
			type: "run.created",
			runId: id,
			repo: source.repo,
			baseBranch: source.baseBranch,
			config: { factory: config },
		},
		await storePublicationCheckpoint(deps.store, initial),
	]);
	return {
		handle: publicationHandle({
			deps,
			log: openRunLog(deps.store, state),
			checkpoint: initial,
			busy: false,
		}),
		created: true,
	};
}
export async function checkpointPublication(
	state: MutablePublication,
	update: Partial<PublicationCheckpoint>,
	events: RunEventBody[] = [],
) {
	const next = {
		...state.checkpoint,
		...update,
		revision: state.checkpoint.revision + 1,
	};
	await state.log.write([
		...events,
		await storePublicationCheckpoint(state.deps.store, next),
	]);
	state.checkpoint = next;
}
export async function gatePublication(
	state: MutablePublication,
	operation: "Push" | "CreatePr",
	reason: string,
) {
	const stepId = state.deps.newId();
	await checkpointPublication(
		state,
		{ stage: "Escalated", pausedOperation: operation, reason },
		[
			{ type: "step.started", stepId, name: "publication escalation" },
			{
				type: "gate.raised",
				gateId: `publication:${stepId}`,
				stepId,
				kind: "publication-escalation",
				allowedCommands: ["resume"],
				reason,
			},
			{ type: "step.finished", stepId, outcome: "escalated" },
		],
	);
}
export async function openPublication(
	deps: PublicationDeps,
	id: string,
	options: { recover?: boolean } = {},
): Promise<PublicationHandle> {
	const state = await openRun(deps.store, id);
	PublicationRunConfig.parse(state.config.factory);
	const checkpoint = await loadPublicationCheckpoint(
		deps.store,
		await deps.store.read(id),
	);
	const mutable = {
		deps,
		log: openRunLog(deps.store, state),
		checkpoint,
		busy: false,
	};
	if (
		options.recover !== false &&
		state.status === "active" &&
		checkpoint.stage !== "Escalated"
	)
		await gatePublication(
			mutable,
			checkpoint.stage === "CreatePr" ? "CreatePr" : "Push",
			"publication interrupted; explicitly resume to reconcile remote state",
		);
	return publicationHandle(mutable);
}
export async function preparePublicationResume(
	handle: PublicationHandle,
): Promise<void> {
	const state = mutablePublication(handle);
	if (state.busy) throw new CommandError("busy", "publication is busy");
	if (
		state.log.current().status !== "active" ||
		state.checkpoint.stage !== "Escalated" ||
		!state.checkpoint.pausedOperation
	)
		throw new CommandError("conflict", "publication is not resumable");
	state.busy = true;
	try {
		const events: RunEventBody[] = [];
		for (const gate of state.log.current().gates.values())
			if (gate.status === "open") {
				const command = gate.allowedCommands.includes("resume")
					? "resume"
					: gate.allowedCommands.includes("retry")
						? "retry"
						: null;
				if (!command)
					throw new CommandError(
						"conflict",
						"publication gate cannot be resumed",
					);
				events.push({
					type: "gate.resolved",
					gateId: gate.gateId,
					command,
					note: "operator requested publication reconciliation",
				});
			}
		for (const step of state.log.current().steps.values())
			if (step.status === "running")
				events.push({
					type: "step.finished",
					stepId: step.stepId,
					outcome: "failed",
				});
		await checkpointPublication(
			state,
			{
				stage: state.checkpoint.pausedOperation,
				pausedOperation: null,
				reason: null,
			},
			events,
		);
	} finally {
		state.busy = false;
	}
}
export function readPublicationSummary(
	handle: PublicationHandle,
): PublicationSummary {
	const state = mutablePublication(handle),
		config = PublicationRunConfig.parse(state.log.current().config.factory);
	return {
		sourceRunId: config.sourceRunId,
		executionRunId: config.executionRunId,
		stage: state.checkpoint.stage,
		branch: config.branch,
		reviewedCommit: config.reviewedCommit,
		target: config.target,
		pr: state.checkpoint.pr,
		reason: state.checkpoint.reason,
	};
}

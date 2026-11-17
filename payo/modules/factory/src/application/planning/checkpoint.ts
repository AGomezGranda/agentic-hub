import {
	type ArtifactRef,
	FactoryCheckpoint,
	FactoryRunConfig,
	type PlanOutput,
	PlanVersion,
	type RunEventBody,
	WorkItemRequest,
} from "@payo/contracts";
import { sha256Hex } from "@payo/kernel";
import { CommandError } from "../../domain/errors.ts";
import {
	readArtifact,
	savePlanVersion,
	storeCheckpoint,
} from "../artifacts.ts";
import { PlanNotFound } from "../plan-store.ts";
import { type MutableFactoryHandle, required } from "../types.ts";

export const refOf = (event: RunEventBody): ArtifactRef => {
	if (event.type !== "artifact.recorded") throw new Error("artifact expected");
	return event.artifact;
};

export const busy = () => new CommandError("busy", "factory command busy");

export const conflict = (message: string) =>
	new CommandError("conflict", message);

export const invalid = (message: string) =>
	new CommandError("invalid_request", message);

export const configOf = (handle: MutableFactoryHandle) =>
	FactoryRunConfig.parse(handle.log.current().config.factory);

export const hash = (value: string) =>
	sha256Hex(new TextEncoder().encode(value));

export async function checkpoint(
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

export async function marker(
	handle: MutableFactoryHandle,
	stage: FactoryCheckpoint["stage"],
	stepIds: string[],
) {
	await checkpoint(handle, { stage, inFlight: { stage, stepIds } });
}

export async function artifact(
	handle: MutableFactoryHandle,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	return handle.deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify(value)),
		{ kind, mediaType: "application/json" },
	);
}

export async function resolveRequest(
	handle: MutableFactoryHandle,
): Promise<WorkItemRequest> {
	const request = configOf(handle).workItemRequest;
	if (request.source === "jira") return request;
	const text = new TextDecoder().decode(
		await readArtifact(handle.deps.store, request.artifact),
	);
	return WorkItemRequest.parse({ source: "prompt", text });
}

export async function version(
	handle: MutableFactoryHandle,
): Promise<PlanVersion> {
	if (!handle.checkpoint.plan) throw new Error("missing plan");
	return PlanVersion.parse(
		JSON.parse(
			new TextDecoder().decode(
				await readArtifact(handle.deps.store, handle.checkpoint.plan),
			),
		),
	);
}

export async function savePlan(
	handle: MutableFactoryHandle,
	plan: PlanOutput,
	source: "agent" | "human" | "answer" | "restore",
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

export async function writeWorkingPlan(
	handle: MutableFactoryHandle,
): Promise<boolean> {
	const markdown = (await version(handle)).plan.markdown;
	let current: string | null;
	try {
		current = await handle.deps.readPlan(handle.log.current().runId);
	} catch (error) {
		if (!(error instanceof PlanNotFound)) throw error;
		current = null;
	}
	const expected =
		handle.checkpoint.pendingPlanUpdate?.expectedWorkingCopyHash ??
		handle.checkpoint.expectedWorkingCopyHash ??
		null;
	if (
		current !== markdown &&
		(current === null ? null : hash(current)) !== expected
	)
		return false;
	// shortcut: an unrelated editor can race this check and write; coordinate writers if atomic conflict detection is required.
	if (current !== markdown)
		await handle.deps.writePlan(handle.log.current().runId, markdown);
	return true;
}

export async function pause(handle: MutableFactoryHandle, reason: string) {
	const stepId = handle.deps.newId();
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
	if (handle.checkpoint.plan && !handle.checkpoint.pendingPlanUpdate)
		await writeWorkingPlan(handle);
}

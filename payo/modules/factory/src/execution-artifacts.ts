import {
	ExecutionCheckpoint,
	ExecutionManifest,
	ExecutionSummary,
	type PhaseReceipt,
	PhaseReceipt as PhaseReceiptSchema,
	type RunEvent,
	type RunEventBody,
} from "@payo/contracts";
import type { RunStore } from "@payo/kernel";
import { readArtifact } from "./artifacts.ts";

async function jsonArtifact(
	store: RunStore,
	value: unknown,
	kind: string,
): Promise<RunEventBody> {
	const artifact = await store.putArtifact(
		new TextEncoder().encode(JSON.stringify(value)),
		{ kind, mediaType: "application/json" },
	);
	return { type: "artifact.recorded", artifact, attemptId: null };
}

export function storeExecutionCheckpoint(
	store: RunStore,
	checkpoint: ExecutionCheckpoint,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		ExecutionCheckpoint.parse(checkpoint),
		"factory-execution-checkpoint-v1",
	);
}

export function storeExecutionManifest(
	store: RunStore,
	manifest: ExecutionManifest,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		ExecutionManifest.parse(manifest),
		"factory-execution-manifest-v1",
	);
}

export function storePhaseReceipt(
	store: RunStore,
	receipt: PhaseReceipt,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		PhaseReceiptSchema.parse(receipt),
		"factory-execution-phase-receipt-v1",
	);
}

export function storeExecutionSummary(
	store: RunStore,
	summary: ExecutionSummary,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		ExecutionSummary.parse(summary),
		"factory-execution-summary-v1",
	);
}

export async function loadExecutionCheckpoint(
	store: RunStore,
	events: RunEvent[],
): Promise<ExecutionCheckpoint> {
	const event = events.findLast(
		(item) =>
			item.type === "artifact.recorded" &&
			item.artifact.kind === "factory-execution-checkpoint-v1",
	);
	if (event?.type !== "artifact.recorded")
		throw new Error("execution checkpoint not found");
	return ExecutionCheckpoint.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(store, event.artifact)),
		),
	);
}

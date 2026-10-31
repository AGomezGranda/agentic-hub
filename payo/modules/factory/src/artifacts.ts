import {
	type ArtifactRef,
	FactoryCheckpoint,
	PlanVersion,
	type RunEvent,
	type RunEventBody,
} from "@payo/contracts";
import { type RunStore, sha256Hex } from "@payo/kernel";

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
export function storeCheckpoint(
	store: RunStore,
	checkpoint: FactoryCheckpoint,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		FactoryCheckpoint.parse(checkpoint),
		"factory-checkpoint-v1",
	);
}
export function storePlanVersion(
	store: RunStore,
	version: PlanVersion,
): Promise<RunEventBody> {
	return jsonArtifact(
		store,
		PlanVersion.parse(version),
		"factory-plan-version-v1",
	);
}

export async function savePlanVersion(
	store: RunStore,
	input: Omit<PlanVersion, "markdown">,
): Promise<RunEventBody[]> {
	const markdown = await store.putArtifact(
		new TextEncoder().encode(input.plan.markdown),
		{ kind: "factory-plan-markdown", mediaType: "text/markdown" },
	);
	return [
		{ type: "artifact.recorded", artifact: markdown, attemptId: null },
		await storePlanVersion(store, { ...input, markdown }),
	];
}

export async function loadPlanVersions(
	store: RunStore,
	events: RunEvent[],
): Promise<PlanVersion[]> {
	const versions: PlanVersion[] = [];
	for (const event of events) {
		if (
			event.type !== "artifact.recorded" ||
			event.artifact.kind !== "factory-plan-version-v1"
		)
			continue;
		versions.push(
			PlanVersion.parse(
				JSON.parse(
					new TextDecoder().decode(await readArtifact(store, event.artifact)),
				),
			),
		);
	}
	return versions;
}

export async function readArtifact(
	store: RunStore,
	ref: ArtifactRef,
): Promise<Uint8Array> {
	const bytes = await store.readArtifact(ref.sha256);
	if (bytes.byteLength !== ref.size || sha256Hex(bytes) !== ref.sha256)
		throw new Error("artifact bytes do not match reference");
	return bytes;
}

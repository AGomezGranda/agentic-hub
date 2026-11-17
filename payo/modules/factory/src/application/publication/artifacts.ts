import {
	PublicationCheckpoint,
	type RunEvent,
	type RunEventBody,
} from "@payo/contracts";
import type { RunStore } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
export async function storePublicationCheckpoint(
	store: RunStore,
	value: PublicationCheckpoint,
): Promise<RunEventBody> {
	const artifact = await store.putArtifact(
		new TextEncoder().encode(
			JSON.stringify(PublicationCheckpoint.parse(value)),
		),
		{
			kind: "factory-publication-checkpoint-v1",
			mediaType: "application/json",
		},
	);
	return { type: "artifact.recorded", artifact, attemptId: null };
}
export async function loadPublicationCheckpoint(
	store: RunStore,
	events: RunEvent[],
): Promise<PublicationCheckpoint> {
	const event = events.findLast(
		(e) =>
			e.type === "artifact.recorded" &&
			e.artifact.kind === "factory-publication-checkpoint-v1",
	);
	if (event?.type !== "artifact.recorded")
		throw Error("publication checkpoint missing");
	return PublicationCheckpoint.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(store, event.artifact)),
		),
	);
}

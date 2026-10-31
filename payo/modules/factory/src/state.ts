import {
	FactoryCheckpoint,
	type Finding,
	type RunEvent,
	type VerifiedOutput,
} from "@payo/contracts";
import type { RunStore } from "@payo/kernel";
import { readArtifact } from "./artifacts.ts";

export function decideReview(
	findings: Finding[],
	verified: VerifiedOutput,
	unchecked: string[],
	round: number,
): "Approval" | "Revise" | "Escalated" {
	const remaining = new Set(findings.map((finding) => finding.id));
	if (remaining.size !== findings.length)
		throw new Error("duplicate finding id");
	for (const verdict of verified.verdicts) {
		if (
			verdict.classification === "INVALID" &&
			!verdict.counterEvidence?.trim()
		)
			throw new Error("INVALID verdict requires counter-evidence");
		for (const id of verdict.sourceIds)
			if (!remaining.delete(id))
				throw new Error(`unknown or duplicate finding id ${id}`);
	}
	if (remaining.size) throw new Error("missing verdicts");
	if (unchecked.length) return "Escalated";
	const blocking = verified.verdicts.some(
		(v) =>
			v.classification === "BLOCKER" &&
			(v.severity === "P0" || v.severity === "P1"),
	);
	return blocking ? (round >= 3 ? "Escalated" : "Revise") : "Approval";
}

export async function loadCheckpoint(
	store: RunStore,
	events: RunEvent[],
): Promise<FactoryCheckpoint> {
	const event = events.findLast(
		(item) =>
			item.type === "artifact.recorded" &&
			item.artifact.kind === "factory-checkpoint-v1",
	);
	if (event?.type !== "artifact.recorded")
		throw new Error("factory checkpoint not found");
	return FactoryCheckpoint.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(store, event.artifact)),
		),
	);
}

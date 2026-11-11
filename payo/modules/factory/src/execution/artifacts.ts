import {
	type ArtifactRef,
	type ExecutionRunConfig,
	ImplementationOutput as ImplementationOutputSchema,
	PhaseReceipt as PhaseReceiptSchema,
	PlanVersion,
} from "@payo/contracts";
import type { RunState, RunStore } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import type { MutableExecutionHandle } from "../execution-handle.ts";

export async function phaseStartCommit(
	state: MutableExecutionHandle,
	config: ExecutionRunConfig,
): Promise<string> {
	const ref = state.checkpoint.receipts.at(-1);
	if (!ref) return config.baseCommit;
	const receipt = PhaseReceiptSchema.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(state.deps.store, ref)),
		),
	);
	return receipt.resultCommit;
}

export async function readPhaseReceipts(
	state: MutableExecutionHandle,
): Promise<import("@payo/contracts").PhaseReceipt[]> {
	return Promise.all(
		state.checkpoint.receipts.map(async (ref) =>
			PhaseReceiptSchema.parse(
				JSON.parse(
					new TextDecoder().decode(await readArtifact(state.deps.store, ref)),
				),
			),
		),
	);
}

export async function implementationSummary(
	state: MutableExecutionHandle,
	reportRef: ArtifactRef,
): Promise<string> {
	const value = ImplementationOutputSchema.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(state.deps.store, reportRef)),
		),
	);
	return value.summary;
}

export async function readApprovedVersion(
	store: RunStore,
	ref: ArtifactRef,
): Promise<PlanVersion> {
	return PlanVersion.parse(
		JSON.parse(new TextDecoder().decode(await readArtifact(store, ref))),
	);
}

export async function storeJsonArtifact(
	state: MutableExecutionHandle,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	const ref = await putJsonArtifact(state.deps.store, value, kind);
	await state.log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return ref;
}

export function putJsonArtifact(
	store: RunStore,
	value: unknown,
	kind: string,
): Promise<ArtifactRef> {
	return store.putArtifact(new TextEncoder().encode(JSON.stringify(value)), {
		kind,
		mediaType: "application/json",
	});
}

export async function storeTextArtifact(
	state: MutableExecutionHandle,
	value: string,
	kind: string,
): Promise<ArtifactRef> {
	const ref = await state.deps.store.putArtifact(
		new TextEncoder().encode(value),
		{
			kind,
			mediaType: "text/x-diff",
		},
	);
	await state.log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return ref;
}

export function findArtifactRef(
	state: RunState,
	kind: string,
): ArtifactRef | null {
	const event = state.artifacts.findLast((artifact) => artifact.kind === kind);
	return event ?? null;
}

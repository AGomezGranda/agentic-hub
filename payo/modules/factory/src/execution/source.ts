import {
	type ArtifactRef,
	type PlanOutput,
	PlanVersion,
} from "@payo/contracts";
import { fold, type RunState, type RunStore, sha256Hex } from "@payo/kernel";
import { loadCheckpoint, readArtifact } from "../artifacts.ts";
import { sourceEligibility } from "../domain/execution.ts";
import { resolveImplementation } from "../domain/phase-outline.ts";
import { CommandError } from "../errors.ts";
import type { ExecutionDeps } from "../execution-handle.ts";

const conflict = (message: string) => new CommandError("conflict", message);
const invalid = (message: string) =>
	new CommandError("invalid_request", message);
export function selectedPr(plan: PlanOutput, prId: string) {
	const pr = resolveImplementation(plan.markdown, plan.prStrategy).find(
		(item) => item.id === prId,
	);
	if (!pr)
		throw new CommandError(
			"not_found",
			`PR ${prId} is not in the approved plan`,
		);
	if (!pr.phases.length)
		throw conflict(`PR ${prId} has no phases: ${pr.issues.join(", ")}`);
	if (pr.issues.length) throw conflict(pr.issues.join("\n"));
	return {
		id: pr.id,
		title: pr.title,
		phases: pr.phases.map((phase) => phase.title),
	};
}

export function executionId(
	sourceRunId: string,
	planSha: string,
	prId: string,
): string {
	const raw = sha256Hex(
		new TextEncoder().encode(`${sourceRunId}\n${planSha}\n${prId}`),
	).slice(0, 32);
	const variant = "89ab"[Number.parseInt(raw[16] as string, 16) & 3];
	return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

async function approvedPlan(
	store: RunStore,
	events: Awaited<ReturnType<RunStore["read"]>>,
): Promise<{ ref: ArtifactRef; version: PlanVersion }> {
	const checkpoint = await loadCheckpoint(store, events);
	if (!checkpoint.plan) throw conflict("source run has no approved plan");
	const version = PlanVersion.parse(
		JSON.parse(
			new TextDecoder().decode(await readArtifact(store, checkpoint.plan)),
		),
	);
	const markdown = new TextDecoder().decode(
		await readArtifact(store, version.markdown),
	);
	if (markdown !== version.plan.markdown)
		throw new Error("approved plan markdown does not match its version");
	return { ref: checkpoint.plan, version };
}

export async function readApprovedExecutionSource(
	deps: Pick<ExecutionDeps, "store">,
	sourceRunId: string,
): Promise<{
	state: RunState;
	plan: Awaited<ReturnType<typeof approvedPlan>>;
}> {
	const events = await deps.store.read(sourceRunId);
	if (events.length === 0) throw invalid(`source run ${sourceRunId} not found`);
	const state = fold(events);
	const eligibility = sourceEligibility(state);
	if (eligibility === "unapproved")
		throw conflict(`source run ${sourceRunId} has not been approved`);
	if (eligibility === "not_planning")
		throw conflict(`source run ${sourceRunId} is not a planning run`);
	return { state, plan: await approvedPlan(deps.store, events) };
}

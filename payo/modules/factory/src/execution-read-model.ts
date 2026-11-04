import type { ArtifactRef } from "@payo/contracts";
import {
	ExecutionManifest as ExecutionManifestSchema,
	ExecutionRunConfig as ExecutionRunConfigSchema,
	ExecutionSummary as ExecutionSummarySchema,
	PhaseReceipt as PhaseReceiptSchema,
} from "@payo/contracts";
import { readArtifact } from "./artifacts.ts";
import {
	type ExecutionHandle,
	mutableExecutionHandle,
} from "./execution-handle.ts";

const checkStatuses = new Set([
	"passed",
	"failed",
	"timed_out",
	"cancelled",
	"spawn_failed",
]);

/** Projects execution state without letting a damaged optional report break status reads. */
export async function readExecutionSummary(
	handle: ExecutionHandle,
): Promise<import("@payo/contracts").ExecutionSummary> {
	const state = mutableExecutionHandle(handle);
	const run = state.log.current();
	const config = ExecutionRunConfigSchema.parse(run.config.factory);
	const artifactIssues: string[] = [];
	const latest = (kind: string): ArtifactRef | null =>
		run.artifacts.findLast((ref) => ref.kind === kind) ?? null;
	const readJson = async (
		ref: ArtifactRef,
		label: string,
	): Promise<unknown | null> => {
		try {
			return JSON.parse(
				new TextDecoder().decode(await readArtifact(state.deps.store, ref)),
			);
		} catch {
			artifactIssues.push(
				`${label} artifact ${ref.sha256} is unavailable or invalid`,
			);
			return null;
		}
	};

	const manifestRef = state.checkpoint.manifest;
	const manifestValue = manifestRef
		? await readJson(manifestRef, "execution manifest")
		: null;
	let manifest: ReturnType<typeof ExecutionManifestSchema.parse> | null = null;
	try {
		if (manifestValue !== null)
			manifest = ExecutionManifestSchema.parse(manifestValue);
	} catch {
		artifactIssues.push("execution manifest failed schema validation");
	}

	const checks: Array<{
		name: string;
		status: "passed" | "failed" | "timed_out" | "cancelled" | "spawn_failed";
	}> = [];
	const checksRef = latest("factory-execution-check-results-v1");
	if (checksRef) {
		const value = await readJson(checksRef, "check results");
		if (isRecord(value) && Array.isArray(value.results)) {
			for (const result of value.results) {
				if (
					isRecord(result) &&
					typeof result.name === "string" &&
					typeof result.status === "string" &&
					checkStatuses.has(result.status)
				)
					checks.push({
						name: result.name,
						status: result.status as (typeof checks)[number]["status"],
					});
			}
		} else if (value !== null) {
			artifactIssues.push("check results artifact has an invalid shape");
		}
	}

	let review: {
		lenses: string[];
		uncheckedLenses: string[];
		findings: number;
		unresolved: number;
		acceptedFindingIds: string[];
		unresolvedFindingIds: string[];
		round: number;
	} | null = null;
	const reviewRef = latest("factory-execution-review-v1");
	if (reviewRef) {
		const value = await readJson(reviewRef, "implementation review");
		if (isRecord(value)) {
			review = {
				lenses: Array.isArray(value.lenses)
					? value.lenses.flatMap((item) =>
							isRecord(item) && typeof item.lens === "string"
								? [item.lens]
								: [],
						)
					: [],
				uncheckedLenses: Array.isArray(value.unchecked)
					? value.unchecked.filter(
							(item): item is string => typeof item === "string",
						)
					: [],
				findings: Array.isArray(value.findings) ? value.findings.length : 0,
				unresolved: state.checkpoint.unresolvedFindingIds.length,
				acceptedFindingIds: [...state.checkpoint.acceptedFindingIds],
				unresolvedFindingIds: [...state.checkpoint.unresolvedFindingIds],
				round: state.checkpoint.round,
			};
		} else if (value !== null) {
			artifactIssues.push(
				"implementation review artifact has an invalid shape",
			);
		}
	}

	const completedPhases: Array<{
		id: string;
		title: string;
		resultCommit: string;
	}> = [];
	for (const ref of state.checkpoint.receipts) {
		const value = await readJson(ref, "phase receipt");
		try {
			if (value === null) continue;
			const receipt = PhaseReceiptSchema.parse(value);
			completedPhases.push({
				id: receipt.phaseId,
				title:
					manifest?.phases.find((phase) => phase.id === receipt.phaseId)
						?.title ?? receipt.phaseId,
				resultCommit: receipt.resultCommit,
			});
		} catch {
			artifactIssues.push(
				`phase receipt ${ref.sha256} failed schema validation`,
			);
		}
	}

	return ExecutionSummarySchema.parse({
		runId: run.runId,
		sourceRunId: config.sourceRunId,
		prId: config.prId,
		phaseCount: manifest?.phases.length ?? 0,
		phases: manifest?.phases.map(({ id, title }) => ({ id, title })),
		completedPhases,
		resultCommit:
			run.status === "ended" && run.outcome === "reviewed"
				? (state.checkpoint.workspace?.head ?? null)
				: null,
		status: run.status,
		outcome: run.outcome,
		stage: state.checkpoint.stage,
		phaseIndex: state.checkpoint.phaseIndex,
		scope: state.checkpoint.scope,
		branch: state.checkpoint.workspace?.branch ?? null,
		worktree: state.checkpoint.workspace?.path ?? null,
		statusDetail: state.checkpoint.statusDetail,
		escalationReason: state.checkpoint.escalation?.reason ?? null,
		checks,
		review,
		artifactIssues,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { join } from "node:path";
import {
	PlanVersion,
	ReviewOutput,
	RunReview,
	VerifiedOutput,
} from "@payo/contracts";
import { readArtifact } from "./artifacts.ts";
import { readPlan } from "./plans.ts";
import { type FactoryHandle, mutableFactoryHandle } from "./types.ts";

function unavailable(
	reason: "not_available" | "missing" | "unsafe" | "invalid",
) {
	return { available: false as const, reason };
}

function failureReason(error: unknown): "missing" | "unsafe" | "invalid" {
	if (
		error instanceof Error &&
		(("code" in error && error.code === "ENOENT") ||
			error.message.includes("not found"))
	)
		return "missing";
	if (error instanceof Error && error.message.includes("unsafe"))
		return "unsafe";
	return "invalid";
}

async function projectPlan(
	handle: FactoryHandle,
	checkpoint: FactoryHandle["checkpoint"],
) {
	if (!checkpoint.plan) return unavailable("not_available");
	const { deps, log } = mutableFactoryHandle(handle);
	try {
		const version = PlanVersion.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readArtifact(deps.store, checkpoint.plan),
				),
			),
		);
		const snapshotMarkdown = new TextDecoder().decode(
			await readArtifact(deps.store, version.markdown),
		);
		if (snapshotMarkdown !== version.plan.markdown)
			return unavailable("invalid");

		if (checkpoint.stage === "Approval" || checkpoint.stage === "Escalated") {
			const runId = log.current().runId;
			const markdown = await readPlan(deps.dataDir, runId);
			return {
				available: true as const,
				markdown,
				editorPath: join(deps.dataDir, "runs", runId, "plan.md"),
				questions: version.plan.openQuestions,
			};
		}
		return {
			available: true as const,
			markdown: snapshotMarkdown,
			editorPath: null,
			questions: version.plan.openQuestions,
		};
	} catch (error) {
		return unavailable(failureReason(error));
	}
}

async function projectReview(
	handle: FactoryHandle,
	checkpoint: FactoryHandle["checkpoint"],
) {
	if (!checkpoint.review) return unavailable("not_available");
	const { deps } = mutableFactoryHandle(handle);
	if (
		checkpoint.review.kind !== "factory-review-input-v1" &&
		checkpoint.review.kind !== "factory-review-v1"
	)
		return unavailable("invalid");
	try {
		const artifact = JSON.parse(
			new TextDecoder().decode(
				await readArtifact(deps.store, checkpoint.review),
			),
		) as Record<string, unknown>;
		const findings = ReviewOutput.parse({
			findings: artifact.findings,
		}).findings;
		if (!Array.isArray(artifact.unchecked)) return unavailable("invalid");
		const uncheckedLenses = artifact.unchecked.map((lens) => {
			if (typeof lens !== "string" || !lens.trim())
				throw new Error("invalid unchecked review lens");
			return lens;
		});
		const verdicts =
			checkpoint.review.kind === "factory-review-v1"
				? VerifiedOutput.parse(artifact.verdicts).verdicts
				: null;
		return {
			available: true as const,
			findings,
			uncheckedLenses,
			verdicts,
			provenance: "unknown" as const,
		};
	} catch (error) {
		return unavailable(failureReason(error));
	}
}

/**
 * Projects only factory-owned plan and review artifacts. The checkpoint is a detached snapshot;
 * an external editor may still change plan.md while this projection is being read.
 */
export async function readRunReview(handle: FactoryHandle) {
	const checkpoint = handle.checkpoint;
	const [plan, review] = await Promise.all([
		projectPlan(handle, checkpoint),
		projectReview(handle, checkpoint),
	]);
	return RunReview.parse({ plan, answers: checkpoint.answers, review });
}

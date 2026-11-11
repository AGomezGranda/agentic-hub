import {
	type AgentInput,
	jsonEnvelope,
	PlanOutput,
	PlanVersion,
	RevisionOutput,
	WorkItem,
} from "@payo/contracts";
import { runAgentStep } from "@payo/kernel";
import { readArtifact } from "../artifacts.ts";
import { renderAnswers } from "../plans.ts";
import { review } from "../review.ts";
import { lenses, roleSpec } from "../roles.ts";
import { type MutableFactoryHandle, required } from "../types.ts";
import {
	artifact,
	checkpoint,
	configOf,
	hash,
	marker,
	pause,
	resolveRequest,
	savePlan,
	version,
} from "./checkpoint.ts";

export async function run(handle: MutableFactoryHandle, signal: AbortSignal) {
	const { deps, log } = handle;
	const config = configOf(handle);
	while (true) {
		const pending = handle.checkpoint.pendingPlanUpdate;
		if (
			pending?.result &&
			handle.checkpoint.plan?.sha256 !== pending.result.sha256
		) {
			const saved = PlanVersion.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readArtifact(deps.store, pending.result),
					),
				),
			);
			const current = await deps.readPlan(log.current().runId);
			if (
				hash(current) !== pending.expectedWorkingCopyHash &&
				current !== saved.plan.markdown
			) {
				await marker(handle, "PlanReview", [handle.deps.newId()]);
				await pause(
					handle,
					"working plan changed during update; resume to review the edited file",
				);
				return;
			}
			if (current !== saved.plan.markdown)
				await deps.writePlan(log.current().runId, saved.plan.markdown);
			await checkpoint(handle, {
				plan: pending.result,
				answers: saved.answers,
				pendingPlanUpdate: {
					...pending,
					expectedWorkingCopyHash: hash(saved.plan.markdown),
				},
			});
		}
		const stage = handle.checkpoint.stage;
		if (stage === "ResolveWorkItem" || stage === "FetchTicket") {
			const stepId = handle.deps.newId();
			await marker(handle, stage, [stepId]);
			await log.write([
				{
					type: "step.started",
					stepId,
					name: "resolve work item and workspace",
				},
			]);
			try {
				if (signal.aborted) throw new Error("cancelled");
				const workItem = WorkItem.parse(
					await deps.workItems.resolve(await resolveRequest(handle)),
				);
				const workspace = await deps.workspace.create(
					log.current().runId,
					log.current().repo,
					log.current().baseBranch,
				);
				if (signal.aborted) throw new Error("cancelled");
				const workItemRef = await artifact(
					handle,
					workItem,
					"factory-work-item-v1",
				);
				await checkpoint(
					handle,
					{ stage: "Plan", workItem, workspace, inFlight: null },
					[
						{
							type: "artifact.recorded",
							artifact: workItemRef,
							attemptId: null,
						},
						{ type: "step.finished", stepId, outcome: "succeeded" },
					],
				);
			} catch (error) {
				await log.write([{ type: "step.finished", stepId, outcome: "failed" }]);
				await pause(
					handle,
					`run ${log.current().runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			continue;
		}
		if (stage === "Plan" || stage === "Revise") {
			const stepId = handle.deps.newId();
			await marker(handle, stage, [stepId]);
			const role = stage === "Plan" ? "planner" : "reviser";
			const workItem = await artifact(
				handle,
				handle.checkpoint.workItem,
				"factory-work-item-v1",
			);
			const inputs: AgentInput[] = [{ name: "work-item", ref: workItem }];
			if (handle.checkpoint.plan)
				inputs.push({ name: "plan", ref: handle.checkpoint.plan });
			if (handle.checkpoint.review)
				inputs.push({ name: "review", ref: handle.checkpoint.review });
			if (
				handle.checkpoint.pendingPlanUpdate?.kind === "prompt" &&
				!handle.checkpoint.pendingPlanUpdate.result
			) {
				inputs.push({
					name: "prompt",
					ref: required(handle.checkpoint.pendingPlanUpdate.prompt, "prompt"),
				});
			}
			const shape = jsonEnvelope(
				stage === "Plan" ? PlanOutput : RevisionOutput,
			);
			const reviewData =
				stage === "Revise" && handle.checkpoint.review
					? (JSON.parse(
							new TextDecoder().decode(
								await readArtifact(deps.store, handle.checkpoint.review),
							),
						) as { findings: { id: string }[] })
					: null;
			const spec = await roleSpec(
				deps.store,
				required(handle.roleArtifacts[role], "role source"),
				role,
				required(handle.checkpoint.workspace, "workspace"),
				config.roles[role],
				inputs,
			).catch(async (error: unknown) => {
				await pause(
					handle,
					error instanceof Error ? error.message : String(error),
				);
				return null;
			});
			if (!spec) return;
			if (
				handle.checkpoint.pendingPlanUpdate?.kind === "prompt" &&
				!handle.checkpoint.pendingPlanUpdate.result
			)
				spec.instructions +=
					"\n\nRevise the supplied plan according to the supplied prompt. Preserve existing answers and stable question IDs; use new IDs when question meaning changes.";
			const result = await runAgentStep(
				{ ...deps, log },
				{
					stepId,
					stepName: role,
					attemptIds: [`${stepId}:1`, `${stepId}:2`],
					runner: deps.runner,
					spec,
					validate(text) {
						const parsed = shape(text);
						if (!parsed.ok || !reviewData) return parsed;
						const ids = RevisionOutput.parse(
							parsed.value,
						).unreconciledFindingIds;
						const known = new Set(reviewData.findings.map((f) => f.id));
						if (
							new Set(ids).size !== ids.length ||
							ids.some((id) => !known.has(id))
						)
							return {
								ok: false,
								error: "unknown or duplicate unreconciled finding id",
							};
						return parsed;
					},
					signal,
				},
			).catch(async (error: unknown) => {
				await pause(
					handle,
					error instanceof Error ? error.message : String(error),
				);
				return null;
			});
			if (!result) return;
			if (result.outcome !== "succeeded") {
				await pause(handle, `${role} ${result.outcome}`);
				return;
			}
			const revised =
				stage === "Revise" ? RevisionOutput.parse(result.value) : null;
			const outputPlan = revised
				? revised.plan
				: PlanOutput.parse(result.value);
			const plan = handle.checkpoint.pendingPlanUpdate
				? {
						...outputPlan,
						markdown: renderAnswers(
							outputPlan.markdown,
							handle.checkpoint.answers,
						),
					}
				: outputPlan;
			const saved = await savePlan(handle, plan, "agent");
			await checkpoint(
				handle,
				{
					stage: "PlanReview",
					plan: handle.checkpoint.pendingPlanUpdate
						? handle.checkpoint.plan
						: saved.ref,
					pendingPlanUpdate: handle.checkpoint.pendingPlanUpdate
						? { ...handle.checkpoint.pendingPlanUpdate, result: saved.ref }
						: null,
					lastAgentPlan: saved.ref,
					round:
						handle.checkpoint.round +
						(revised?.unreconciledFindingIds.length ||
						(handle.checkpoint.pendingPlanUpdate &&
							!handle.checkpoint.pendingPlanUpdate.result)
							? 0
							: 1),
					inFlight: revised?.unreconciledFindingIds.length
						? { stage: "Revise", stepIds: [stepId] }
						: null,
				},
				saved.events,
			);
			if (revised?.unreconciledFindingIds.length) {
				await pause(handle, "unreconciled revision findings");
				return;
			}
			continue;
		}
		if (stage === "PlanReview") {
			const ids = Array.from({ length: Object.keys(lenses).length + 1 }, () =>
				handle.deps.newId(),
			);
			await marker(handle, stage, ids);
			const workItem = await artifact(
				handle,
				handle.checkpoint.workItem,
				"factory-work-item-v1",
			);
			const result = await review(
				handle,
				ids,
				[
					{ name: "work-item", ref: workItem },
					{ name: "plan", ref: required(handle.checkpoint.plan, "plan") },
				],
				signal,
				config.roles,
			).catch(async (error: unknown) => {
				await pause(
					handle,
					error instanceof Error ? error.message : String(error),
				);
				return null;
			});
			if (!result) return;
			if (result.decision === "Escalated") {
				await checkpoint(handle, { review: result.ref });
				await pause(handle, "review could not converge");
				return;
			}
			if (result.decision === "Approval") {
				if (handle.checkpoint.pendingPlanUpdate) {
					const current = await deps.readPlan(log.current().runId);
					if (
						hash(current) !==
						handle.checkpoint.pendingPlanUpdate.expectedWorkingCopyHash
					) {
						await pause(
							handle,
							"working plan changed during review; resume to review the edited file",
						);
						return;
					}
				}
				await deps.writePlan(
					log.current().runId,
					(await version(handle)).plan.markdown,
				);
				const stepId = handle.deps.newId();
				await checkpoint(
					handle,
					{
						stage: "Approval",
						review: result.ref,
						inFlight: null,
						pendingPlanUpdate: null,
					},
					[
						{ type: "step.started", stepId, name: "approval" },
						{
							type: "gate.raised",
							gateId: `approval:${stepId}`,
							stepId,
							kind: "approval",
							allowedCommands: ["approve", "requestChanges"],
							reason: "awaiting approval",
						},
					],
				);
				return;
			}
			await checkpoint(handle, {
				stage: "Revise",
				review: result.ref,
				inFlight: null,
			});
			continue;
		}
		return;
	}
}

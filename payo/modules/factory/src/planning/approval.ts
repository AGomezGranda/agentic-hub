import { PlanVersion } from "@payo/contracts";
import { readArtifact } from "../artifacts.ts";
import { approvalGate, assertPlanApprovable } from "../domain/planning.ts";
import { approvalDiff } from "../metrics.ts";
import { renderAnswers } from "../plans.ts";
import {
	type FactoryHandle,
	mutableFactoryHandle,
	required,
} from "../types.ts";
import {
	artifact,
	busy,
	checkpoint,
	conflict,
	savePlan,
	version,
} from "./checkpoint.ts";

export async function approve(handle: FactoryHandle): Promise<FactoryHandle> {
	const state = mutableFactoryHandle(handle);
	if (state.busy) throw busy();
	state.busy = true;
	try {
		if (state.checkpoint.stage !== "Approval")
			throw conflict("run is not awaiting approval");
		const gate = approvalGate(state.log.current());
		const current = await version(state);
		const workingCopy = await state.deps.readPlan(state.log.current().runId);
		const markdown = renderAnswers(workingCopy, state.checkpoint.answers);
		assertPlanApprovable(
			state.log.current(),
			gate.stepId,
			current.plan,
			state.checkpoint.answers,
			markdown,
		);
		const saved = await savePlan(state, { ...current.plan, markdown }, "human");
		const agent = PlanVersion.parse(
			JSON.parse(
				new TextDecoder().decode(
					await readArtifact(
						state.deps.store,
						required(state.checkpoint.lastAgentPlan, "agent plan"),
					),
				),
			),
		);
		const metric = await artifact(
			state,
			approvalDiff(agent.plan.markdown, markdown),
			"factory-approval-diff-v1",
		);
		if ((await state.deps.readPlan(state.log.current().runId)) !== workingCopy)
			throw conflict("plan changed during approval; inspect and retry");
		await state.deps.writePlan(state.log.current().runId, markdown);
		await state.deps.workspace.remove(
			required(state.checkpoint.workspace, "workspace"),
		);
		await checkpoint(
			state,
			{ stage: "Approved", plan: saved.ref, approvalMetric: metric },
			[
				...saved.events,
				{ type: "artifact.recorded", artifact: metric, attemptId: null },
				{
					type: "gate.resolved",
					gateId: gate.gateId,
					command: "approve",
					note: null,
				},
				{ type: "step.finished", stepId: gate.stepId, outcome: "succeeded" },
				{ type: "run.ended", outcome: "approved" },
			],
		);
		return handle;
	} finally {
		state.busy = false;
	}
}

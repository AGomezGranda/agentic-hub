import {
	type AgentInput,
	type Finding,
	jsonEnvelope,
	ReviewOutput,
	type RunEventBody,
	VerifiedOutput,
} from "@payo/contracts";
import { fanOut, runAgentStep } from "@payo/kernel";
import { lenses, roleSpec } from "./roles.ts";
import { decideReview } from "./state.ts";
import {
	type MutableFactoryHandle,
	required,
	type StartInput,
} from "./types.ts";

export async function review(
	handle: MutableFactoryHandle,
	ids: string[],
	inputs: AgentInput[],
	signal: AbortSignal,
	roles: StartInput["roles"],
) {
	const { deps, log } = handle;
	const names = Object.keys(lenses) as (keyof typeof lenses)[];
	const reports = await fanOut(
		names.map((lens, i) => async () => {
			const spec = await roleSpec(
				deps.store,
				required(handle.roleArtifacts.reviewer, "reviewer source"),
				"reviewer",
				required(handle.checkpoint.workspace, "workspace"),
				roles.reviewer,
				inputs,
				lens,
			);
			return runAgentStep(
				{ ...deps, log },
				{
					stepId: required(ids[i], "review step"),
					stepName: `review:${lens}`,
					attemptIds: [`${ids[i]}:1`, `${ids[i]}:2`],
					runner: deps.runner,
					spec,
					validate: jsonEnvelope(ReviewOutput),
					signal,
				},
			);
		}),
	);
	const unchecked: string[] = [];
	const findings: Finding[] = [];
	const events: RunEventBody[] = [];
	for (const [i, report] of reports.entries()) {
		if (report.status === "unchecked" || report.value.outcome !== "succeeded") {
			unchecked.push(required(names[i], "review lens"));
			continue;
		}
		const value = ReviewOutput.parse(report.value.value);
		findings.push(...value.findings);
		const ref = await deps.store.putArtifact(
			new TextEncoder().encode(JSON.stringify({ lens: names[i], ...value })),
			{ kind: "factory-review-report-v1", mediaType: "application/json" },
		);
		events.push({ type: "artifact.recorded", artifact: ref, attemptId: null });
	}
	const reviewRef = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify({ findings, unchecked })),
		{ kind: "factory-review-input-v1", mediaType: "application/json" },
	);
	events.push({
		type: "artifact.recorded",
		artifact: reviewRef,
		attemptId: null,
	});
	await log.write(events);
	const id = required(ids.at(-1), "verifier step");
	const spec = await roleSpec(
		deps.store,
		required(handle.roleArtifacts.verifier, "verifier source"),
		"verifier",
		required(handle.checkpoint.workspace, "workspace"),
		roles.verifier,
		[...inputs, { name: "review", ref: reviewRef }],
	);
	const shape = jsonEnvelope(VerifiedOutput);
	const result = await runAgentStep(
		{ ...deps, log },
		{
			stepId: id,
			stepName: "verify",
			attemptIds: [`${id}:1`, `${id}:2`],
			runner: deps.runner,
			spec,
			signal,
			validate(text) {
				const parsed = shape(text);
				if (!parsed.ok) return parsed;
				try {
					decideReview(
						findings,
						VerifiedOutput.parse(parsed.value),
						unchecked,
						handle.checkpoint.round,
					);
					return parsed;
				} catch (error) {
					return {
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},
	);
	if (result.outcome !== "succeeded")
		return { decision: "Escalated" as const, ref: reviewRef };
	const verdicts = VerifiedOutput.parse(result.value);
	const ref = await deps.store.putArtifact(
		new TextEncoder().encode(JSON.stringify({ findings, unchecked, verdicts })),
		{ kind: "factory-review-v1", mediaType: "application/json" },
	);
	await log.write([
		{ type: "artifact.recorded", artifact: ref, attemptId: null },
	]);
	return {
		decision: decideReview(
			findings,
			verdicts,
			unchecked,
			handle.checkpoint.round,
		),
		ref,
	};
}

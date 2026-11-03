import {
	PlanRestoreRequest,
	PlanUpdateRequest,
	PlanVersionDetail,
	PlanVersionList,
	RunIdResponse,
	RunReview,
	type RunSummary,
	RunSummary as RunSummarySchema,
} from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export async function getPlanVersions(
	token: string,
	runId: string,
	signal?: AbortSignal,
): Promise<PlanVersionDetail[]> {
	return (
		await getJson(
			`/runs/${encodeURIComponent(runId)}/plan-versions`,
			token,
			"GET",
			(data) => PlanVersionList.parse(data),
			undefined,
			signal,
		)
	).versions;
}

export async function getPlanVersion(
	token: string,
	runId: string,
	version: number,
	signal?: AbortSignal,
): Promise<PlanVersionDetail> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/plan-versions/${version}`,
		token,
		"GET",
		(data) => PlanVersionDetail.parse(data),
		undefined,
		signal,
	);
}

export async function submitPlanUpdate(
	token: string,
	runId: string,
	input: PlanUpdateRequest | PlanRestoreRequest,
): Promise<{ runId: string }> {
	const update = "prompt" in input;
	return getJson(
		`/runs/${encodeURIComponent(runId)}/${update ? "plan-update" : "plan-restore"}`,
		token,
		"POST",
		(data) => RunIdResponse.parse(data),
		update ? PlanUpdateRequest.parse(input) : PlanRestoreRequest.parse(input),
	);
}

export async function getRunReview(
	token: string,
	runId: string,
	signal?: AbortSignal,
): Promise<RunReview> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/review`,
		token,
		"GET",
		(data) => RunReview.parse(data),
		undefined,
		signal,
	);
}

export async function answerQuestion(
	token: string,
	runId: string,
	questionId: string,
	text: string,
): Promise<RunSummary> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/answer`,
		token,
		"POST",
		(data) => RunSummarySchema.parse(data),
		{ questionId, text },
	);
}

export async function approveRun(
	token: string,
	runId: string,
): Promise<RunSummary> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/approve`,
		token,
		"POST",
		(data) => RunSummarySchema.parse(data),
	);
}

export async function requestChanges(
	token: string,
	runId: string,
): Promise<{ runId: string }> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/request-changes`,
		token,
		"POST",
		(data) => RunIdResponse.parse(data),
	);
}

export async function resumeRun(
	token: string,
	runId: string,
): Promise<{ runId: string }> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/resume`,
		token,
		"POST",
		(data) => RunIdResponse.parse(data),
	);
}

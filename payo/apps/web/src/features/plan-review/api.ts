import {
	RunIdResponse,
	RunReview,
	type RunSummary,
	RunSummary as RunSummarySchema,
} from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

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

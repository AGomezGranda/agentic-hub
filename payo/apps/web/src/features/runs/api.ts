import {
	type RunSummary,
	RunSummaryList,
	RunSummary as RunSummarySchema,
	StartRunResponse,
	type WorkItemRequest,
} from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export interface NewRunInput {
	workItemRequest: WorkItemRequest;
	repo?: string;
	baseBranch?: string;
}

export async function getRun(
	token: string,
	runId: string,
	signal?: AbortSignal,
): Promise<RunSummary> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}`,
		token,
		"GET",
		(data) => RunSummarySchema.parse(data),
		undefined,
		signal,
	);
}

export async function getRuns(token: string): Promise<RunSummary[]> {
	return getJson(
		"/runs",
		token,
		"GET",
		(data) => RunSummaryList.parse(data).runs,
	);
}

export async function startRun(
	token: string,
	input: NewRunInput,
): Promise<{ runId: string }> {
	const body = {
		workItemRequest: input.workItemRequest,
		...(input.repo ? { repo: input.repo } : {}),
		...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
	};
	return getJson(
		"/runs",
		token,
		"POST",
		(data) => StartRunResponse.parse(data),
		body,
	);
}

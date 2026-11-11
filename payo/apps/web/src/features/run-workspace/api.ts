import { EventsResponse, type RunEvent, WorkCostTree } from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export async function getWorkCosts(
	token: string,
	runId: string,
	signal?: AbortSignal,
): Promise<WorkCostTree> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/costs`,
		token,
		"GET",
		(data) => WorkCostTree.parse(data),
		undefined,
		signal,
	);
}

export async function getRunEvents(
	token: string,
	runId: string,
	signal?: AbortSignal,
): Promise<RunEvent[]> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/events`,
		token,
		"GET",
		(data) => EventsResponse.parse(data).events,
		undefined,
		signal,
	);
}

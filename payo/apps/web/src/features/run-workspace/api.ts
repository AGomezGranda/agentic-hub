import { EventsResponse, type RunEvent } from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export async function getRunEvents(
	token: string,
	runId: string,
	signal?: AbortSignal,
	fromSeq?: number,
): Promise<RunEvent[]> {
	return getJson(
		`/runs/${encodeURIComponent(runId)}/events${fromSeq === undefined ? "" : `?${new URLSearchParams({ fromSeq: String(fromSeq) })}`}`,
		token,
		"GET",
		(data) => EventsResponse.parse(data).events,
		undefined,
		signal,
	);
}

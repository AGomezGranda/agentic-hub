import { afterEach, expect, it, vi } from "vitest";
import { getRunEvents } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());
it("requests full history or an incremental sequence with the supplied signal", async () => {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ events: [] })),
	);
	vi.stubGlobal("fetch", fetchMock);
	const signal = new AbortController().signal;
	await getRunEvents("token", "run/id", signal);
	await getRunEvents("token", "run/id", signal, 12);
	expect(fetchMock.mock.calls[0]?.[0]).toContain("/runs/run%2Fid/events");
	expect(fetchMock.mock.calls[0]?.[0]).not.toContain("?");
	expect(fetchMock.mock.calls[1]?.[0]).toContain("?fromSeq=12");
	expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ signal });
});

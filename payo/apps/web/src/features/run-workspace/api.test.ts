import { afterEach, expect, it, vi } from "vitest";
import { getRunEvents } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());
it("requests full history with the supplied signal", async () => {
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify({ events: [] })),
	);
	vi.stubGlobal("fetch", fetchMock);
	const signal = new AbortController().signal;
	await getRunEvents("token", "run/id", signal);
	expect(fetchMock.mock.calls[0]?.[0]).toContain("/runs/run%2Fid/events");
	expect(fetchMock.mock.calls[0]?.[0]).not.toContain("?");
	expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal });
});

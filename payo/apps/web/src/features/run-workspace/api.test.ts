import { afterEach, expect, it, vi } from "vitest";
import { getRunEvents, getWorkCosts } from "./api.ts";

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

it("requests validated costs with an encoded run ID and cancellation signal", async () => {
	const cost = {
		amounts: [],
		coverage: "complete",
		attempts: 0,
		incompleteAttempts: 0,
	};
	const tree = {
		sourceRunId: "plan",
		planning: {
			runId: "plan",
			status: "active",
			outcome: null,
			asOfSeq: 1,
			cost,
			steps: [],
		},
		executions: [],
		total: cost,
	};
	const fetchMock = vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(tree)),
	);
	vi.stubGlobal("fetch", fetchMock);
	const signal = new AbortController().signal;
	expect(await getWorkCosts("token", "run/id", signal)).toEqual(tree);
	expect(fetchMock.mock.calls[0]?.[0]).toContain("/runs/run%2Fid/costs");
	expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal });
	fetchMock.mockImplementation(
		async () =>
			new Response(
				JSON.stringify({ ...tree, total: { ...cost, coverage: "unknown" } }),
			),
	);
	await expect(getWorkCosts("token", "plan")).rejects.toThrow();
});

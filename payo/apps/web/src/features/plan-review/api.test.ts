import { getApiBaseUrl } from "@web/shared/api/client.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
	answerQuestion,
	approveRun,
	getRunReview,
	implementRun,
	requestChanges,
	resumeRun,
} from "./api.ts";

const token = "memory-only-token";
const runId = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const review = {
	plan: { available: false as const, reason: "not_available" as const },
	answers: {},
	review: { available: false as const, reason: "not_available" as const },
};
const summary = {
	runId,
	repo: "/repo",
	baseBranch: "main",
	status: "active",
	outcome: null,
	stage: "Approval",
	workItem: null,
	startedAt: "2026-10-30T00:00:00.000Z",
	updatedAt: "2026-10-30T00:01:00.000Z",
	openGates: [],
};

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => vi.unstubAllGlobals());

it("loads the validated review projection using the selected run URL", async () => {
	const fetchMock = vi.fn(async () => response(review));
	vi.stubGlobal("fetch", fetchMock);

	expect(await getRunReview(token, runId)).toEqual(review);
	expect(fetchMock).toHaveBeenCalledWith(
		`${getApiBaseUrl()}/runs/${runId}/review`,
		expect.objectContaining({
			method: "GET",
			headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
		}),
	);
});

it("sends answers and only the gate-specific commands", async () => {
	const fetchMock = vi.fn(
		async (_url: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST" && String(_url).endsWith("/answer"))
				return response(summary);
			if (init?.method === "POST" && String(_url).endsWith("/approve"))
				return response(summary);
			return response({ runId });
		},
	);
	vi.stubGlobal("fetch", fetchMock);

	await answerQuestion(token, runId, "q1", "Because");
	await approveRun(token, runId);
	await requestChanges(token, runId);
	await resumeRun(token, runId);

	expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
		`${getApiBaseUrl()}/runs/${runId}/answer`,
		`${getApiBaseUrl()}/runs/${runId}/approve`,
		`${getApiBaseUrl()}/runs/${runId}/request-changes`,
		`${getApiBaseUrl()}/runs/${runId}/resume`,
	]);
	expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
		method: "POST",
		body: JSON.stringify({ questionId: "q1", text: "Because" }),
	});
});

it("launches with default or explicit base", async () => {
	const fetchMock = vi.fn(
		async (_url: RequestInfo | URL, _init?: RequestInit) => response({ runId }),
	);
	vi.stubGlobal("fetch", fetchMock);
	await implementRun(token, runId, { prId: "one" });
	await implementRun(token, runId, { prId: "two", base: "branch" });
	expect(
		fetchMock.mock.calls.map(([url, init]) => [
			String(url),
			JSON.parse(String(init?.body)),
		]),
	).toEqual([
		[`${getApiBaseUrl()}/runs/${runId}/implement`, { prId: "one" }],
		[
			`${getApiBaseUrl()}/runs/${runId}/implement`,
			{ prId: "two", base: "branch" },
		],
	]);
});

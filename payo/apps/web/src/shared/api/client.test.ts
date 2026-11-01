import { afterEach, expect, it, vi } from "vitest";
import { API_BASE_URL, getJson, PayoApiError } from "./client.ts";

afterEach(() => vi.unstubAllGlobals());

it("forwards authentication, cancellation and response validation for a GET", async () => {
	const fetchMock = vi.fn(async () => Response.json({ value: 42 }));
	vi.stubGlobal("fetch", fetchMock);
	const parse = vi.fn((data: unknown) => data);
	const controller = new AbortController();

	expect(
		await getJson(
			"/example",
			"token",
			"GET",
			parse,
			undefined,
			controller.signal,
		),
	).toEqual({ value: 42 });
	expect(parse).toHaveBeenCalledWith({ value: 42 });
	expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/example`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: "Bearer token" },
		signal: controller.signal,
	});
});

it.each([
	[
		Response.json(
			{ code: "conflict", message: "Run changed" },
			{ status: 409 },
		),
		409,
		"conflict",
		"Run changed",
	],
	[
		new Response("Unavailable", { status: 503 }),
		503,
		"request_failed",
		"The server returned an error.",
	],
])(
	"preserves server status with a safe error fallback (%s)",
	async (response, status, code, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		const parse = vi.fn();
		const result = getJson("/example", "token", "GET", parse);
		await expect(result).rejects.toBeInstanceOf(PayoApiError);
		await expect(result).rejects.toMatchObject({ status, code, message });
		expect(parse).not.toHaveBeenCalled();
	},
);

it("propagates response-schema failures instead of returning unchecked data", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ unexpected: true })),
	);
	const failure = new Error("Invalid response schema");
	await expect(
		getJson("/example", "token", "GET", () => {
			throw failure;
		}),
	).rejects.toBe(failure);
});

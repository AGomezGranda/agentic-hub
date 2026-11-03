import { afterEach, expect, it, vi } from "vitest";
import {
	DEFAULT_SERVER_PORT,
	getApiBaseUrl,
	getJson,
	getServerPort,
	PayoApiError,
	setServerPort,
} from "./client.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

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
	expect(fetchMock).toHaveBeenCalledWith(`${getApiBaseUrl()}/example`, {
		method: "GET",
		headers: { Accept: "application/json", Authorization: "Bearer token" },
		signal: controller.signal,
	});
});

it("sends a PUT body to the selected loopback port", async () => {
	setServerPort(8123);
	const fetchMock = vi.fn(async () => Response.json({ saved: true }));
	vi.stubGlobal("fetch", fetchMock);
	const body = { revision: "abc", document: { server: { port: 8123 } } };

	await getJson("/settings/config", "token", "PUT", (data) => data, body);

	expect(fetchMock).toHaveBeenCalledWith(
		"http://127.0.0.1:8123/api/v1/settings/config",
		{
			method: "PUT",
			headers: {
				Accept: "application/json",
				Authorization: "Bearer token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: undefined,
		},
	);
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

it("validates and persists only the loopback port for the browser session", async () => {
	expect(getServerPort()).toBe(DEFAULT_SERVER_PORT);
	expect(getApiBaseUrl()).toBe(
		`http://127.0.0.1:${DEFAULT_SERVER_PORT}/api/v1`,
	);

	setServerPort(8123);
	expect(getServerPort()).toBe(8123);
	expect(getApiBaseUrl()).toBe("http://127.0.0.1:8123/api/v1");
	expect(sessionStorage.getItem("payo.server-port")).toBe("8123");

	expect(() => setServerPort(0)).toThrow(/between 1 and 65535/);
	expect(() => setServerPort(65536)).toThrow(/between 1 and 65535/);
	expect(() => setServerPort(1.5)).toThrow(/between 1 and 65535/);
	expect(getServerPort()).toBe(8123);

	sessionStorage.setItem("payo.server-port", "not-a-port");
	expect(getServerPort()).toBe(DEFAULT_SERVER_PORT);
});

it("survives a module reload with the port but never stores a token", async () => {
	setServerPort(7444);
	vi.resetModules();
	const reloaded = await import("./client.ts");

	expect(reloaded.getServerPort()).toBe(7444);
	const keys = Array.from({ length: sessionStorage.length }, (_, index) =>
		sessionStorage.key(index),
	);
	expect(keys).toEqual(["payo.server-port"]);
});

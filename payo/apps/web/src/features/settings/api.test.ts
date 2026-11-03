import { getApiBaseUrl, PayoApiError } from "@web/shared/api/client.ts";
import { afterEach, expect, it, vi } from "vitest";
import { getConfigSettings, saveConfigSettings } from "./api.ts";

const snapshot = {
	configFile: "/home/me/.config/payo/config.toml",
	revision: "revision-1",
	document: { server: { port: 7331 } },
	environmentOverrides: ["PAYO_MODEL"],
};

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

it("parses the config snapshot from an authenticated GET", async () => {
	const fetchMock = vi.fn(async () => jsonResponse(200, snapshot));
	vi.stubGlobal("fetch", fetchMock);

	await expect(getConfigSettings("token")).resolves.toEqual(snapshot);
	expect(fetchMock).toHaveBeenCalledWith(
		`${getApiBaseUrl()}/settings/config`,
		expect.objectContaining({
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: "Bearer token",
			},
		}),
	);
});

it("sends only the document and expected revision on PUT", async () => {
	const fetchMock = vi.fn(async () => jsonResponse(200, snapshot));
	vi.stubGlobal("fetch", fetchMock);
	const request = {
		revision: "revision-1",
		document: { paths: { base_branch: "main" } },
	};

	await expect(saveConfigSettings("token", request)).resolves.toEqual(snapshot);
	expect(fetchMock).toHaveBeenCalledWith(
		`${getApiBaseUrl()}/settings/config`,
		expect.objectContaining({
			method: "PUT",
			headers: {
				Accept: "application/json",
				Authorization: "Bearer token",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		}),
	);
});

it("rejects malformed snapshots and returns safe server errors", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => jsonResponse(200, { unexpected: true })),
	);
	await expect(getConfigSettings("token")).rejects.toBeInstanceOf(Error);

	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			jsonResponse(409, {
				code: "conflict",
				message: "config file changed since it was loaded",
			}),
		),
	);
	await expect(
		saveConfigSettings("token", { revision: "old", document: {} }),
	).rejects.toMatchObject({
		status: 409,
		code: "conflict",
		message: "config file changed since it was loaded",
	});
	await expect(
		saveConfigSettings("token", { revision: "old", document: {} }),
	).rejects.toBeInstanceOf(PayoApiError);
});

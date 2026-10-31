import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	CliClient,
	ClientError,
	resolveDataDir,
	SseParser,
	serverUrl,
} from "./client.ts";
import { runCli } from "./index.ts";

const runId = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const summary = {
	runId,
	repo: "/repo",
	baseBranch: "main",
	status: "active",
	outcome: null,
	stage: "Approval",
	startedAt: "2026-10-30T00:00:00.000Z",
	updatedAt: "2026-10-30T00:01:00.000Z",
	openGates: [],
};

async function dataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "payo-cli-"));
	await writeFile(join(dir, "server-token"), "secret\n", { mode: 0o600 });
	return dir;
}

it("resolves the same data directory default as the server", () => {
	expect(resolveDataDir({ PAYO_DATA_DIR: "/tmp/payo" })).toBe("/tmp/payo");
	expect(resolveDataDir({}).endsWith("/.payo")).toBe(true);
});

it("uses the test server URL only in test mode", () => {
	expect(
		serverUrl({
			NODE_ENV: "test",
			PAYO_TEST_SERVER_URL: "http://127.0.0.1:4444/",
		}),
	).toBe("http://127.0.0.1:4444");
	expect(
		serverUrl({
			NODE_ENV: "production",
			PAYO_TEST_SERVER_URL: "http://127.0.0.1:4444",
		}),
	).toBe("http://127.0.0.1:7331");
});

it("sends a bearer token and no Origin header", async () => {
	let init: RequestInit | undefined;
	const fetchImpl = vi.fn(async (_url: string, options?: RequestInit) => {
		init = options;
		return new Response(JSON.stringify(summary), { status: 200 });
	}) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);

	expect(await client.summary(runId)).toEqual(summary);
	const headers = (init?.headers ?? {}) as Record<string, string>;
	expect(headers.Authorization).toBe("Bearer secret");
	expect(headers.Origin).toBeUndefined();
});

it("validates responses against the contract", async () => {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ runId: "not-a-uuid" }), {
			status: 200,
		})) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);
	await expect(client.summary(runId)).rejects.toThrow();
});

it("validates doctor responses against the contract", async () => {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				ok: true,
				checks: [{ name: "", ok: true, detail: "" }],
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);
	await expect(client.doctor()).rejects.toThrow();
});

async function serveReport(report: unknown): Promise<{
	url: string;
	close(): Promise<void>;
}> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(report));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

it("prints doctor checks and maps the report to an exit code", async () => {
	const dir = await dataDir();
	const env = (url: string) => ({
		PAYO_DATA_DIR: dir,
		NODE_ENV: "test",
		PAYO_TEST_SERVER_URL: url,
	});

	const failed = await serveReport({
		ok: false,
		checks: [
			{ name: "pi", ok: true, detail: "ready" },
			{ name: "acli", ok: false, detail: "not logged in" },
		],
	});
	try {
		const output: string[] = [];
		const code = await runCli(["doctor"], {
			env: env(failed.url),
			stdout: (text) => output.push(text),
			stderr: () => {},
		});
		expect(code).toBe(1);
		expect(output.join("")).toBe("ok pi: ready\nFAIL acli: not logged in\n");
	} finally {
		await failed.close();
	}

	const healthy = await serveReport({
		ok: true,
		checks: [{ name: "pi", ok: true, detail: "ready" }],
	});
	try {
		const output: string[] = [];
		const code = await runCli(["doctor"], {
			env: env(healthy.url),
			stdout: (text) => output.push(text),
			stderr: () => {},
		});
		expect(code).toBe(0);
		expect(output.join("")).toBe("ok pi: ready\n");
	} finally {
		await healthy.close();
	}
});

it("maps server errors to a structured client error", async () => {
	const fetchImpl = (async () =>
		new Response(JSON.stringify({ code: "busy", message: "factory busy" }), {
			status: 409,
		})) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);
	const error = await client.approve(runId).catch((value: unknown) => value);
	expect(error).toBeInstanceOf(ClientError);
	expect(error).toMatchObject({
		status: 409,
		code: "busy",
		message: "factory busy",
	});
});

it("parses SSE blocks across chunks and tracks IDs", () => {
	const parser = new SseParser();
	expect(parser.push('id: 1\ndata: {"a":')).toEqual([]);
	expect(parser.push("1}\n\nid: 2\ndata: ok\n\n")).toEqual([
		{ id: 1, data: '{"a":1}' },
		{ id: 2, data: "ok" },
	]);
	expect(parser.push(": heartbeat\n\n")).toEqual([]);
});

it("sends the SSE cursor and stops at run.ended", async () => {
	let url = "";
	let headers: Record<string, string> = {};
	const event = {
		type: "run.ended",
		outcome: "approved",
		seq: 4,
		at: "2026-10-30T00:00:00.000Z",
	};
	const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
		url = input;
		headers = init?.headers as Record<string, string>;
		return new Response(`id: 4\ndata: ${JSON.stringify(event)}\n\n`, {
			status: 200,
		});
	}) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);
	const seen: string[] = [];
	await client.stream(runId, (value) => seen.push(value.type), {
		fromSeq: 4,
		lastEventId: 3,
	});
	expect(url).toContain("fromSeq=4");
	expect(headers["Last-Event-ID"]).toBe("3");
	expect(headers.Authorization).toBe("Bearer secret");
	expect(seen).toEqual(["run.ended"]);
});

it("prints the token only for the explicit token command", async () => {
	const dir = await dataDir();
	const output: string[] = [];
	expect(
		await runCli(["token"], {
			env: { PAYO_DATA_DIR: dir },
			stdout: (text) => output.push(text),
			stderr: () => {},
		}),
	).toBe(0);
	expect(output.join("")).toBe("secret\n");
});

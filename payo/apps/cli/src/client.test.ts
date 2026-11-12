import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import {
	CliClient,
	ClientError,
	resolveDataDir,
	SseParser,
	serverUrl,
} from "./client.ts";
import { runCli as runUnisolatedCli } from "./index.ts";

const testHome = mkdtempSync(join(tmpdir(), "payo-cli-test-home-"));
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

async function runCli(
	argv: readonly string[],
	io: Parameters<typeof runUnisolatedCli>[1] = {},
): Promise<number> {
	return runUnisolatedCli(argv, {
		...io,
		env: { HOME: testHome, ...io.env },
	});
}

const runId = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
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

async function dataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "payo-cli-"));
	await writeFile(join(dir, "server-token"), "secret\n", { mode: 0o600 });
	return dir;
}

it("resolves the same data directory default as the server", () => {
	expect(resolveDataDir({ HOME: testHome, PAYO_DATA_DIR: "/tmp/payo" })).toBe(
		"/tmp/payo",
	);
	expect(resolveDataDir({ HOME: testHome })).toBe(join(testHome, ".payo"));
});

it("keeps the environment-only bootstrap when the default config file is absent", async () => {
	const home = await mkdtemp(join(tmpdir(), "payo-cli-home-"));
	try {
		expect(resolveDataDir({ HOME: home })).toBe(join(home, ".payo"));
		expect(resolveDataDir({ HOME: home, PAYO_DATA_DIR: "/tmp/env-payo" })).toBe(
			"/tmp/env-payo",
		);
		expect(serverUrl({ HOME: home })).toBe("http://127.0.0.1:7331");
		expect(serverUrl({ HOME: home, PAYO_PORT: "7444" })).toBe(
			"http://127.0.0.1:7444",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

it("uses the shared TOML data directory and configured port with env precedence", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-cli-config-"));
	const path = join(dir, "config.toml");
	await writeFile(
		path,
		`[server]
port = 7444
[paths]
data_dir = "${join(dir, "file-data")}"`,
	);
	const env = { PAYO_CONFIG_FILE: path };
	expect(resolveDataDir(env)).toBe(join(dir, "file-data"));
	expect(serverUrl(env)).toBe("http://127.0.0.1:7444");
	expect(resolveDataDir({ ...env, PAYO_DATA_DIR: join(dir, "env-data") })).toBe(
		join(dir, "env-data"),
	);
	expect(serverUrl({ ...env, PAYO_PORT: "7555" })).toBe(
		"http://127.0.0.1:7555",
	);
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
			HOME: testHome,
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

it("posts explicit implementation acceptance and returns its execution ID", async () => {
	let request: { url: string; init?: RequestInit } | undefined;
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		request = { url, init };
		return new Response(JSON.stringify({ runId }), { status: 202 });
	}) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);

	expect(
		await client.implement("approved-run", { prId: "pr-1", base: "payo/pr-0" }),
	).toBe(runId);
	expect(request?.url).toContain("/api/v1/runs/approved-run/implement");
	expect(JSON.parse(String(request?.init?.body))).toEqual({
		prId: "pr-1",
		base: "payo/pr-0",
	});
});

it("posts canonical prompt and Jira start requests and returns the run ID", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
		requests.push({ url, init });
		return new Response(JSON.stringify({ runId }), { status: 202 });
	}) as unknown as typeof fetch;
	const client = new CliClient("http://127.0.0.1:7331", "secret", fetchImpl);

	expect(
		await client.start({
			workItemRequest: { source: "prompt", text: "Create a todo app" },
		}),
	).toBe(runId);
	expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
		workItemRequest: { source: "prompt", text: "Create a todo app" },
	});
	expect(
		await client.start({ workItemRequest: { source: "jira", key: "ABC-123" } }),
	).toBe(runId);
	expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
		workItemRequest: { source: "jira", key: "ABC-123" },
	});
});

it("serializes the legacy-compatible Jira CLI command canonically", async () => {
	const dir = await dataDir();
	let body: unknown;
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ runId }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	try {
		const output: string[] = [];
		expect(
			await runCli(["start", "ABC-123"], {
				env: {
					PAYO_DATA_DIR: dir,
					NODE_ENV: "test",
					PAYO_TEST_SERVER_URL: `http://127.0.0.1:${port}`,
				},
				stdout: (text) => output.push(text),
				stderr: () => {},
			}),
		).toBe(0);
		expect(body).toEqual({
			workItemRequest: { source: "jira", key: "ABC-123" },
		});
		expect(output).toEqual([`${runId}\n`]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("runs implement and prints the linked execution ID", async () => {
	const dir = await dataDir();
	const server = await serveReport({ runId });
	try {
		const output: string[] = [];
		const code = await runCli(
			["implement", runId, "--pr", "pr-1", "--confirm", "hash", "--no-ticket"],
			{
				env: {
					PAYO_DATA_DIR: dir,
					NODE_ENV: "test",
					PAYO_TEST_SERVER_URL: server.url,
				},
				stdout: (text) => output.push(text),
				stderr: () => {},
			},
		);
		expect(code).toBe(0);
		expect(output).toEqual([`${runId}\n`]);
	} finally {
		await server.close();
	}
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

it("parses split CRLF and fields without spaces", () => {
	const parser = new SseParser();
	const blocks = ["id: 1\r", "\ndata:{}\r", "\n\r", "\n"].flatMap((chunk) =>
		parser.push(chunk),
	);
	expect(blocks).toEqual([{ id: 1, data: "{}" }]);
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

it.each(["invalid JSON", "callback failure"])(
	"cancels the stream on %s",
	async (failure) => {
		const cancel = vi.fn();
		const event = {
			type: "run.ended",
			outcome: "approved",
			seq: 4,
			at: "2026-10-30T00:00:00.000Z",
		};
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${failure === "invalid JSON" ? "{" : JSON.stringify(event)}\n\n`,
					),
				);
			},
			cancel,
		});
		const client = new CliClient(
			"http://localhost",
			"secret",
			(async () => new Response(stream)) as typeof fetch,
		);
		await expect(
			client.stream(runId, () => {
				throw new Error("callback failed");
			}),
		).rejects.toThrow();
		expect(cancel).toHaveBeenCalledOnce();
	},
);

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

it("previews without implementation and sends explicit edited publication", async () => {
	const requests: Array<{ url: string; body: unknown }> = [];
	const preview = {
		candidates: ["ABC-1"],
		ticketId: "ABC-1",
		slug: "create-new-entity",
		branch: "ABC-1/create-new-entity",
		errors: {},
		previewHash: "hash",
	};
	const client = new CliClient("http://localhost", "secret", (async (
		url: string,
		init: RequestInit,
	) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(
			JSON.stringify(url.endsWith("implement-preview") ? preview : { runId }),
		);
	}) as typeof fetch);
	expect(await client.implementPreview(runId, { prId: "p" })).toEqual(preview);
	expect(requests).toEqual([
		{
			url: `http://localhost/api/v1/runs/${runId}/implement-preview`,
			body: { prId: "p" },
		},
	]);
	expect(
		await client.publish(runId, {
			previewHash: "hash",
			title: "[ABC-1] New entity",
			body: "line one\nline two",
		}),
	).toBe(runId);
	expect(requests[1]?.body).toEqual({
		previewHash: "hash",
		title: "[ABC-1] New entity",
		body: "line one\nline two",
	});
});

it("prints an implementation preview without accepting it", async () => {
	const dir = await dataDir();
	const preview = {
		candidates: [],
		ticketId: null,
		slug: "",
		errors: {},
		previewHash: "hash",
	};
	const requests: string[] = [];
	const server = createServer((req, res) => {
		requests.push(req.url ?? "");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(preview));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const output: string[] = [];
		expect(
			await runCli(["implement", runId, "--pr", "p"], {
				env: {
					PAYO_DATA_DIR: dir,
					NODE_ENV: "test",
					PAYO_TEST_SERVER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				},
				stdout: (t) => output.push(t),
				stderr: () => {},
			}),
		).toBe(0);
		expect(requests).toEqual([`/api/v1/runs/${runId}/implement-preview`]);
		expect(output.join("")).toContain("--confirm");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

it("reports missing publication body files without posting", async () => {
	const dir = await dataDir();
	const error: string[] = [];
	expect(
		await runCli(
			[
				"publish",
				runId,
				"--confirm",
				"hash",
				"--body-file",
				join(dir, "absent"),
			],
			{
				env: { PAYO_DATA_DIR: dir },
				stdout: () => {},
				stderr: (t) => error.push(t),
			},
		),
	).toBe(1);
	expect(error.join("")).toContain("ENOENT");
});

it("surfaces stale preview errors without retrying publication", async () => {
	const request = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ code: "conflict", message: "stale preview" }),
				{ status: 409 },
			),
	);
	const client = new CliClient(
		"http://localhost",
		"secret",
		request as typeof fetch,
	);
	await expect(
		client.publish(runId, { previewHash: "old" }),
	).rejects.toMatchObject({ status: 409, message: "stale preview" });
	expect(request).toHaveBeenCalledOnce();
});

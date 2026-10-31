import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSummary } from "@payo/contracts";
import { afterEach, expect, it } from "vitest";
import { ensureServerToken } from "./auth.ts";
import { type Composition, createComposition } from "./composition.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import { createHandler } from "./http.ts";

interface Harness {
	dataDir: string;
	token: string;
	composition: Composition;
	server: Server;
	port: number;
}

const harnesses: Harness[] = [];

async function setup(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-http-"));
	const config: ServerConfig = loadConfig(
		{
			PAYO_DATA_DIR: dataDir,
			PAYO_REPO: dataDir,
			NODE_ENV: "test",
			PAYO_TEST_PORT: "0",
			...env,
		},
		["--dev-fakes"],
		dataDir,
	);
	const token = await ensureServerToken(dataDir);
	const composition = await createComposition({
		config,
		doctor: async () => ({
			ok: true,
			checks: [{ name: "pi", ok: true, detail: "ready" }],
		}),
	});
	let port = 0;
	const server = createServer(
		createHandler({
			token,
			webOrigins: config.webOrigins,
			getPort: () => port,
			getServices: () => composition,
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	const harness = { dataDir, token, composition, server, port };
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	while (harnesses.length) {
		const harness = harnesses.pop();
		if (!harness) break;
		await harness.composition.shutdown();
		await new Promise<void>((resolve) => harness.server.close(() => resolve()));
	}
});

async function api(
	harness: Harness,
	path: string,
	options: {
		method?: string;
		token?: string | null;
		body?: unknown;
		headers?: Record<string, string>;
	} = {},
) {
	const headers: Record<string, string> = {
		...(options.token === null
			? {}
			: { Authorization: `Bearer ${options.token ?? harness.token}` }),
		...options.headers,
	};
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, {
		method: options.method ?? "GET",
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text ? JSON.parse(text) : null,
		headers: response.headers,
	};
}

function raw(
	harness: Harness,
	options: {
		method: string;
		path: string;
		headers?: Record<string, string>;
		body?: string;
	},
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const socket = connect(harness.port, "127.0.0.1");
		let data = "";
		socket.on("connect", () => {
			const body = options.body ?? "";
			const headers: Record<string, string> = {
				Host: `127.0.0.1:${harness.port}`,
				Connection: "close",
				"Content-Length": String(Buffer.byteLength(body)),
				...options.headers,
			};
			socket.write(
				`${options.method} ${options.path} HTTP/1.1\r\n${Object.entries(headers)
					.map(([key, value]) => `${key}: ${value}`)
					.join("\r\n")}\r\n\r\n${body}`,
			);
		});
		socket.on("data", (chunk) => {
			data += chunk.toString();
		});
		socket.on("end", () => {
			const [head, ...rest] = data.split("\r\n\r\n");
			const status = Number(head?.split(" ")[1]);
			resolve({ status, body: rest.join("\r\n\r\n") });
		});
		socket.on("error", reject);
	});
}

async function startRun(harness: Harness): Promise<string> {
	const response = await api(harness, "/api/v1/runs", {
		method: "POST",
		body: { ticketKey: "ABC-123" },
	});
	expect(response.status).toBe(202);
	return response.body.runId;
}

async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out");
}

async function summary(harness: Harness, runId: string): Promise<RunSummary> {
	const response = await api(harness, `/api/v1/runs/${runId}`);
	expect(response.status).toBe(200);
	return response.body;
}

async function approveRun(harness: Harness, runId: string): Promise<void> {
	const answer = await api(harness, `/api/v1/runs/${runId}/answer`, {
		method: "POST",
		body: { questionId: "q1", text: "Because" },
	});
	expect(answer.status).toBe(200);
	const approved = await api(harness, `/api/v1/runs/${runId}/approve`, {
		method: "POST",
	});
	expect(approved.status).toBe(200);
}

async function sse(
	harness: Harness,
	path: string,
	until: (events: Array<{ id: number; event: { type: string } }>) => boolean,
	headers: Record<string, string> = {},
): Promise<Array<{ id: number; event: { type: string } }>> {
	const controller = new AbortController();
	const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, {
		headers: {
			Authorization: `Bearer ${harness.token}`,
			Accept: "text/event-stream",
			...headers,
		},
		signal: controller.signal,
	});
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing body");
	const decoder = new TextDecoder();
	const events: Array<{ id: number; event: { type: string } }> = [];
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n\n");
			while (index >= 0) {
				const block = buffer.slice(0, index);
				buffer = buffer.slice(index + 2);
				let id = 0;
				let data = "";
				for (const line of block.split("\n")) {
					if (line.startsWith("id: ")) id = Number(line.slice(4));
					if (line.startsWith("data: ")) data += line.slice(6);
				}
				if (data) events.push({ id, event: JSON.parse(data) });
				if (until(events)) {
					await reader.cancel();
					return events;
				}
				index = buffer.indexOf("\n\n");
			}
		}
		return events;
	} finally {
		controller.abort();
	}
}

it("rejects unauthorized, hostile Host and hostile Origin requests", async () => {
	const harness = await setup({ PAYO_WEB_ORIGINS: "http://localhost:5173" });

	expect((await api(harness, "/api/v1/runs", { token: null })).status).toBe(
		401,
	);
	expect((await api(harness, "/api/v1/runs", { token: "wrong" })).status).toBe(
		401,
	);
	expect(
		(
			await raw(harness, {
				method: "GET",
				path: "/api/v1/runs",
				headers: {
					Host: "evil.example",
					Authorization: `Bearer ${harness.token}`,
				},
			})
		).status,
	).toBe(403);
	expect(
		(
			await api(harness, "/api/v1/runs", {
				headers: { Origin: "http://evil.example" },
			})
		).status,
	).toBe(403);
});

it("allows an exact-origin preflight without a token, then requires the token", async () => {
	const harness = await setup({
		PAYO_WEB_ORIGINS: "http://localhost:5173",
	});
	const preflight = await api(harness, "/api/v1/runs", {
		method: "OPTIONS",
		token: null,
		headers: { Origin: "http://localhost:5173" },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe(
		"http://localhost:5173",
	);
	expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");

	const actual = await api(harness, "/api/v1/runs", {
		method: "POST",
		token: null,
		body: { ticketKey: "ABC-123" },
		headers: { Origin: "http://localhost:5173" },
	});
	expect(actual.status).toBe(401);
});

it("serves the doctor report behind the token and rejects other methods", async () => {
	const harness = await setup();
	const report = await api(harness, "/api/v1/doctor");
	expect(report.status).toBe(200);
	expect(report.body).toEqual({
		ok: true,
		checks: [{ name: "pi", ok: true, detail: "ready" }],
	});
	expect((await api(harness, "/api/v1/doctor", { token: null })).status).toBe(
		401,
	);
	expect(
		(await api(harness, "/api/v1/doctor", { method: "POST" })).status,
	).toBe(405);
	expect((await api(harness, "/api/v1/doctor/anything")).status).toBe(404);
});

it("validates bodies, run IDs and unknown runs", async () => {
	const harness = await setup();
	expect(
		(await api(harness, "/api/v1/runs", { method: "POST", body: {} })).status,
	).toBe(400);
	expect(
		(
			await api(harness, "/api/v1/runs", {
				method: "POST",
				body: { ticketKey: "ABC-123", repo: "relative" },
			})
		).status,
	).toBe(400);
	expect((await api(harness, "/api/v1/runs/not-a-uuid")).status).toBe(400);
	expect(
		(await api(harness, "/api/v1/runs/6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e"))
			.status,
	).toBe(404);
	expect(
		(
			await api(harness, "/api/v1/runs", {
				method: "PUT",
			})
		).status,
	).toBe(405);
});

it("starts promptly, lists and reports JSON summaries, and reaches approval", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	expect(runId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
	);

	const listed = await api(harness, "/api/v1/runs");
	expect(listed.status).toBe(200);
	expect(listed.body.runs).toHaveLength(1);
	expect(listed.body.runs[0]).toMatchObject({
		runId,
		status: "active",
		repo: harness.dataDir,
		baseBranch: "main",
	});

	const initial = await summary(harness, runId);
	expect(initial.stage).toBeDefined();
	expect(initial.openGates).toEqual([]);

	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	const approval = await summary(harness, runId);
	expect(approval.stage).toBe("Approval");
	expect(approval.openGates).toHaveLength(1);
	expect(approval.openGates[0]).toMatchObject({ kind: "approval" });
	expect(JSON.parse(JSON.stringify(approval))).toEqual(approval);
});

it("returns events from fromSeq and streams ordered IDs until run.ended", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	await approveRun(harness, runId);

	const all = await api(harness, `/api/v1/runs/${runId}/events`);
	expect(all.status).toBe(200);
	expect(all.body.events.at(-1)).toMatchObject({
		type: "run.ended",
		outcome: "approved",
	});

	const replay = await api(harness, `/api/v1/runs/${runId}/events?fromSeq=3`);
	expect(replay.body.events[0].seq).toBe(3);
	expect(replay.body.events.map((event: { seq: number }) => event.seq)).toEqual(
		all.body.events.slice(2).map((event: { seq: number }) => event.seq),
	);
	expect(
		(await api(harness, `/api/v1/runs/${runId}/events?fromSeq=0`)).status,
	).toBe(400);

	const first = await sse(
		harness,
		`/api/v1/runs/${runId}/events/stream`,
		(events) => events.length >= 3,
	);
	const last = first.at(-1);
	if (!last) throw new Error("missing event");
	const reconnected = await sse(
		harness,
		`/api/v1/runs/${runId}/events/stream`,
		(events) => events.some((item) => item.event.type === "run.ended"),
		{ "Last-Event-ID": String(last.id) },
	);
	expect(reconnected[0]?.id).toBe(last.id + 1);
	const ids = [...first, ...reconnected].map((item) => item.id);
	expect(ids).toEqual([...ids].sort((a, b) => a - b));
	expect(new Set(ids).size).toBe(ids.length);
});

it("does not cancel a run when the start connection disconnects", async () => {
	const harness = await setup();
	const body = JSON.stringify({ ticketKey: "ABC-123" });
	await new Promise<void>((resolve, reject) => {
		const socket = connect(harness.port, "127.0.0.1");
		socket.on("connect", () => {
			socket.write(
				`POST /api/v1/runs HTTP/1.1\r\nHost: 127.0.0.1:${harness.port}\r\nAuthorization: Bearer ${harness.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 10);
		});
		socket.on("error", reject);
	});

	await waitFor(async () => {
		const listed = await api(harness, "/api/v1/runs");
		return listed.body.runs.length === 1;
	});
	const listed = await api(harness, "/api/v1/runs");
	const runId = listed.body.runs[0]?.runId;
	if (!runId) throw new Error("missing run");
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	expect((await summary(harness, runId)).openGates[0]?.kind).toBe("approval");
});

it("rejects invalid commands and does not accept them with 202", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);

	const unknown = await api(harness, `/api/v1/runs/${runId}/answer`, {
		method: "POST",
		body: { questionId: "missing", text: "yes" },
	});
	expect(unknown.status).toBe(400);
	expect(unknown.body.code).toBe("invalid_request");

	const blank = await api(harness, `/api/v1/runs/${runId}/answer`, {
		method: "POST",
		body: { questionId: "q1", text: " " },
	});
	expect(blank.status).toBe(400);
	expect(blank.body.code).toBe("invalid_request");

	const notResumable = await api(harness, `/api/v1/runs/${runId}/resume`, {
		method: "POST",
	});
	expect(notResumable.status).toBe(409);
	expect(notResumable.body.code).toBe("conflict");

	await approveRun(harness, runId);

	const notAwaitingApproval = await api(
		harness,
		`/api/v1/runs/${runId}/request-changes`,
		{ method: "POST" },
	);
	expect(notAwaitingApproval.status).toBe(409);
	expect(notAwaitingApproval.body.code).toBe("conflict");
});

it("returns 503 until recovery completes", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-http-"));
	const token = await ensureServerToken(dataDir);
	let port = 0;
	const server = createServer(
		createHandler({
			token,
			webOrigins: [],
			getPort: () => port,
			getServices: () => null,
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/v1/runs`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe("starting");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

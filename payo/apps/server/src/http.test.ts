import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPayoConfig, readPayoConfigDocument } from "@payo/config";
import {
	ExecutionRunConfig as ExecutionRunConfigSchema,
	type RunSummary,
	type WorkItem,
	type WorkItemRequest,
} from "@payo/contracts";
import { QUALITY_EXPECTATIONS } from "@payo/factory";
import type { FakeStep } from "@payo/runner-fake";
import { afterEach, expect, it } from "vitest";
import type { AdapterSet } from "./adapters.ts";
import { ensureServerToken } from "./auth.ts";
import { type Composition, createComposition } from "./composition.ts";
import { loadConfig, type ServerConfig } from "./config.ts";
import {
	createFakeRunner,
	envelope,
	fakeWorkspace,
} from "./factory-fixtures.ts";
import { createHandler } from "./http.ts";
import { createConfigSettingsService } from "./settings.ts";

interface Harness {
	dataDir: string;
	configFile: string;
	token: string;
	composition: Composition;
	server: Server;
	port: number;
}

const harnesses: Harness[] = [];

async function setup(
	env: NodeJS.ProcessEnv = {},
	adapters?: AdapterSet,
	configContents = "",
): Promise<Harness> {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-http-"));
	const configFile = env.PAYO_CONFIG_FILE ?? join(dataDir, "config.toml");
	if (env.PAYO_CONFIG_FILE === undefined)
		writeFileSync(configFile, configContents);
	const serverEnv = {
		PAYO_DATA_DIR: dataDir,
		PAYO_REPO: dataDir,
		NODE_ENV: "test",
		PAYO_TEST_PORT: "0",
		...env,
		PAYO_CONFIG_FILE: configFile,
	};
	const config: ServerConfig = loadConfig(serverEnv, ["--dev-fakes"], dataDir);
	const configSettings = createConfigSettingsService({
		configFile: config.configFile,
		env: serverEnv,
		cwd: dataDir,
		devFakes: config.devFakes,
	});
	const token = await ensureServerToken(dataDir);
	const composition = await createComposition({
		config,
		...(adapters ? { adapters } : {}),
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
			configSettings,
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	const harness = {
		dataDir,
		configFile,
		token,
		composition,
		server,
		port,
	};
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
): Promise<{ status: number; headers: string; body: string }> {
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
			resolve({ status, headers: head ?? "", body: rest.join("\r\n\r\n") });
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

it("preserves CORS for allowed-origin failures, but not rejected host or origin", async () => {
	const origin = "http://127.0.0.1:5173";
	const harness = await setup({ PAYO_WEB_ORIGINS: origin });
	const unauthorized = await api(harness, "/api/v1/runs", {
		token: null,
		headers: { Origin: origin },
	});
	expect(unauthorized.status).toBe(401);
	expect(unauthorized.headers.get("access-control-allow-origin")).toBe(origin);

	const invalid = await api(harness, "/api/v1/runs", {
		method: "POST",
		body: {},
		headers: { Origin: origin },
	});
	expect(invalid.status).toBe(400);
	expect(invalid.headers.get("access-control-allow-origin")).toBe(origin);

	const runId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	const conflict = await api(harness, `/api/v1/runs/${runId}/resume`, {
		method: "POST",
		headers: { Origin: origin },
	});
	expect(conflict.status).toBe(409);
	expect(conflict.headers.get("access-control-allow-origin")).toBe(origin);

	const hostileOrigin = await api(harness, "/api/v1/runs", {
		headers: { Origin: "http://evil.example" },
	});
	expect(hostileOrigin.status).toBe(403);
	expect(hostileOrigin.headers.get("access-control-allow-origin")).toBeNull();

	const hostileHost = await raw(harness, {
		method: "GET",
		path: "/api/v1/runs",
		headers: {
			Host: "evil.example",
			Origin: origin,
			Authorization: `Bearer ${harness.token}`,
		},
	});
	expect(hostileHost.status).toBe(403);
	expect(hostileHost.headers.toLowerCase()).not.toContain(
		"access-control-allow-origin",
	);
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
	expect(preflight.headers.get("access-control-allow-methods")).toContain(
		"PUT",
	);

	const settingsPreflight = await api(harness, "/api/v1/settings/config", {
		method: "OPTIONS",
		token: null,
		headers: { Origin: "http://localhost:5173" },
	});
	expect(settingsPreflight.status).toBe(204);
	expect(
		settingsPreflight.headers.get("access-control-allow-methods"),
	).toContain("PUT");

	const hostilePreflight = await api(harness, "/api/v1/settings/config", {
		method: "OPTIONS",
		token: null,
		headers: { Origin: "http://evil.example" },
	});
	expect(hostilePreflight.status).toBe(403);

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

it("serves and saves the selected config document behind the token", async () => {
	const harness = await setup({ PAYO_BASE_BRANCH: "release" });
	const initial = await api(harness, "/api/v1/settings/config");
	expect(initial.status).toBe(200);
	expect(initial.body).toMatchObject({
		configFile: harness.configFile,
		document: {},
		environmentOverrides: ["PAYO_DATA_DIR", "PAYO_REPO", "PAYO_BASE_BRANCH"],
	});
	expect(initial.body.revision).toMatch(/^[0-9a-f]{64}$/);

	const saved = await api(harness, "/api/v1/settings/config", {
		method: "PUT",
		body: {
			revision: initial.body.revision,
			document: { server: { port: 7444 } },
		},
	});
	expect(saved.status).toBe(200);
	expect(saved.body).toMatchObject({
		configFile: harness.configFile,
		document: { server: { port: 7444 } },
	});
	expect(saved.body.revision).not.toBe(initial.body.revision);
	expect(readPayoConfigDocument(harness.configFile).document).toEqual({
		server: { port: 7444 },
	});

	const reloaded = await api(harness, "/api/v1/settings/config");
	expect(reloaded.body).toEqual(saved.body);

	const stale = await api(harness, "/api/v1/settings/config", {
		method: "PUT",
		body: {
			revision: initial.body.revision,
			document: { server: { port: 7555 } },
		},
	});
	expect(stale.status).toBe(409);
	expect(stale.body.code).toBe("conflict");
	expect(readPayoConfigDocument(harness.configFile).document).toEqual({
		server: { port: 7444 },
	});
});

it("validates settings requests and rejects unsupported methods", async () => {
	const harness = await setup();
	const snapshot = await api(harness, "/api/v1/settings/config");
	const revision = snapshot.body.revision;

	expect(
		(
			await api(harness, "/api/v1/settings/config", {
				method: "PUT",
				body: { revision, document: { extra: true } },
			})
		).status,
	).toBe(400);
	expect(
		(
			await api(harness, "/api/v1/settings/config", {
				method: "PUT",
				body: { revision, document: {}, extra: true },
			})
		).status,
	).toBe(400);
	expect(
		(
			await api(harness, "/api/v1/settings/config", {
				method: "POST",
				body: {},
			})
		).status,
	).toBe(405);
	expect(
		(await api(harness, "/api/v1/settings/config", { token: null })).status,
	).toBe(401);
	expect(
		(await api(harness, "/api/v1/settings/config", { token: "wrong" })).status,
	).toBe(401);
	expect((await api(harness, "/api/v1/settings/other")).status).toBe(404);

	const hostile = await api(harness, "/api/v1/settings/config", {
		headers: { Origin: "http://evil.example" },
	});
	expect(hostile.status).toBe(403);
	const hostileHost = await raw(harness, {
		method: "GET",
		path: "/api/v1/settings/config",
		headers: {
			Host: "evil.example",
			Authorization: `Bearer ${harness.token}`,
		},
	});
	expect(hostileHost.status).toBe(403);
});

it("saves a file that reloads while the running composition is unchanged", async () => {
	const harness = await setup();
	const snapshot = await api(harness, "/api/v1/settings/config");
	const saved = await api(harness, "/api/v1/settings/config", {
		method: "PUT",
		body: {
			revision: snapshot.body.revision,
			document: {
				server: { port: 7444 },
				execution: { max_concurrent_agents: 2 },
			},
		},
	});
	expect(saved.status).toBe(200);

	const reloaded = loadPayoConfig(
		{
			PAYO_CONFIG_FILE: harness.configFile,
			PAYO_DATA_DIR: harness.dataDir,
			PAYO_REPO: harness.dataDir,
		},
		harness.dataDir,
	);
	expect(reloaded.port).toBe(7444);
	expect(reloaded.maxConcurrentAgents).toBe(2);
	expect(harness.composition.config.port).not.toBe(7444);
	expect(harness.composition.config.maxConcurrentAgents).not.toBe(2);
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

it("reports a null work item until the factory resolves it", async () => {
	let resolveWorkItem!: (item: WorkItem) => void;
	const pendingWorkItem = new Promise<WorkItem>((resolve) => {
		resolveWorkItem = resolve;
	});
	const roleSource = {
		path: "synthetic/role.md",
		sha: "synthetic-sha",
		content: "synthetic role",
		resources: {},
	};
	const adapters: AdapterSet = {
		runner: () => createFakeRunner([]),
		workItems: { resolve: () => pendingWorkItem },
		workspace: fakeWorkspace("/workspace"),
		roleSources: {
			planner: roleSource,
			reviewer: roleSource,
			verifier: roleSource,
			reviser: roleSource,
		},
	};
	const harness = await setup({}, adapters);
	const runId = await startRun(harness);
	expect((await summary(harness, runId)).workItem).toBeNull();

	resolveWorkItem({
		origin: { source: "jira", key: "ABC-123", url: null },
		title: "Resolved work item",
		description: "Private work-item details.",
	});
	await waitFor(
		async () =>
			(await summary(harness, runId)).workItem?.title === "Resolved work item",
	);
	expect(JSON.stringify(await summary(harness, runId))).not.toContain(
		"Private work-item details.",
	);
});

it("serves authenticated run review data and current answers", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);

	const unauthorized = await api(harness, `/api/v1/runs/${runId}/review`, {
		token: null,
	});
	expect(unauthorized.status).toBe(401);
	const before = await api(harness, `/api/v1/runs/${runId}/review`);
	expect(before.status).toBe(200);
	expect(before.body).toMatchObject({
		plan: {
			available: true,
			markdown:
				"# Plan\n\n## Phase 1\nImplement the synthetic foundation.\n\nAcceptance: synthetic foundation works.\n\n## Phase 2\nImplement the synthetic integration.\n\nAcceptance: synthetic integration works.\n",
			questions: [{ id: "q1", question: "Why this approach?" }],
		},
		answers: {},
		review: {
			available: true,
			findings: [],
			uncheckedLenses: [],
			verdicts: [],
			provenance: "unknown",
		},
	});
	expect(before.body.plan.editorPath).toBe(
		join(harness.dataDir, "runs", runId, "plan.md"),
	);

	const answer = await api(harness, `/api/v1/runs/${runId}/answer`, {
		method: "POST",
		body: { questionId: "q1", text: "Because." },
	});
	expect(answer.status).toBe(200);
	const after = await api(harness, `/api/v1/runs/${runId}/review`);
	expect(after.body.answers).toEqual({ q1: "Because." });

	const isolated = await api(
		harness,
		"/api/v1/runs/7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e/review",
	);
	expect(isolated.status).toBe(404);
	expect(
		(
			await api(harness, `/api/v1/runs/${runId}/review`, {
				method: "POST",
			})
		).status,
	).toBe(405);

	await approveRun(harness, runId);
	const conflict = await api(harness, `/api/v1/runs/${runId}/request-changes`, {
		method: "POST",
	});
	expect(conflict.status).toBe(409);
});

it("accepts an implementation durably, exposes execution summaries, and deduplicates retries", async () => {
	const harness = await setup(
		{},
		undefined,
		`[execution]
checks = [{ name = "unit", command = "true", args = [], timeout_ms = 1000 }]
`,
	);
	const sourceRunId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, sourceRunId)).stage === "Approval",
	);
	await approveRun(harness, sourceRunId);

	const request = () =>
		api(harness, `/api/v1/runs/${sourceRunId}/implement`, {
			method: "POST",
			body: { prId: "pr-1" },
		});
	const accepted = await request();
	expect(accepted.status).toBe(202);
	expect(accepted.body.runId).toMatch(/^[0-9a-f-]{36}$/);
	const executionRunId = accepted.body.runId as string;
	const events = await harness.composition.readEvents(executionRunId);
	expect(events[0]).toMatchObject({
		type: "run.created",
		config: {
			factory: { kind: "factory-execution", sourceRunId, prId: "pr-1" },
		},
	});
	const created = events[0];
	if (created?.type !== "run.created")
		throw new Error("run-created event expected");
	const executionConfig = ExecutionRunConfigSchema.parse(
		created.config.factory,
	);
	const implementerRef = executionConfig.roleArtifacts.implementer;
	if (!implementerRef) throw new Error("implementer role artifact expected");
	const implementerSource = JSON.parse(
		new TextDecoder().decode(
			await harness.composition.store.readArtifact(implementerRef.sha256),
		),
	) as { addendum?: string; composedSha?: string };
	expect(implementerSource.addendum).toBe(QUALITY_EXPECTATIONS);
	expect(implementerSource.composedSha).toEqual(expect.any(String));
	await waitFor(
		async () =>
			(await summary(harness, executionRunId)).execution?.status === "ended",
	);
	const result = await summary(harness, executionRunId);
	expect(result.execution).toMatchObject({
		runId: executionRunId,
		sourceRunId,
		prId: "pr-1",
		status: "ended",
		outcome: "reviewed",
		stage: "Completed",
		checks: [{ name: "unit", status: "passed" }],
		review: {
			lenses: expect.arrayContaining([
				"plan-conformance",
				"correctness",
				"architecture",
				"code-quality",
				"tests",
				"security",
				"simplicity",
				"compatibility",
			]),
			uncheckedLenses: [],
			findings: 0,
			unresolved: 0,
		},
	});

	const duplicate = await request();
	expect(duplicate.status).toBe(202);
	expect(duplicate.body.runId).toBe(executionRunId);
	expect(
		(await harness.composition.store.listRunIds()).filter(
			(id) => id !== sourceRunId,
		),
	).toEqual([executionRunId]);
	const listed = await api(harness, "/api/v1/runs");
	expect(listed.body.runs.map((run: RunSummary) => run.runId)).toContain(
		executionRunId,
	);
});

it("rejects implementation when no engine-owned check suite is configured", async () => {
	const harness = await setup();
	const sourceRunId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, sourceRunId)).stage === "Approval",
	);
	await approveRun(harness, sourceRunId);
	const response = await api(harness, `/api/v1/runs/${sourceRunId}/implement`, {
		method: "POST",
		body: { prId: "pr-1" },
	});
	expect(response.status).toBe(400);
	expect(response.body.message).toContain("nonempty [execution].checks");
});

it("serves plan history and rejects stale restore requests", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	expect(
		(await api(harness, `/api/v1/runs/${runId}/plan-versions`, { token: null }))
			.status,
	).toBe(401);
	const history = await api(harness, `/api/v1/runs/${runId}/plan-versions`);
	expect(history.status).toBe(200);
	expect(history.body.versions[0].number).toBe(1);
	expect(
		(await api(harness, `/api/v1/runs/${runId}/plan-versions/99`)).status,
	).toBe(404);
	const stale = await api(harness, `/api/v1/runs/${runId}/plan-restore`, {
		method: "POST",
		body: {
			version: 1,
			expectedVersion: 1,
			expectedWorkingCopyHash: "0".repeat(64),
		},
	});
	expect(stale.status).toBe(409);
	expect((await summary(harness, runId)).stage).toBe("Approval");
});

it("reports plan data unavailable before a plan artifact exists", async () => {
	const roleSource = {
		path: "synthetic/role.md",
		sha: "synthetic-sha",
		content: "synthetic role",
		resources: {},
	};
	const adapters: AdapterSet = {
		runner: () => createFakeRunner([[{ kind: "hang" }]]),
		workItems: {
			async resolve() {
				return {
					origin: { source: "jira", key: "ABC-123", url: null },
					title: "Ticket",
					description: "",
				};
			},
		},
		workspace: fakeWorkspace("/workspace"),
		roleSources: {
			planner: roleSource,
			reviewer: roleSource,
			verifier: roleSource,
			reviser: roleSource,
		},
	};
	const harness = await setup({}, adapters);
	const runId = await startRun(harness);
	await waitFor(async () => (await summary(harness, runId)).stage === "Plan");
	const response = await api(harness, `/api/v1/runs/${runId}/review`);
	expect(response.status).toBe(200);
	expect(response.body.plan).toEqual({
		available: false,
		reason: "not_available",
	});
	expect(response.body.review).toEqual({
		available: false,
		reason: "not_available",
	});
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
		workItem: {
			source: "jira",
			title: "Synthetic dev ticket",
			key: "ABC-123",
		},
	});

	const initial = await summary(harness, runId);
	expect(initial.stage).toBeDefined();
	expect(initial.openGates).toEqual([]);
	const created = (await harness.composition.store.read(runId)).find(
		(event) => event.type === "run.created",
	);
	expect(created).toMatchObject({
		type: "run.created",
		config: {
			factory: { workItemRequest: { source: "jira", key: "ABC-123" } },
		},
	});

	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	const approval = await summary(harness, runId);
	expect(approval.stage).toBe("Approval");
	expect(approval.openGates).toHaveLength(1);
	expect(approval.openGates[0]).toMatchObject({ kind: "approval" });
	expect(JSON.parse(JSON.stringify(approval))).toEqual(approval);
});

it("starts a prompt run, keeps raw text out of config, and exposes possible agent echoes", async () => {
	const text = "Build exactly this prompt. Keep it verbatim.";
	const scripts: FakeStep[][] = [
		[
			{ kind: "emit", event: { type: "message", text } },
			...envelope({
				markdown: "# Prompt plan\\n",
				prStrategy: [{ id: "pr", title: "One", phases: [] }],
				openQuestions: [],
			}),
		],
		...Array.from({ length: 7 }, () => envelope({ findings: [] })),
		envelope({ verdicts: [] }),
	];
	const roleSource = {
		path: "synthetic/role.md",
		sha: "synthetic-sha",
		content: "synthetic role",
		resources: {},
	};
	const adapters: AdapterSet = {
		runner: () => createFakeRunner(scripts),
		workItems: {
			async resolve(request: WorkItemRequest) {
				if (request.source !== "prompt") throw new Error("expected prompt");
				return {
					origin: { source: "prompt" },
					title: "Direct prompt",
					description: request.text,
				};
			},
		},
		workspace: fakeWorkspace("/workspace"),
		roleSources: {
			planner: roleSource,
			reviewer: roleSource,
			verifier: roleSource,
			reviser: roleSource,
		},
	};
	const harness = await setup({}, adapters);
	const response = await api(harness, "/api/v1/runs", {
		method: "POST",
		body: { workItemRequest: { source: "prompt", text } },
	});
	expect(response.status).toBe(202);
	const runId = response.body.runId as string;
	await waitFor(
		async () => (await summary(harness, runId)).stage === "Approval",
	);
	expect(await summary(harness, runId)).toMatchObject({
		stage: "Approval",
		openGates: [{ kind: "approval" }],
		workItem: { source: "prompt", title: "Direct prompt", key: null },
	});
	expect(JSON.stringify(await summary(harness, runId))).not.toContain(text);
	const events = await api(harness, `/api/v1/runs/${runId}/events`);
	const created = events.body.events.find(
		(event: { type: string }) => event.type === "run.created",
	);
	expect(JSON.stringify(created.config)).not.toContain(text);
	expect(created.config.factory.workItemRequest).toMatchObject({
		source: "prompt",
		artifact: { kind: "factory-work-item-request-v1", mediaType: "text/plain" },
	});
	const echoed = events.body.events.find(
		(event: { type: string; event?: { type: string; text?: string } }) =>
			event.type === "attempt.event" &&
			event.event?.type === "message" &&
			event.event.text === text,
	);
	expect(echoed?.event).toMatchObject({ type: "message", text });
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

it("fails an event stream when polling fails instead of ending normally", async () => {
	const harness = await setup();
	const runId = await startRun(harness);
	harness.composition.readEvents = async () => {
		throw new Error("synthetic event read failure");
	};

	const response = await fetch(
		`http://127.0.0.1:${harness.port}/api/v1/runs/${runId}/events/stream`,
		{
			headers: {
				Authorization: `Bearer ${harness.token}`,
				Accept: "text/event-stream",
			},
		},
	);
	expect(response.status).toBe(200);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing body");
	await expect(reader.read()).rejects.toThrow();
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
	const configFile = join(dataDir, "config.toml");
	writeFileSync(configFile, "");
	const token = await ensureServerToken(dataDir);
	const configSettings = createConfigSettingsService({
		configFile,
		env: {},
		cwd: dataDir,
		devFakes: true,
	});
	let port = 0;
	const server = createServer(
		createHandler({
			token,
			webOrigins: [],
			getPort: () => port,
			getServices: () => null,
			configSettings,
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

		const settings = await fetch(
			`http://127.0.0.1:${port}/api/v1/settings/config`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		expect(settings.status).toBe(503);
		expect((await settings.json()).code).toBe("starting");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

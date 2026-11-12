import type { SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentEvent, AgentSpec } from "@payo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkPi,
	createPiRunner as createPiRunnerWithArtifacts,
	mapPiRecord,
	type PiMapState,
} from "./index.ts";

const dirs: string[] = [];
type PiRunnerTestOptions = Omit<
	Parameters<typeof createPiRunnerWithArtifacts>[0],
	"readArtifact"
> & {
	readArtifact?: Parameters<
		typeof createPiRunnerWithArtifacts
	>[0]["readArtifact"];
};
function createPiRunner(options: PiRunnerTestOptions) {
	return createPiRunnerWithArtifacts({
		...options,
		readArtifact:
			options.readArtifact ??
			(async () => {
				throw new Error("unexpected artifact read");
			}),
	});
}

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "payo-pi-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function fixture(name: string): string {
	return readFileSync(
		new URL(`./fixtures/${name}.jsonl`, import.meta.url),
		"utf8",
	);
}

function baseState(overrides: Partial<PiMapState> = {}): PiMapState {
	return {
		signal: new AbortController().signal,
		model: null,
		started: false,
		finalText: null,
		lastStopReason: null,
		lastError: null,
		usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
		costDetails: { amounts: [], complete: false },
		missingNativeCost: false,
		seenUsageEntryIds: new Set(),
		done: false,
		...overrides,
	};
}

function mapAll(text: string, state: PiMapState): AgentEvent[] {
	const events: AgentEvent[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		events.push(...mapPiRecord(JSON.parse(line), state));
		if (state.done) break;
	}
	return events;
}

function specFor(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		role: "reviewer",
		instructions: "Review the plan.",
		roleSpecSha: null,
		cwd: process.cwd(),
		tools: "read-only",
		model: "claude-sonnet-4",
		timeoutMs: 1000,
		outputContract: "verdict",
		inputs: [],
		correlation: { runId: "r1", stepId: "s1", attemptId: "a1" },
		...overrides,
	};
}

interface StubChild extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	kill(signal?: string): boolean;
}

interface SpawnCall {
	bin: string;
	args: string[];
	options: SpawnOptions;
	kills: string[];
}

interface StubOptions {
	stdout?: string;
	chunks?: string[];
	stderr?: string;
	exitCode?: number;
	error?: Error;
	holdOpen?: boolean;
	onSpawn?: () => void;
}

function spawnStub(options: StubOptions = {}) {
	const calls: SpawnCall[] = [];
	const stub = (bin: string, args: string[], spawnOptions: SpawnOptions) => {
		const child = new EventEmitter() as StubChild;
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const kills: string[] = [];
		child.stdout = stdout;
		child.stderr = stderr;
		child.kill = (signal?: string) => {
			kills.push(signal ?? "SIGTERM");
			return true;
		};
		calls.push({ bin, args, options: spawnOptions, kills });
		options.onSpawn?.();
		queueMicrotask(() => {
			if (options.error !== undefined) {
				child.emit("error", options.error);
				return;
			}
			for (const chunk of options.chunks ?? [options.stdout ?? ""]) {
				stdout.write(chunk);
			}
			if (options.stderr !== undefined) stderr.write(options.stderr);
			if (options.holdOpen === true) return;
			stdout.end();
			stderr.end();
			child.emit("close", options.exitCode ?? 0, null);
		});
		return child;
	};
	return { calls, spawn: stub as unknown as typeof spawn };
}

async function collect(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("mapPiRecord", () => {
	it("maps a valid stream to started, message, a final usage snapshot and result", () => {
		const state = baseState();

		const events = mapAll(fixture("valid"), state);

		expect(events.map((event) => event.type)).toEqual([
			"started",
			"message",
			"usage",
			"usage",
			"result",
		]);
		expect(events[0]).toEqual({
			type: "started",
			model: "claude-sonnet-4",
		});
		expect(events[1]).toEqual({ type: "message", text: '{"ok":true}' });
		expect(events[2]).toEqual({
			type: "usage",
			usage: {
				tokensIn: 13,
				tokensOut: 5,
				cost: 0.003,
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0.003" }],
					complete: false,
				},
			},
		});
		expect(events[3]).toEqual({
			type: "usage",
			usage: {
				tokensIn: 13,
				tokensOut: 5,
				cost: 0.003,
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0.003" }],
					complete: true,
				},
			},
		});
		expect(events[4]).toEqual({ type: "result", text: '{"ok":true}' });
	});

	it("sums cumulative usage across two assistant messages", () => {
		const state = baseState();

		const events = mapAll(fixture("tool-loop"), state);

		expect(events.filter((event) => event.type === "usage").at(-1)).toEqual({
			type: "usage",
			usage: {
				tokensIn: 11,
				tokensOut: 5,
				cost: 0.003,
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0.003" }],
					complete: true,
				},
			},
		});
	});

	it("maps tool execution start and end", () => {
		const state = baseState();

		const events = mapAll(fixture("tool-loop"), state);

		expect(events.filter((event) => event.type === "tool_call")).toEqual([
			{ type: "tool_call", callId: "call_1", name: "read" },
		]);
		expect(events.filter((event) => event.type === "tool_result")).toEqual([
			{ type: "tool_result", callId: "call_1", name: "read", ok: true },
		]);
	});

	it("keeps a per-message error informational until a later settlement", () => {
		const state = baseState();
		const events: AgentEvent[] = [];
		events.push(
			...mapPiRecord(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "retry me" }],
						stopReason: "error",
						errorMessage: "overloaded",
					},
				},
				state,
			),
		);
		expect(events.some((event) => event.type === "error")).toBe(false);

		events.push(
			...mapPiRecord(
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "recovered" }],
						stopReason: "stop",
					},
				},
				state,
			),
		);
		events.push(
			...mapPiRecord({ type: "agent_settled", aborted: false }, state),
		);

		expect(events.at(-1)).toEqual({ type: "result", text: "recovered" });
	});

	it("errors when the stream has no assistant text", () => {
		const state = baseState();

		expect(
			mapPiRecord({ type: "agent_settled", aborted: false }, state),
		).toEqual([{ type: "error", message: "pi ended without assistant text" }]);
	});

	it("clamps model ids, call ids, tool names and text to the contract caps", () => {
		const state = baseState();
		const started = mapPiRecord(
			{
				type: "message_end",
				message: {
					role: "assistant",
					model: "m".repeat(257),
					content: [{ type: "text", text: "x".repeat(262145) }],
					stopReason: "stop",
				},
			},
			state,
		);
		expect(started[0]).toMatchObject({
			type: "started",
			model: "m".repeat(256),
		});
		const call = mapPiRecord(
			{
				type: "tool_execution_start",
				toolCallId: "c".repeat(257),
				toolName: "n".repeat(129),
			},
			baseState(),
		);
		expect(call[0]).toMatchObject({
			type: "tool_call",
			callId: "c".repeat(256),
			name: "n".repeat(128),
		});
		const result = mapPiRecord(
			{ type: "agent_settled", aborted: false },
			state,
		);
		expect(result.at(-1)).toMatchObject({
			type: "result",
			text: "x".repeat(262144),
		});

		const errorState = baseState();
		mapPiRecord(
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "x" }],
					stopReason: "error",
					errorMessage: "e".repeat(262145),
				},
			},
			errorState,
		);
		const error = mapPiRecord(
			{ type: "agent_settled", aborted: false },
			errorState,
		);
		expect(error.at(-1)).toMatchObject({
			type: "error",
			message: "e".repeat(262144),
		});
	});

	it("turns an unexpected abort into an error", () => {
		const state = baseState();

		expect(
			mapPiRecord({ type: "agent_settled", aborted: true }, state),
		).toEqual([{ type: "error", message: "pi aborted" }]);
	});
});

function nativeUsage(
	input: number,
	output: number,
	total: number,
	extra: Record<string, unknown> = {},
) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
			...extra,
		},
	};
}

function assistant(text: string, usage?: unknown) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			model: "claude-sonnet-4",
			content: [{ type: "text", text }],
			stopReason: "stop",
			...(usage === undefined ? {} : { usage }),
		},
	};
}

function usageEvents(events: AgentEvent[]) {
	return events.flatMap((event) =>
		event.type === "usage" ? [event.usage] : [],
	);
}

describe("mapPiRecord cost accounting", () => {
	it("treats two assistant calls as cumulative replacement snapshots", () => {
		const state = baseState();
		mapPiRecord(assistant("first", nativeUsage(1, 1, 0.002)), state);
		const snapshots = usageEvents(
			mapPiRecord(assistant("second", nativeUsage(2, 2, 0.003)), state),
		);

		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.costDetails?.amounts).toEqual([
			{ currency: "USD", basis: "estimated", amount: "0.005" },
		]);
		expect(snapshots[0]?.costDetails?.complete).toBe(false);
	});

	it("keeps an earlier known amount when a later report has no cost", () => {
		const state = baseState();
		mapPiRecord(assistant("known", nativeUsage(1, 1, 0.002)), state);
		const [snapshot] = usageEvents(mapPiRecord(assistant("gap"), state));

		expect(snapshot?.costDetails).toEqual({
			amounts: [{ currency: "USD", basis: "estimated", amount: "0.002" }],
			complete: false,
		});
		expect(snapshot?.cost).toBe("unknown");
	});

	it("uses a later known cost after a gap while staying incomplete", () => {
		const state = baseState();
		mapPiRecord(assistant("gap"), state);
		const [snapshot] = usageEvents(
			mapPiRecord(assistant("known", nativeUsage(1, 1, 0.004)), state),
		);

		expect(snapshot?.costDetails?.amounts).toEqual([
			{ currency: "USD", basis: "estimated", amount: "0.004" },
		]);
		expect(snapshot?.costDetails?.complete).toBe(false);
	});

	it("separates provider-reported from estimated cost", () => {
		const state = baseState();
		mapPiRecord(
			assistant(
				"estimated",
				nativeUsage(1, 1, 0.002, { totalFromProvider: false }),
			),
			state,
		);
		const events = mapPiRecord(
			assistant(
				"reported",
				nativeUsage(1, 1, 0.003, { totalFromProvider: true }),
			),
			state,
		);

		expect(usageEvents(events)[0]).toMatchObject({
			costDetails: {
				amounts: [
					{ currency: "USD", basis: "estimated", amount: "0.002" },
					{ currency: "USD", basis: "provider-reported", amount: "0.003" },
				],
				complete: false,
			},
		});
	});

	it("keeps a native zero as an explicit USD amount", () => {
		const state = baseState();
		const [owned] = usageEvents(
			mapPiRecord(assistant("free", nativeUsage(1, 1, 0)), state),
		);
		const events = mapPiRecord(
			{ type: "agent_settled", aborted: false },
			state,
		);

		expect(owned?.costDetails).toEqual({
			amounts: [{ currency: "USD", basis: "estimated", amount: "0" }],
			complete: false,
		});
		expect(events[0]).toEqual({
			type: "usage",
			usage: expect.objectContaining({
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0" }],
					complete: true,
				},
			}),
		});
	});

	it("adds no amount for a message with no native usage, unlike a native zero", () => {
		const state = baseState();
		const [snapshot] = usageEvents(mapPiRecord(assistant("missing"), state));

		expect(snapshot?.costDetails).toEqual({ amounts: [], complete: false });
		expect(state.missingNativeCost).toBe(true);
	});

	it("never turns the seeded initial zero into an amount", () => {
		const state = baseState();
		const events = mapPiRecord(
			{ type: "agent_settled", aborted: false },
			state,
		);

		expect(state.usage.cost).toBe(0);
		expect(state.costDetails.amounts).toEqual([]);
		expect(events.map((event) => event.type)).toEqual(["error"]);
	});

	it("counts assistant, compaction and cache-warming reports once", () => {
		const state = baseState();
		const events: AgentEvent[] = [];
		events.push(
			...mapPiRecord(assistant("work", nativeUsage(10, 5, 0.002)), state),
		);
		events.push(
			...mapPiRecord(
				{
					type: "entry_appended",
					entry: {
						type: "usage",
						id: "usage-cache-warm-1",
						kind: "cache_warm",
						provider: "anthropic",
						model: "claude-sonnet-4",
						usage: nativeUsage(0, 0, 0.001),
					},
				},
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{
					type: "entry_appended",
					entry: {
						type: "usage",
						id: "usage-cache-warm-1",
						kind: "cache_warm",
						provider: "anthropic",
						model: "claude-sonnet-4",
						usage: nativeUsage(0, 0, 0.001),
					},
				},
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{
					type: "entry_appended",
					entry: {
						type: "compaction",
						id: "compaction-entry-1",
						usage: nativeUsage(0, 0, 0.05),
					},
				},
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{
					type: "compaction_end",
					reason: "threshold",
					result: { usage: nativeUsage(5, 3, 0.0005) },
					aborted: false,
					willRetry: false,
				},
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{ type: "message_update", usage: nativeUsage(100, 100, 1) },
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{
					type: "turn_end",
					message: { usage: nativeUsage(100, 100, 1) },
				},
				state,
			),
		);
		events.push(
			...mapPiRecord(
				{ type: "agent_end", messages: [], willRetry: false },
				state,
			),
		);
		events.push(
			...mapPiRecord({ type: "agent_settled", aborted: false }, state),
		);

		const final = usageEvents(events).at(-1);
		expect(final?.costDetails?.amounts[0]?.amount).toBe(String(0.0035));
		expect(final?.costDetails?.amounts).toEqual([
			expect.objectContaining({ currency: "USD", basis: "estimated" }),
		]);
		expect(final?.costDetails?.complete).toBe(true);
	});

	it("marks compaction without summary usage incomplete", () => {
		const state = baseState();
		mapPiRecord(assistant("work", nativeUsage(1, 1, 0.002)), state);
		const events = mapPiRecord(
			{
				type: "compaction_end",
				reason: "manual",
				aborted: true,
				willRetry: false,
			},
			state,
		);

		expect(state.missingNativeCost).toBe(true);
		expect(events).toEqual([
			{
				type: "usage",
				usage: expect.objectContaining({
					costDetails: {
						amounts: [{ currency: "USD", basis: "estimated", amount: "0.002" }],
						complete: false,
					},
				}),
			},
		]);
	});

	it("emits an incomplete final snapshot before an aborted terminal error", () => {
		const state = baseState();
		mapPiRecord(assistant("work", nativeUsage(1, 1, 0.002)), state);
		const events = mapPiRecord({ type: "agent_settled", aborted: true }, state);

		expect(events.map((event) => event.type)).toEqual(["usage", "error"]);
		expect(events[0]).toEqual({
			type: "usage",
			usage: expect.objectContaining({
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0.002" }],
					complete: false,
				},
			}),
		});
		expect(events[1]).toEqual({ type: "error", message: "pi aborted" });
	});

	it("keeps emitted snapshots immutable as later reports arrive", () => {
		const state = baseState();
		const [first] = usageEvents(
			mapPiRecord(assistant("first", nativeUsage(1, 1, 0.002)), state),
		);
		mapPiRecord(assistant("second", nativeUsage(1, 1, 0.003)), state);

		expect(first?.costDetails?.amounts).toEqual([
			{ currency: "USD", basis: "estimated", amount: "0.002" },
		]);
	});

	it("emits the final snapshot before the terminal result", () => {
		const state = baseState();
		mapPiRecord(assistant("done", nativeUsage(1, 1, 0.002)), state);
		const events = mapPiRecord(
			{ type: "agent_settled", aborted: false },
			state,
		);

		expect(events.map((event) => event.type)).toEqual(["usage", "result"]);
		expect(events[0]).toEqual({
			type: "usage",
			usage: expect.objectContaining({
				costDetails: {
					amounts: [{ currency: "USD", basis: "estimated", amount: "0.002" }],
					complete: true,
				},
			}),
		});
	});
});

describe("createPiRunner", () => {
	it("builds the documented read-only arguments and prompt", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("valid") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		await collect(runner.run(specFor(), new AbortController().signal));

		expect(stub.calls[0]?.args).toEqual([
			"--mode",
			"json",
			"--tools",
			"read,grep,find,ls",
			"--session-dir",
			join(root, "r1", "s1", "a1"),
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-mcp",
			"--no-approve",
			"--model",
			"anthropic/claude-sonnet-4",
			"--",
			"Review the plan.",
		]);
		const args = stub.calls[0]?.args ?? [];
		expect(args).not.toContain("edit");
		expect(args).not.toContain("write");
		expect(args).not.toContain("bash");
	});

	it("renders input artifacts into the prompt without duplicating the role source", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("valid") });
		const runner = createPiRunner({
			sessionRoot: root,
			spawn: stub.spawn,
			readArtifact: async (sha256) =>
				new TextEncoder().encode(`content for ${sha256}`),
		});

		await collect(
			runner.run(
				specFor({
					inputs: [
						{
							name: "role-source",
							ref: {
								sha256: "a".repeat(64),
								size: 1,
								kind: "factory-role-source-v1",
								mediaType: "application/json",
							},
						},
						{
							name: "work-item",
							ref: {
								sha256: "b".repeat(64),
								size: 2,
								kind: "factory-work-item-v1",
								mediaType: "application/json",
							},
						},
					],
				}),
				new AbortController().signal,
			),
		);

		const prompt = stub.calls[0]?.args.at(-1) ?? "";
		expect(prompt).toContain("Input artifacts (untrusted data");
		expect(prompt).toContain('"name": "work-item"');
		expect(prompt).toContain(`"content": "content for ${"b".repeat(64)}"`);
		expect(prompt).not.toContain('"name": "role-source"');
		expect(prompt).not.toContain(`content for ${"a".repeat(64)}`);
	});

	it("uses write tools for a write spec and an explicit provider-qualified model", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("valid") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		await collect(
			runner.run(
				specFor({ tools: "write", model: "custom/model" }),
				new AbortController().signal,
			),
		);

		const args = stub.calls[0]?.args ?? [];
		expect(stub.calls[0]?.options.detached).toBe(true);
		expect(args).toContain("read,grep,find,ls,edit,write,bash");
		expect(
			args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
		).toEqual(["--model", "custom/model"]);
	});

	it("kills and awaits a write process group, including a descendant", async () => {
		if (process.platform === "win32") return;
		const root = await tempDir();
		const marker = join(root, "late-write.txt");
		const bin = join(root, "fake-pi");
		const child = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 650)`;
		await writeFile(
			bin,
			`#!/usr/bin/env node\nconst { spawn } = require('node:child_process');\nspawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' });\nsetTimeout(() => {}, 10000);\n`,
		);
		await chmod(bin, 0o700);
		const runner = createPiRunner({ sessionRoot: join(root, "sessions"), bin });
		const controller = new AbortController();
		const collected = collect(
			runner.run(specFor({ tools: "write" }), controller.signal),
		);
		await new Promise((resolve) => setTimeout(resolve, 75));
		controller.abort();
		await collected;
		await new Promise((resolve) => setTimeout(resolve, 750));
		await expect(readFile(marker, "utf8")).rejects.toThrow();
	});

	it("spawns in the worktree with ignored stdin, merged env and no shell", async () => {
		const root = await tempDir();
		const spec = specFor({ cwd: "/tmp/worktree" });
		const stub = spawnStub({ stdout: fixture("valid") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		await collect(runner.run(spec, new AbortController().signal));

		const options = stub.calls[0]?.options;
		expect(options?.cwd).toBe("/tmp/worktree");
		expect(options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
		expect(options?.shell).toBe(false);
		expect(options?.env?.PAYO_RUN_ID).toBe("r1");
		expect(options?.env?.PAYO_STEP_ID).toBe("s1");
		expect(options?.env?.PAYO_ATTEMPT_ID).toBe("a1");
		expect(options?.env?.PATH).toBe(process.env.PATH);
	});

	it("puts the session directory under the session root and creates it private", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("valid") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		await collect(runner.run(specFor(), new AbortController().signal));

		const sessionDir = join(root, "r1", "s1", "a1");
		expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);
	});

	it("tees raw stdout to rawLogPath with mode 0600", async () => {
		const root = await tempDir();
		const raw = fixture("valid");
		const rawLogPath = join(root, "raw", "events.jsonl");
		const stub = spawnStub({ stdout: raw });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		await collect(
			runner.run(specFor({ rawLogPath }), new AbortController().signal),
		);

		expect(await readFile(rawLogPath, "utf8")).toBe(raw);
		expect((await stat(rawLogPath)).mode & 0o777).toBe(0o600);
	});

	it("turns a malformed line into an error naming it and no result", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("malformed") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		const events = await collect(
			runner.run(specFor(), new AbortController().signal),
		);

		expect(events).toEqual([
			{ type: "error", message: "pi emitted malformed JSON on line 2" },
		]);
	});

	it("produces the same events when a line arrives in two chunks", async () => {
		const root = await tempDir();
		const raw = fixture("split-line");
		const cut = raw.indexOf('"session"') + 5;
		const joined = spawnStub({ stdout: raw });
		const split = spawnStub({ chunks: [raw.slice(0, cut), raw.slice(cut)] });

		const wholeEvents = await collect(
			createPiRunner({ sessionRoot: root, spawn: joined.spawn }).run(
				specFor(),
				new AbortController().signal,
			),
		);
		const splitEvents = await collect(
			createPiRunner({ sessionRoot: root, spawn: split.spawn }).run(
				specFor(),
				new AbortController().signal,
			),
		);

		expect(splitEvents).toEqual(wholeEvents);
		expect(splitEvents.at(-1)).toEqual({
			type: "result",
			text: "split fixture",
		});
	});

	it("replays assistant, compaction and usage-entry reports with a final snapshot", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("usage-accounting") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		const events = await collect(
			runner.run(specFor(), new AbortController().signal),
		);

		const usage = events.flatMap((event) =>
			event.type === "usage" ? [event.usage] : [],
		);
		const final = usage.at(-1);
		expect(
			final?.costDetails?.amounts.map((a) => [a.currency, a.basis]),
		).toEqual([
			["USD", "estimated"],
			["USD", "provider-reported"],
		]);
		expect(final?.costDetails?.amounts[0]?.amount).toBe(String(0.0035));
		expect(final?.costDetails?.amounts[1]?.amount).toBe(String(0.004));
		expect(final?.costDetails?.complete).toBe(true);
		expect(final?.tokensIn).toBe(38);
		expect(final?.tokensOut).toBe(16);
		expect(events.at(-2)?.type).toBe("usage");
		expect(events.at(-1)).toEqual({ type: "result", text: "done" });
	});

	it("kills the child when the consumer stops early", async () => {
		const root = await tempDir();
		const stub = spawnStub({
			stdout: fixture("valid").split("\n").slice(0, 9).join("\n"),
			holdOpen: true,
		});
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		const stream = runner.run(specFor(), new AbortController().signal);
		for await (const _event of stream) break;

		expect(stub.calls[0]?.kills).toContain("SIGTERM");
	});

	it("kills the child and ends quietly when aborted", async () => {
		const root = await tempDir();
		let markSpawned = () => {};
		const spawned = new Promise<void>((resolve) => {
			markSpawned = resolve;
		});
		const stub = spawnStub({
			stdout: "",
			holdOpen: true,
			onSpawn: markSpawned,
		});
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });
		const controller = new AbortController();

		const collected = collect(runner.run(specFor(), controller.signal));
		await spawned;
		controller.abort();
		const events = await collected;

		expect(events).toEqual([]);
		expect(stub.calls[0]?.kills).toContain("SIGTERM");
	});

	it("does not spawn pi when aborted while input artifacts are read", async () => {
		const root = await tempDir();
		const stub = spawnStub({ stdout: fixture("valid") });
		const controller = new AbortController();
		const runner = createPiRunner({
			sessionRoot: root,
			spawn: stub.spawn,
			readArtifact: async () => {
				controller.abort();
				return new TextEncoder().encode("{}");
			},
		});

		const events = await collect(
			runner.run(
				specFor({
					inputs: [
						{
							name: "work-item",
							ref: {
								sha256: "b".repeat(64),
								size: 2,
								kind: "factory-work-item-v1",
								mediaType: "application/json",
							},
						},
					],
				}),
				controller.signal,
			),
		);

		expect(events).toEqual([]);
		expect(stub.calls).toEqual([]);
	});

	it("reports a non-zero exit that never settles", async () => {
		const root = await tempDir();
		const stub = spawnStub({
			stdout: fixture("error-exit"),
			stderr: "fatal detail",
			exitCode: 3,
		});
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		const events = await collect(
			runner.run(specFor(), new AbortController().signal),
		);

		expect(events.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("code 3"),
		});
		expect(events.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringContaining("fatal detail"),
		});
	});

	it("turns a spawn error into an error event", async () => {
		const root = await tempDir();
		const stub = spawnStub({ error: new Error("spawn pi ENOENT") });
		const runner = createPiRunner({ sessionRoot: root, spawn: stub.spawn });

		const events = await collect(
			runner.run(specFor(), new AbortController().signal),
		);

		expect(events).toEqual([
			{ type: "error", message: "pi failed: spawn pi ENOENT" },
		]);
	});

	it("requires correlation ids", async () => {
		const root = await tempDir();
		const runner = createPiRunner({ sessionRoot: root });

		await expect(
			collect(
				runner.run(
					specFor({ correlation: undefined }),
					new AbortController().signal,
				),
			),
		).rejects.toThrow("runner-pi requires AgentSpec.correlation");
	});
});

describe("checkPi", () => {
	it("reports ready for exit 0 and a ready status", async () => {
		const check = await checkPi({
			exec: async () => ({
				stdout: '{"status":"ready"}',
				stderr: "",
				exitCode: 0,
			}),
		});

		expect(check).toEqual({ name: "pi", ok: true, detail: "ready" });
	});

	it("reports not ready for a non-zero exit", async () => {
		const check = await checkPi({
			exec: async () => ({
				stdout: '{"status":"not_ready"}',
				stderr: "",
				exitCode: 1,
			}),
		});

		expect(check.ok).toBe(false);
		expect(check.detail).toContain("not_ready");
	});

	it("reports a spawn failure as a failed check", async () => {
		const check = await checkPi({
			exec: async () => {
				throw new Error("spawn pi ENOENT");
			},
		});

		expect(check.ok).toBe(false);
		expect(check.detail).toContain("ENOENT");
	});

	it("caps the detail at 512 characters", async () => {
		const check = await checkPi({
			exec: async () => ({ stdout: "", stderr: "x".repeat(1000), exitCode: 1 }),
		});

		expect(check.detail.length).toBeLessThanOrEqual(512);
	});

	it("uses execFile by default and resolves a non-zero exit", async () => {
		const dir = await tempDir();
		const bin = join(dir, "fake-pi");
		await writeFile(bin, "#!/bin/sh\necho boom >&2\nexit 7\n");
		await chmod(bin, 0o700);

		const check = await checkPi({ bin });

		expect(check.ok).toBe(false);
		expect(check.detail).toMatch(/exit 7/);
	});

	it("reports a missing binary", async () => {
		const check = await checkPi({ bin: "/nonexistent-payo-pi" });

		expect(check.ok).toBe(false);
		expect(check.detail).toMatch(/ENOENT|no such file/i);
	});
});

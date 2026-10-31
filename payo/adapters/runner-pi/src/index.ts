import { execFile, type SpawnOptions, spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	AgentEvent,
	AgentSpec,
	DoctorCheck,
	Usage,
	UsageRecord,
} from "@payo/contracts";
import type { AgentRunner } from "@payo/kernel";

export type PiExec = (
	args: string[],
	options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface PiRunnerOptions {
	bin?: string;
	provider?: string;
	sessionRoot: string;
	spawn?: typeof spawn;
}

export interface PiMapState {
	signal: AbortSignal;
	model: string | null;
	started: boolean;
	finalText: string | null;
	lastStopReason: string | null;
	lastError: string | null;
	usage: UsageRecord;
	done: boolean;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_MODEL = 256;
const MAX_CALL_ID = 256;
const MAX_TOOL_NAME = 128;
const MAX_TEXT = 262144;
const MAX_DETAIL = 512;
const MAX_STDERR = 8192;
const KILL_GRACE_MS = 2000;

const READ_ONLY_TOOLS = "read,grep,find,ls";
const WRITE_TOOLS = "read,grep,find,ls,edit,write,bash";

export function createPiRunner(options: PiRunnerOptions): AgentRunner {
	const bin = options.bin ?? "pi";
	const provider = options.provider ?? "anthropic";
	const spawnFn = options.spawn ?? spawn;

	return {
		id: "pi",
		async *run(spec, signal) {
			const correlation = spec.correlation;
			if (correlation === undefined) {
				throw new Error("runner-pi requires AgentSpec.correlation");
			}
			const sessionDir = join(
				options.sessionRoot,
				safeSegment(correlation.runId),
				safeSegment(correlation.stepId),
				safeSegment(correlation.attemptId),
			);
			await mkdir(sessionDir, { recursive: true, mode: 0o700 });
			if (signal.aborted) return;
			if (spec.rawLogPath !== undefined) {
				await mkdir(dirname(spec.rawLogPath), {
					recursive: true,
					mode: 0o700,
				}).catch(() => {});
			}

			const args = buildArgs(spec, provider, sessionDir);
			const spawnOptions: SpawnOptions = {
				cwd: spec.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PAYO_RUN_ID: correlation.runId,
					PAYO_STEP_ID: correlation.stepId,
					PAYO_ATTEMPT_ID: correlation.attemptId,
				},
				shell: false,
			};
			const child = spawnFn(bin, args, spawnOptions);
			const state: PiMapState = {
				signal,
				model: spec.model,
				started: false,
				finalText: null,
				lastStopReason: null,
				lastError: null,
				usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
				done: false,
			};

			let exited = false;
			let terminated = false;
			let spawnError: Error | null = null;
			let exitCode: number | null = null;
			const spawnFailure = (): Error | null => spawnError;
			const stdout = child.stdout;
			const stderr = child.stderr;
			let stderrTail = "";
			const closed = new Promise<void>((resolve) => {
				child.once("close", (code) => {
					exitCode = code;
					exited = true;
					resolve();
				});
				child.once("error", (error) => {
					spawnError = error;
					exited = true;
					stdout?.destroy();
					stderr?.destroy();
					resolve();
				});
			});
			const terminate = () => {
				if (exited || terminated) return;
				terminated = true;
				child.kill("SIGTERM");
				const timer = setTimeout(() => {
					if (!exited) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
				timer.unref();
			};
			const onAbort = () => {
				terminate();
				stdout?.destroy();
				stderr?.destroy();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			stderr?.on("data", (chunk: Buffer) => {
				stderrTail = (stderrTail + chunk.toString("utf8")).slice(-MAX_STDERR);
			});

			try {
				if (stdout === null) {
					await closed;
					if (signal.aborted) return;
					const failure = spawnFailure();
					yield {
						type: "error",
						message: failure
							? `pi failed: ${failure.message}`
							: "pi produced no output",
					};
					return;
				}

				const decoder = new TextDecoder();
				let carry = "";
				let lineNo = 0;
				const consume = (
					line: string,
				): { events: AgentEvent[]; stop: boolean } => {
					lineNo++;
					const text = line.endsWith("\r") ? line.slice(0, -1) : line;
					if (text.length === 0) return { events: [], stop: false };
					let record: unknown;
					try {
						record = JSON.parse(text);
					} catch {
						return {
							events: [
								{
									type: "error",
									message: `pi emitted malformed JSON on line ${lineNo}`,
								},
							],
							stop: true,
						};
					}
					const events = mapPiRecord(record, state);
					return { events, stop: state.done };
				};
				const processChunk = async function* (
					chunk: Buffer,
				): AsyncGenerator<AgentEvent, boolean> {
					if (spec.rawLogPath !== undefined) {
						await appendFile(spec.rawLogPath, chunk, { mode: 0o600 }).catch(
							() => {},
						);
					}
					carry += decoder.decode(chunk, { stream: true });
					const parts = carry.split("\n");
					carry = parts.pop() ?? "";
					for (const line of parts) {
						const result = consume(line);
						yield* result.events;
						if (result.stop) return true;
					}
					return false;
				};

				for await (const chunk of stdout) {
					const stop = yield* processChunk(
						Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
					);
					if (stop || state.done || signal.aborted) return;
				}
				if (signal.aborted) return;
				carry += decoder.decode();
				if (carry.length > 0) {
					const result = consume(carry);
					yield* result.events;
					if (result.stop) return;
				}
				await closed;
				if (signal.aborted) return;
				const failure = spawnFailure();
				if (failure !== null) {
					yield {
						type: "error",
						message: `pi failed: ${failure.message}`,
					};
					return;
				}
				if (!state.done) {
					const tail = stderrTail.trim();
					yield {
						type: "error",
						message:
							`pi exited with code ${exitCode ?? "unknown"}` +
							(tail.length > 0 ? `: ${tail}` : ""),
					};
				}
			} catch (error) {
				if (signal.aborted) return;
				const failure = spawnFailure();
				if (failure !== null) {
					yield {
						type: "error",
						message: `pi failed: ${failure.message}`,
					};
					return;
				}
				throw error;
			} finally {
				signal.removeEventListener("abort", onAbort);
				terminate();
				stdout?.destroy();
				stderr?.destroy();
			}
		},
	};
}

export function mapPiRecord(record: unknown, state: PiMapState): AgentEvent[] {
	const value = asRecord(record);
	if (value === null || typeof value.type !== "string") return [];

	if (value.type === "message_end") {
		const message = asRecord(value.message);
		if (message === null || message.role !== "assistant") return [];
		const events: AgentEvent[] = [];
		if (!state.started) {
			state.started = true;
			if (typeof message.model === "string") state.model = message.model;
			events.push({
				type: "started",
				model: state.model === null ? null : clamp(state.model, MAX_MODEL),
			});
		}
		if (typeof message.stopReason === "string")
			state.lastStopReason = message.stopReason;
		if (typeof message.errorMessage === "string")
			state.lastError = message.errorMessage;
		const text = messageText(message.content);
		if (text.length > 0) {
			state.finalText = text;
			events.push({ type: "message", text: clamp(text, MAX_TEXT) });
		}
		state.usage = addUsage(state.usage, asRecord(message.usage));
		events.push({ type: "usage", usage: state.usage });
		return events;
	}

	if (value.type === "tool_execution_start") {
		const callId = asString(value.toolCallId);
		const name = asString(value.toolName);
		if (callId === null || name === null) return [];
		return [
			{
				type: "tool_call",
				callId: clamp(callId, MAX_CALL_ID),
				name: clamp(name, MAX_TOOL_NAME),
			},
		];
	}

	if (value.type === "tool_execution_end") {
		const callId = asString(value.toolCallId);
		const name = asString(value.toolName);
		if (callId === null || name === null) return [];
		return [
			{
				type: "tool_result",
				callId: clamp(callId, MAX_CALL_ID),
				name: clamp(name, MAX_TOOL_NAME),
				ok: value.isError !== true,
			},
		];
	}

	if (value.type !== "agent_settled") return [];
	if (state.done) return [];
	state.done = true;
	if (value.aborted === true && !state.signal.aborted) {
		return [
			{
				type: "error",
				message: clamp(state.lastError ?? "pi aborted", MAX_TEXT),
			},
		];
	}
	if (state.lastStopReason === "error") {
		return [
			{
				type: "error",
				message: clamp(state.lastError ?? "pi stopped with an error", MAX_TEXT),
			},
		];
	}
	if (state.finalText !== null) {
		return [{ type: "result", text: clamp(state.finalText, MAX_TEXT) }];
	}
	return [{ type: "error", message: "pi ended without assistant text" }];
}

export async function checkPi(options: {
	bin?: string;
	provider?: string;
	model?: string | null;
	exec?: PiExec;
}): Promise<DoctorCheck> {
	const bin = options.bin ?? "pi";
	const provider = options.provider ?? "anthropic";
	const exec = options.exec ?? createPiExec(bin);
	try {
		const result = await exec(
			["auth", "check", "--provider", provider, "--json"],
			{ timeoutMs: DEFAULT_TIMEOUT_MS },
		);
		if (result.exitCode !== 0) {
			return {
				name: "pi",
				ok: false,
				detail: clamp(
					`pi auth check failed (exit ${result.exitCode}): ${excerpt(result.stderr || result.stdout)}`,
					MAX_DETAIL,
				),
			};
		}
		let status: unknown;
		try {
			status = asRecord(JSON.parse(result.stdout))?.status;
		} catch {
			status = undefined;
		}
		if (status === "ready") return { name: "pi", ok: true, detail: "ready" };
		return {
			name: "pi",
			ok: false,
			detail: clamp(
				`pi auth status ${typeof status === "string" ? status : "unknown"}: ${excerpt(result.stderr || result.stdout)}`,
				MAX_DETAIL,
			),
		};
	} catch (error) {
		return {
			name: "pi",
			ok: false,
			detail: clamp(describeError(error), MAX_DETAIL),
		};
	}
}

function createPiExec(bin: string): PiExec {
	return (args, { timeoutMs }) =>
		new Promise((resolve, reject) => {
			execFile(
				bin,
				args,
				{ timeout: timeoutMs, shell: false },
				(error, stdout, stderr) => {
					if (error === null) {
						resolve({ stdout, stderr, exitCode: 0 });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ stdout, stderr, exitCode: error.code });
						return;
					}
					reject(error);
				},
			);
		});
}

function buildArgs(
	spec: AgentSpec,
	provider: string,
	sessionDir: string,
): string[] {
	const tools = spec.tools === "read-only" ? READ_ONLY_TOOLS : WRITE_TOOLS;
	const args = [
		"--mode",
		"json",
		"--tools",
		tools,
		"--session-dir",
		sessionDir,
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-mcp",
		"--no-approve",
	];
	if (spec.model !== null) {
		args.push(
			"--model",
			spec.model.includes("/") ? spec.model : `${provider}/${spec.model}`,
		);
	}
	args.push("--", spec.instructions);
	return args;
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			const item = asRecord(block);
			return item?.type === "text" && typeof item.text === "string"
				? [item.text]
				: [];
		})
		.join("");
}

function addUsage(
	current: UsageRecord,
	usage: Record<string, unknown> | null,
): UsageRecord {
	return {
		tokensIn: addUsageValue(
			current.tokensIn,
			sumUsage([usage?.input, usage?.cacheRead, usage?.cacheWrite]),
		),
		tokensOut: addUsageValue(current.tokensOut, sumUsage([usage?.output])),
		cost: addUsageValue(current.cost, sumUsage([asRecord(usage?.cost)?.total])),
	};
}

function sumUsage(values: unknown[]): number | null {
	let total = 0;
	for (const value of values) {
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		total += value;
	}
	return total;
}

function addUsageValue(current: Usage, value: number | null): Usage {
	if (current === "unknown" || value === null) return "unknown";
	return current + value;
}

function excerpt(value: string): string {
	const text = value.trim();
	return text.length > 0 ? text : "no output";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

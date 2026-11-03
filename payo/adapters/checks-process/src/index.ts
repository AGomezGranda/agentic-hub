import {
	type ChildProcess,
	spawn as nodeSpawn,
	type SpawnOptions,
} from "node:child_process";
import type { CheckCommand, CheckResult, Checks } from "@payo/kernel";

const MAX_LOG_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = "\n...[truncated]";
const DEFAULT_KILL_GRACE_MS = 2000;

type Spawn = typeof nodeSpawn;

export interface ProcessChecksOptions {
	spawn?: Spawn;
	killGraceMs?: number;
}

/** Runs the configured argv exactly as supplied, in order, without a shell. */
export function createProcessChecks(
	options: ProcessChecksOptions = {},
): Checks {
	const spawn = options.spawn ?? nodeSpawn;
	const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	if (!Number.isInteger(killGraceMs) || killGraceMs < 1)
		throw new RangeError("killGraceMs must be a positive integer");

	return {
		async run(cwd, commands, signal): Promise<CheckResult[]> {
			if (process.platform === "win32")
				throw new Error("process-tree checks require POSIX process groups");
			const results: CheckResult[] = [];
			for (const command of commands) {
				if (signal.aborted) {
					results.push(cancelledResult(command.name));
					continue;
				}
				results.push(await runOne(spawn, command, cwd, signal, killGraceMs));
			}
			return results;
		},
	};
}

async function runOne(
	spawn: Spawn,
	command: CheckCommand,
	cwd: string,
	signal: AbortSignal,
	killGraceMs: number,
): Promise<CheckResult> {
	if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1)
		return failedToSpawn(command.name, "timeoutMs must be a positive integer");
	let child: ChildProcess;
	try {
		const spawnOptions: SpawnOptions = {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
			detached: true,
		};
		child = spawn(command.command, [...command.args], spawnOptions);
	} catch (error) {
		return failedToSpawn(command.name, describeError(error));
	}

	const stdout = boundedCapture();
	const stderr = boundedCapture();
	child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(chunk));

	return new Promise<CheckResult>((resolve) => {
		let forced: "timed_out" | "cancelled" | null = null;
		let spawnError: Error | null = null;
		let exitCode: number | null = null;
		let closed = false;
		let cleanup: Promise<void> | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const finish = (status: CheckResult["status"]) => {
			if (!closed) return;
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal.removeEventListener("abort", onAbort);
			const out = stdout.finish();
			const err = stderr.finish();
			resolve({
				name: command.name,
				status,
				exitCode,
				stdout: out.text,
				stderr:
					err.text ||
					(status === "spawn_failed"
						? (spawnError?.message ?? "process spawn failed")
						: ""),
				truncated: out.truncated || err.truncated,
			});
		};

		const stop = () => {
			if (cleanup) return cleanup;
			cleanup = terminateProcessTree(child, killGraceMs);
			return cleanup;
		};

		const onAbort = () => {
			if (closed || forced !== null) return;
			forced = "cancelled";
			void stop().catch((error) => {
				spawnError ??= asError(error);
			});
		};

		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (code) => {
			closed = true;
			exitCode = code;
			if (timer) clearTimeout(timer);
			// A command that exits after starting a background child must not leave it writing.
			void (async () => {
				try {
					if (cleanup) await cleanup;
					else if (child.pid !== undefined)
						await terminateIfGroupRemains(child.pid, killGraceMs);
				} catch (error) {
					spawnError ??= asError(error);
				}
				if (forced !== null) finish(forced);
				else if (spawnError !== null) finish("spawn_failed");
				else finish(code === 0 ? "passed" : "failed");
			})();
		});

		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		timer = setTimeout(() => {
			if (closed || forced !== null) return;
			forced = "timed_out";
			void stop().catch((error) => {
				spawnError ??= asError(error);
			});
		}, command.timeoutMs);
		timer.unref();
	});
}

async function terminateProcessTree(
	child: ChildProcess,
	killGraceMs: number,
): Promise<void> {
	if (child.pid === undefined) {
		child.kill("SIGTERM");
		return;
	}
	const pid = child.pid;
	signalGroup(pid, "SIGTERM", child);
	if (await waitForGroupExit(pid, killGraceMs)) return;
	signalGroup(pid, "SIGKILL", child);
	// Do not release the check/writer lane while any group member can still mutate the workspace.
	while (groupExists(pid)) await delay(25);
}

async function terminateIfGroupRemains(
	pid: number,
	killGraceMs: number,
): Promise<void> {
	if (!groupExists(pid)) return;
	signalGroup(pid, "SIGTERM");
	if (await waitForGroupExit(pid, killGraceMs)) return;
	signalGroup(pid, "SIGKILL");
	while (groupExists(pid)) await delay(25);
}

function signalGroup(
	pid: number,
	signal: NodeJS.Signals,
	child?: ChildProcess,
): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (isNoSuchProcess(error)) return;
		child?.kill(signal);
	}
}

async function waitForGroupExit(
	pid: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (groupExists(pid)) {
		if (Date.now() >= deadline) return false;
		await delay(25);
	}
	return true;
}

function groupExists(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return !isNoSuchProcess(error);
	}
}

function isNoSuchProcess(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ESRCH"
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedCapture() {
	let size = 0;
	let truncated = false;
	const chunks: Buffer[] = [];
	return {
		push(chunk: Buffer | string) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			const remaining = MAX_LOG_BYTES - size;
			if (remaining > 0) {
				const accepted = bytes.subarray(0, remaining);
				chunks.push(accepted);
				size += accepted.byteLength;
			}
			if (bytes.byteLength > remaining) truncated = true;
		},
		finish(): { text: string; truncated: boolean } {
			const text = Buffer.concat(chunks).toString("utf8");
			return {
				text: truncated ? `${text}${TRUNCATION_MARKER}` : text,
				truncated,
			};
		},
	};
}

function cancelledResult(name: string): CheckResult {
	return {
		name,
		status: "cancelled",
		exitCode: null,
		stdout: "",
		stderr: "",
		truncated: false,
	};
}

function failedToSpawn(name: string, message: string): CheckResult {
	return {
		name,
		status: "spawn_failed",
		exitCode: null,
		stdout: "",
		stderr: message,
		truncated: false,
	};
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

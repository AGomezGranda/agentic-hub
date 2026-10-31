import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentEvent,
	AgentSpec,
	type ArtifactRef,
	type AttemptOutcome,
	type OutputValidator,
	type RunEventBody,
	type StepOutcome,
	type UsageRecord,
} from "@payo/contracts";
import type { AgentRunner } from "./agent.ts";
import { describeReason, type Limiter } from "./fanout.ts";
import type { RunLog } from "./run-log.ts";
import type { RunStore } from "./store.ts";

export const RETRY_NOTE =
	"Fix the output in the previous-output input, following the validation-error input.";

const UNKNOWN_USAGE: UsageRecord = {
	tokensIn: "unknown",
	tokensOut: "unknown",
	cost: "unknown",
};

// One commit per 32 streamed rows instead of one per row.
const ATTEMPT_EVENT_BATCH = 32;

export interface AgentDeps {
	store: RunStore;
	log: RunLog;
	limiter: Limiter;
}

export interface StepInput {
	stepId: string;
	stepName: string;
	attemptIds: readonly [string, string];
	runner: AgentRunner;
	spec: AgentSpec;
	validate: OutputValidator;
	signal: AbortSignal;
}

export interface StepResult {
	outcome: StepOutcome;
	value?: unknown;
}

/** One step: up to two attempts (the second only after rejected output), then a gate or a clean finish. */
export async function runAgentStep(
	deps: AgentDeps,
	input: StepInput,
): Promise<StepResult> {
	AgentSpec.parse(input.spec); // throws before any row is written
	await deps.log.write([
		{ type: "step.started", stepId: input.stepId, name: input.stepName },
	]);
	try {
		return await runAttempts(deps, input);
	} catch (error) {
		// Best effort: a step left running blocks run.ended, so record the failure before rethrowing.
		await deps.log
			.write([
				{ type: "step.finished", stepId: input.stepId, outcome: "failed" },
			])
			.catch(() => {});
		throw error;
	}
}

async function runAttempts(
	deps: AgentDeps,
	input: StepInput,
): Promise<StepResult> {
	let spec = input.spec;
	for (const [index, attemptId] of input.attemptIds.entries()) {
		const run = await deps.limiter.run(() =>
			executeAttempt(deps, input, attemptId, spec),
		);
		if (run.outcome === "succeeded") {
			await deps.log.write([
				{ type: "step.finished", stepId: input.stepId, outcome: "succeeded" },
			]);
			return { outcome: "succeeded", value: run.value };
		}
		// Cancel is an operator action, not a fault: no gate.
		if (run.outcome === "cancelled") {
			await deps.log.write([
				{ type: "step.finished", stepId: input.stepId, outcome: "failed" },
			]);
			return { outcome: "failed" };
		}
		if (run.rejected === undefined) {
			return closeWithGate(
				deps,
				input.stepId,
				"failed",
				run.error ?? run.outcome,
			);
		}

		const output = await recordText(
			deps,
			run.rejected.text,
			"agent-output",
			attemptId,
		);
		if (index + 1 < input.attemptIds.length) {
			const error = await recordText(
				deps,
				run.rejected.error,
				"validation-error",
				attemptId,
			);
			spec = retrySpec(input.spec, output, error);
			continue;
		}
		return closeWithGate(
			deps,
			input.stepId,
			"escalated",
			`${run.rejected.error} (rejected output ${output.sha256})`,
		);
	}
	throw new Error("unreachable: the last attempt always returns");
}

type Terminal =
	| { kind: "result"; text: string }
	| { kind: "error"; message: string }
	| { kind: "aborted" }
	| { kind: "deadline" };

interface AttemptRun {
	outcome: AttemptOutcome;
	error?: string;
	value?: unknown;
	rejected?: { text: string; error: string };
}

interface Watch {
	signal: AbortSignal;
	stopped: Promise<undefined>;
	terminal?: Terminal;
	usage?: UsageRecord;
	dispose(): void;
}

async function executeAttempt(
	deps: AgentDeps,
	input: StepInput,
	attemptId: string,
	spec: AgentSpec,
): Promise<AttemptRun> {
	if (input.signal.aborted) return { outcome: "cancelled" };
	const watch = watchAttempt(input.signal, spec.timeoutMs);
	let dir: string | undefined;
	try {
		await deps.log.write([
			{
				type: "attempt.started",
				attemptId,
				stepId: input.stepId,
				role: spec.role,
				runner: input.runner.id,
				model: spec.model,
				roleSpecSha: spec.roleSpecSha,
				inputArtifacts: spec.inputs.map((i) => i.ref.sha256),
			},
		]);
		let rawLogPath: string | undefined;
		try {
			dir = await mkdtemp(join(tmpdir(), "payo-attempt-"));
			rawLogPath = join(dir, "events.jsonl");
		} catch {
			// Best effort: raw capture never blocks the attempt.
		}
		// The outer finally removes the directory, so a parse failure cannot leak it.
		const runnerSpec = AgentSpec.parse({
			...spec,
			correlation: {
				runId: deps.log.current().runId,
				stepId: input.stepId,
				attemptId,
			},
			rawLogPath,
		});
		try {
			const run = await streamAttempt(
				deps,
				input,
				attemptId,
				runnerSpec,
				watch,
			);
			await captureRawLog(deps, rawLogPath, attemptId);
			await deps.log.write([
				{
					type: "attempt.finished",
					attemptId,
					outcome: run.outcome,
					usage: watch.usage ?? UNKNOWN_USAGE,
					error: run.error,
				},
			]);
			return run;
		} catch (error) {
			await captureRawLog(deps, rawLogPath, attemptId);
			// Best effort: preserve the original error over a failed write.
			await deps.log
				.write([
					{
						type: "attempt.finished",
						attemptId,
						outcome: "failed",
						usage: watch.usage ?? UNKNOWN_USAGE,
						error: describeReason(error),
					},
				])
				.catch(() => {});
			throw error;
		}
	} finally {
		watch.dispose();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
}

// shortcut: the raw log is unbounded; cap it when a real attempt produces a log large enough to matter.
async function captureRawLog(
	deps: AgentDeps,
	rawLogPath: string | undefined,
	attemptId: string,
): Promise<void> {
	if (rawLogPath === undefined) return;
	try {
		const bytes = await readFile(rawLogPath);
		if (bytes.byteLength === 0) return;
		const artifact = await deps.store.putArtifact(bytes, {
			kind: "agent-raw-log",
			mediaType: "application/x-ndjson",
		});
		await deps.log.write([{ type: "artifact.recorded", artifact, attemptId }]);
	} catch {
		// Best effort: a missing raw artifact does not fail the attempt.
	}
}

async function streamAttempt(
	deps: AgentDeps,
	input: StepInput,
	attemptId: string,
	spec: AgentSpec,
	watch: Watch,
): Promise<AttemptRun> {
	const pending: RunEventBody[] = [];
	const flush = async () => {
		if (pending.length === 0) return;
		const batch = pending.splice(0);
		await deps.log.write(batch);
	};
	try {
		if (watch.terminal === undefined) {
			const iterator = input.runner
				.run(spec, watch.signal)
				[Symbol.asyncIterator]();
			try {
				// shortcut: no cap on attempt.event rows per attempt, a runner can write until the deadline; upgrade with a per-attempt event budget when step 6 runs real harnesses.
				while (watch.terminal === undefined) {
					const next = await Promise.race([iterator.next(), watch.stopped]);
					if (next === undefined) break;
					if (next.done) break;
					// Parsed at receipt: a schema-invalid event must not reach the log or the usage record.
					const event = AgentEvent.parse(next.value);
					// Terminal is set before the write, so a deadline during the write cannot overturn a received result.
					if (event.type === "usage") watch.usage = event.usage;
					if (watch.terminal === undefined) {
						if (event.type === "result")
							watch.terminal = { kind: "result", text: event.text };
						if (event.type === "error")
							watch.terminal = { kind: "error", message: event.message };
					}
					pending.push({ type: "attempt.event", attemptId, event });
					if (
						watch.terminal !== undefined ||
						pending.length >= ATTEMPT_EVENT_BATCH
					)
						await flush();
					// Yield so the deadline timer can fire when a runner emits without awaiting I/O.
					await new Promise((resolve) => setImmediate(resolve));
				}
			} finally {
				// shortcut: awaiting runner cleanup for up to 1 s; upgrade if a real adapter needs longer.
				await Promise.race([
					Promise.resolve()
						.then(() => iterator.return?.())
						.then(() => undefined)
						.catch(() => {}),
					new Promise<void>((resolve) => {
						setTimeout(resolve, 1000).unref();
					}),
				]);
			}
		}
		await flush();
		return classify(watch.terminal, spec, input.validate);
	} catch (error) {
		await flush().catch(() => {});
		throw error;
	}
}

function classify(
	terminal: Terminal | undefined,
	spec: AgentSpec,
	validate: OutputValidator,
): AttemptRun {
	switch (terminal?.kind) {
		case "aborted":
			return { outcome: "cancelled" };
		case "deadline":
			return {
				outcome: "timed_out",
				error: `timed out after ${spec.timeoutMs} ms`,
			};
		case "error":
			return { outcome: "failed", error: terminal.message };
		case "result": {
			const check = validate(terminal.text);
			if (check.ok) return { outcome: "succeeded", value: check.value };
			return {
				outcome: "failed",
				error: check.error,
				rejected: { text: terminal.text, error: check.error },
			};
		}
		default:
			return { outcome: "failed", error: "runner ended without a result" };
	}
}

// The first of result, error, parent abort or deadline sets `terminal`; a later one never overwrites it.
function watchAttempt(parent: AbortSignal, timeoutMs: number): Watch {
	const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
	let wake = () => {};
	const stopped = new Promise<undefined>((resolve) => {
		wake = () => resolve(undefined);
	});
	const onAbort = () => {
		watch.terminal ??= parent.aborted
			? { kind: "aborted" }
			: { kind: "deadline" };
		wake();
	};
	const watch: Watch = {
		signal,
		stopped,
		dispose: () => signal.removeEventListener("abort", onAbort),
	};
	signal.addEventListener("abort", onAbort, { once: true });
	return watch;
}

async function closeWithGate(
	deps: AgentDeps,
	stepId: string,
	outcome: "failed" | "escalated",
	reason: string,
): Promise<StepResult> {
	await deps.log.write([
		{
			type: "gate.raised",
			gateId: `escalation:${stepId}`,
			stepId,
			kind: "escalation",
			allowedCommands: ["retry", "abandon"],
			reason,
		},
		{ type: "step.finished", stepId, outcome },
	]);
	return { outcome };
}

async function recordText(
	deps: AgentDeps,
	text: string,
	kind: string,
	attemptId: string,
): Promise<ArtifactRef> {
	const artifact = await deps.store.putArtifact(
		new TextEncoder().encode(text),
		{ kind, mediaType: "text/plain" },
	);
	await deps.log.write([{ type: "artifact.recorded", artifact, attemptId }]);
	return artifact;
}

function retrySpec(
	spec: AgentSpec,
	output: ArtifactRef,
	error: ArtifactRef,
): AgentSpec {
	return {
		...spec,
		instructions: `${spec.instructions}\n\n${RETRY_NOTE}`,
		inputs: [
			...spec.inputs,
			{ name: "previous-output", ref: output },
			{ name: "validation-error", ref: error },
		],
	};
}

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSpec, OutputValidator } from "@payo/contracts";
import { createGitWorkspace } from "@payo/git";
import { createPiRunner } from "@payo/runner-pi";
import { describe, expect, it } from "vitest";

const repo = process.env.PAYO_REPO ?? process.cwd();
const base = process.env.PAYO_BASE_BRANCH ?? "main";
const model = process.env.PAYO_MODEL?.trim() || null;

const validate: OutputValidator = (text) => {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, error: "output is not JSON" };
	}
	const value =
		typeof raw === "object" && raw !== null
			? (raw as { ok?: unknown }).ok
			: undefined;
	return value === true
		? { ok: true, value: raw }
		: { ok: false, error: "expected { ok: true }" };
};

async function collect(
	stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function resultOf(events: AgentEvent[]): string {
	for (const event of events) {
		if (event.type === "error") throw new Error(`pi error: ${event.message}`);
	}
	const result = events.findLast((event) => event.type === "result");
	if (result?.type !== "result") throw new Error("no pi result");
	return result.text;
}

async function attempt(
	runner: ReturnType<typeof createPiRunner>,
	cwd: string,
	rawLogPath: string,
	instructions: string,
): Promise<{ text: string; check: ReturnType<OutputValidator> }> {
	const run = `live-${Date.now()}`;
	const spec: AgentSpec = {
		role: "smoke",
		instructions,
		roleSpecSha: null,
		cwd,
		tools: "read-only",
		model,
		timeoutMs: 120_000,
		outputContract: "smoke",
		inputs: [],
		correlation: { runId: run, stepId: "smoke", attemptId: "a1" },
		rawLogPath,
	};
	const events = await collect(runner.run(spec, AbortSignal.timeout(120_000)));
	const text = resultOf(events).trim();
	expect((await readFile(rawLogPath)).byteLength).toBeGreaterThan(0);
	return { text, check: validate(text) };
}

describe.runIf(process.env.PAYO_LIVE === "1")("live Pi smoke", () => {
	it("returns a valid envelope and cannot write", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "payo-live-"));
		const workspace = createGitWorkspace({
			root: join(dataDir, "worktrees"),
		});
		const worktree = await workspace.create("live-run", repo, base);
		const runner = createPiRunner({
			bin: process.env.PAYO_PI_BIN?.trim() || "pi",
			provider: process.env.PAYO_PI_PROVIDER?.trim() || "anthropic",
			sessionRoot: join(dataDir, "sessions"),
		});
		try {
			const read = await attempt(
				runner,
				worktree,
				join(dataDir, "raw", "read.jsonl"),
				'Return exactly {"ok":true} and nothing else.',
			);
			expect(read.check).toEqual({ ok: true, value: { ok: true } });

			const write = await attempt(
				runner,
				worktree,
				join(dataDir, "raw", "write.jsonl"),
				'Create a file named canary.txt with the text "x", then return exactly {"ok":true} and nothing else.',
			);
			expect(write.check).toEqual({ ok: true, value: { ok: true } });
			await expect(stat(join(worktree, "canary.txt"))).rejects.toThrow();
		} finally {
			await workspace.remove(worktree);
			await rm(dataDir, { recursive: true, force: true });
		}
	}, 600_000);
});

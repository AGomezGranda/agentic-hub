import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessChecks } from "./index.ts";

const dirs: string[] = [];
const checks = createProcessChecks({ killGraceMs: 100 });

async function tempDir() {
	const path = await mkdtemp(join(tmpdir(), "payo-checks-"));
	dirs.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

const command = (name: string, script: string, timeoutMs = 2000) => ({
	name,
	command: process.execPath,
	args: ["-e", script],
	timeoutMs,
});

describe("createProcessChecks", () => {
	it("executes checks sequentially and reports nonzero and spawn failures explicitly", async () => {
		const cwd = await tempDir();
		const order: string[] = [];
		const results = await checks.run(
			cwd,
			[
				command(
					"one",
					`require('fs').appendFileSync('order', '1'); process.exit(0)`,
				),
				command(
					"two",
					`require('fs').appendFileSync('order', '2'); process.exit(7)`,
				),
				{
					name: "missing",
					command: "/missing/payo-check",
					args: [],
					timeoutMs: 500,
				},
			],
			new AbortController().signal,
		);
		order.push(await readFile(join(cwd, "order"), "utf8"));
		expect(order).toEqual(["12"]);
		expect(results.map((result) => result.status)).toEqual([
			"passed",
			"failed",
			"spawn_failed",
		]);
		expect(results[1]).toMatchObject({ exitCode: 7 });
		expect(results[2]?.stderr).toContain("ENOENT");
	});

	it("times out and aborts processes with explicit outcomes", async () => {
		const cwd = await tempDir();
		const timed = await checks.run(
			cwd,
			[command("timeout", `setTimeout(() => {}, 10000)`, 40)],
			new AbortController().signal,
		);
		expect(timed[0]).toMatchObject({ name: "timeout", status: "timed_out" });

		const controller = new AbortController();
		const running = checks.run(
			cwd,
			[command("abort", `setTimeout(() => {}, 10000)`)],
			controller.signal,
		);
		setTimeout(() => controller.abort(), 40);
		const cancelled = await running;
		expect(cancelled[0]).toMatchObject({ name: "abort", status: "cancelled" });
	});

	it("bounds each log stream and appends an explicit truncation marker", async () => {
		const cwd = await tempDir();
		const results = await checks.run(
			cwd,
			[command("large", `process.stdout.write('x'.repeat(1024 * 1024 + 10))`)],
			new AbortController().signal,
		);
		expect(results[0]?.status).toBe("passed");
		expect(results[0]?.truncated).toBe(true);
		expect(results[0]?.stdout.length).toBeLessThan(1024 * 1024 + 100);
		expect(results[0]?.stdout).toContain("[truncated]");
	});

	it("kills descendants and waits for them before returning", async () => {
		const cwd = await tempDir();
		const marker = join(cwd, "escaped.txt");
		const child = `const fs=require('fs'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 700)`;
		const parent = `const {spawn}=require('child_process'); spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); setTimeout(()=>{},10000)`;
		const controller = new AbortController();
		const running = checks.run(
			cwd,
			[command("tree", parent)],
			controller.signal,
		);
		setTimeout(() => controller.abort(), 60);
		const [result] = await running;
		expect(result?.status).toBe("cancelled");
		await new Promise((resolve) => setTimeout(resolve, 800));
		await expect(readFile(marker, "utf8")).rejects.toThrow();
	});

	it("rejects process-tree execution on unsupported hosts", async () => {
		if (process.platform !== "win32") return;
		await expect(
			checks.run(
				process.cwd(),
				[command("unsupported", "")],
				new AbortController().signal,
			),
		).rejects.toThrow(/POSIX/i);
	});
});

import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Runs under plain Node, not Vitest's resolver: proves .ts workspace packages load through pnpm links.
it("starts under plain Node, reports readiness, and shuts down on SIGTERM", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const dataDir = await mkdtemp(join(tmpdir(), "payo-main-"));
	const child = spawn(
		process.execPath,
		["--no-warnings", main, "--dev-fakes"],
		{
			env: {
				...process.env,
				NODE_ENV: "test",
				PAYO_TEST_PORT: "0",
				PAYO_DATA_DIR: dataDir,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`server did not become ready: ${stdout}`)),
			10_000,
		);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes("payo server ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`server exited early with ${code}: ${stderr}`));
		});
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	await ready;
	expect(stdout).toMatch(/payo server listening on http:\/\/127\.0\.0\.1:\d+/);
	child.kill("SIGTERM");
	const code = await new Promise<number | null>((resolve) =>
		child.on("exit", (value) => resolve(value)),
	);
	expect(code).toBe(0);
	expect(stderr).toBe("");
	expect(stdout).toContain("payo server stopping (SIGTERM)");
}, 20_000);

it("refuses to start in real mode when the doctor fails", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const dataDir = await mkdtemp(join(tmpdir(), "payo-main-"));
	const repo = await mkdtemp(join(tmpdir(), "payo-repo-"));
	const child = spawn(process.execPath, ["--no-warnings", main], {
		env: {
			...process.env,
			NODE_ENV: "test",
			PAYO_TEST_PORT: "0",
			PAYO_DATA_DIR: dataDir,
			PAYO_REPO: repo,
			PAYO_MODEL: "test-model",
			PAYO_SCENARIO: "",
			PAYO_PI_BIN: "/nonexistent-payo-pi",
			PAYO_ACLI_BIN: "/nonexistent-payo-acli",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`doctor did not finish: ${stderr}`)),
			20_000,
		);
		child.on("exit", (value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
	expect(code).not.toBe(0);
	expect(stderr).toMatch(/doctor/);
	expect(stderr).toMatch(/FAIL/);
	expect(stdout).not.toContain("payo server ready");
}, 30_000);

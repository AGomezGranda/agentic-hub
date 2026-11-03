import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	architectureRubricPaths,
	codeQualityRubricPaths,
	planLensResourcePaths,
} from "@payo/factory";
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

it("starts in real mode when only the Jira CLI is unavailable", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const { dataDir, repo, piBin } = await realModeFixture("payo-main-ready-");

	const child = spawn(process.execPath, ["--no-warnings", main], {
		env: {
			...process.env,
			NODE_ENV: "test",
			PAYO_TEST_PORT: "0",
			PAYO_DATA_DIR: dataDir,
			PAYO_REPO: repo,
			PAYO_MODEL: "test-model",
			PAYO_SCENARIO: "",
			PAYO_PI_BIN: piBin,
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
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(new Error(`server did not become ready: ${stdout} ${stderr}`)),
			20_000,
		);
		child.stdout.on("data", () => {
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
	await ready;
	expect(stdout).toContain("payo server ready");
	expect(stderr).not.toContain("FAIL acli");
	child.kill("SIGTERM");
	const code = await new Promise<number | null>((resolve) =>
		child.on("exit", (value) => resolve(value)),
	);
	expect(code).toBe(0);
}, 30_000);

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

it("--check reports missing models and exits", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const root = await mkdtemp(join(tmpdir(), "payo-check-"));
	const configFile = join(root, "config.toml");
	await writeFile(configFile, `[paths]\nrepo = "${root}"\n`);
	const { stdout, stderr, code } = await runMain(main, ["--check"], {
		PAYO_CONFIG_FILE: configFile,
		PAYO_MODEL: "",
	});
	expect(code).toBe(1);
	expect(stdout + stderr).toMatch(/FAIL models: .*missing: planner/);
}, 20_000);

it("--check passes in real mode when only the Jira CLI is unavailable", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const { dataDir, repo, piBin } = await realModeFixture("payo-check-ready-");
	const { stdout, code } = await runMain(main, ["--check"], {
		PAYO_CONFIG_FILE: await emptyConfigFile(),
		PAYO_DATA_DIR: dataDir,
		PAYO_REPO: repo,
		PAYO_MODEL: "test-model",
		PAYO_PI_BIN: piBin,
		PAYO_ACLI_BIN: "/nonexistent-payo-acli",
	});
	expect(stdout).toMatch(/ok +pi:/);
	expect(stdout).toMatch(/ok +skills:/);
	expect(stdout).toMatch(/warn +acli:/);
	expect(code).toBe(0);
}, 30_000);

it("--check fails in real mode when pi is unavailable", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const { dataDir, repo } = await realModeFixture("payo-check-nopi-");
	const { stdout, code } = await runMain(main, ["--check"], {
		PAYO_CONFIG_FILE: await emptyConfigFile(),
		PAYO_DATA_DIR: dataDir,
		PAYO_REPO: repo,
		PAYO_MODEL: "test-model",
		PAYO_PI_BIN: "/nonexistent-payo-pi",
		PAYO_ACLI_BIN: "/nonexistent-payo-acli",
	});
	expect(stdout).toMatch(/FAIL +pi:/);
	expect(code).toBe(1);
}, 30_000);

it("--check skips real-mode checks with dev fakes", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const { stdout, code } = await runMain(main, ["--check", "--dev-fakes"], {
		PAYO_CONFIG_FILE: await emptyConfigFile(),
	});
	expect(code).toBe(0);
	expect(stdout).toContain("dev fakes selected");
}, 20_000);

it("--check reports a config error and exits 1", async () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const { stdout, stderr, code } = await runMain(main, ["--check"], {
		PAYO_CONFIG_FILE: await emptyConfigFile(),
		PAYO_PI_BIN: " ",
	});
	expect(code).toBe(1);
	expect(stdout + stderr).toMatch(
		/FAIL config: .*PAYO_PI_BIN must not be blank/,
	);
}, 20_000);

async function emptyConfigFile(): Promise<string> {
	const file = join(
		await mkdtemp(join(tmpdir(), "payo-empty-")),
		"config.toml",
	);
	await writeFile(file, "");
	return file;
}

async function realModeFixture(prefix: string) {
	const dataDir = await mkdtemp(join(tmpdir(), prefix));
	const repo = await mkdtemp(join(tmpdir(), "payo-real-repo-"));
	await mkdir(join(repo, "skills/create-plan"), { recursive: true });
	await mkdir(join(repo, "skills/review-plan/references"), { recursive: true });
	await writeFile(join(repo, "skills/create-plan/SKILL.md"), "# Planner\n");
	await writeFile(join(repo, "skills/review-plan/SKILL.md"), "# Reviewer\n");
	for (const path of [
		...planLensResourcePaths,
		...architectureRubricPaths,
		...codeQualityRubricPaths,
	]) {
		await mkdir(dirname(join(repo, path)), { recursive: true });
		await writeFile(join(repo, path), `# ${path}\n`);
	}
	execFileSync("git", ["init", "-b", "main", repo]);
	execFileSync("git", [
		"-C",
		repo,
		"config",
		"user.email",
		"payo@example.test",
	]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Payo Test"]);
	execFileSync("git", ["-C", repo, "add", "skills"]);
	execFileSync("git", ["-C", repo, "commit", "-m", "Add role skills"]);
	const piBin = join(dataDir, "pi-ready");
	await writeFile(
		piBin,
		"#!/bin/sh\nprintf '%s\\n' '{\"status\":\"ready\"}'\n",
	);
	await chmod(piBin, 0o755);
	return { dataDir, repo, piBin };
}

// Drops inherited PAYO_* so a developer's shell cannot change the outcome; killed after 15s.
function runMain(
	main: string,
	args: string[],
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("PAYO_")),
	);
	const child = spawn(process.execPath, ["--no-warnings", main, ...args], {
		env: { ...inherited, NODE_ENV: "test", ...env },
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
	const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
	return new Promise((resolve) => {
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code });
		});
	});
}

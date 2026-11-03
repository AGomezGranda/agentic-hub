import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const payoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverMain = join(payoRoot, "apps/server/src/main.ts");
const cliMain = join(payoRoot, "apps/cli/src/index.ts");

interface Result {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface Server {
	child: ChildProcess;
	url: string;
	readonly stdout: string;
	readonly stderr: string;
	stop(signal?: NodeJS.Signals): Promise<Result>;
}

interface ServerOptions {
	configFile?: string;
	testPort?: string | null;
	tomlDataDir?: boolean;
}

async function startServer(
	dataDir: string,
	scenario: string,
	repo = payoRoot,
	options: ServerOptions = {},
): Promise<Server> {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "test",
		HOME: dataDir || process.env.HOME,
		PAYO_REPO: repo,
		PAYO_BASE_BRANCH: "main",
		PAYO_SCENARIO: scenario,
	};
	if (options.configFile) env.PAYO_CONFIG_FILE = options.configFile;
	else delete env.PAYO_CONFIG_FILE;
	if (options.testPort === null) {
		delete env.PAYO_TEST_PORT;
		delete env.PAYO_PORT;
	} else env.PAYO_TEST_PORT = options.testPort ?? "0";
	if (options.tomlDataDir) delete env.PAYO_DATA_DIR;
	else env.PAYO_DATA_DIR = dataDir;
	const child = spawn(
		process.execPath,
		["--no-warnings", serverMain, "--dev-fakes"],
		{
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	let exiting: Promise<Result> | undefined;
	const exit = () => {
		exiting ??= new Promise<Result>((resolve) =>
			child.on("exit", (code) => resolve({ code, stdout, stderr })),
		);
		return exiting;
	};
	exit();

	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(new Error(`server did not become ready: ${stdout}\n${stderr}`)),
			10_000,
		);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes("payo server ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		void exit().then(({ code }) => {
			clearTimeout(timer);
			reject(new Error(`server exited early (${code}): ${stderr}`));
		});
	});
	await ready;
	const url = stdout.match(
		/payo server listening on (http:\/\/127\.0\.0\.1:\d+)/,
	)?.[1];
	if (!url) throw new Error(`missing server URL: ${stdout}`);
	return {
		child,
		url,
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
		async stop(signal = "SIGTERM") {
			child.kill(signal);
			return exit();
		},
	};
}

async function cli(
	dataDir: string | null,
	url: string,
	args: string[],
	env: NodeJS.ProcessEnv = {},
	options: { testServerUrl?: boolean } = {},
): Promise<Result> {
	const childEnv: NodeJS.ProcessEnv = {
		...process.env,
		NODE_ENV: "test",
		HOME: dataDir || process.env.HOME,
	};
	delete childEnv.PAYO_CONFIG_FILE;
	if (dataDir === null) delete childEnv.PAYO_DATA_DIR;
	else childEnv.PAYO_DATA_DIR = dataDir;
	if (options.testServerUrl === false) {
		delete childEnv.PAYO_TEST_SERVER_URL;
		delete childEnv.PAYO_PORT;
	} else childEnv.PAYO_TEST_SERVER_URL = url;
	Object.assign(childEnv, env);
	const child = spawn(process.execPath, ["--no-warnings", cliMain, ...args], {
		env: childEnv,
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
	return new Promise<Result>((resolve) => {
		child.on("exit", (code) => resolve({ code, stdout, stderr }));
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
	read: () => Promise<T | undefined>,
	timeoutMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await sleep(50);
	}
	throw new Error("timed out waiting for process state");
}

async function status(dataDir: string, url: string, runId: string) {
	return waitFor(async () => {
		const result = await cli(dataDir, url, ["status", runId]);
		return result.code === 0 ? result.stdout : undefined;
	});
}

async function logs(dataDir: string, url: string, runId: string) {
	return waitFor(async () => {
		const result = await cli(dataDir, url, ["logs", runId]);
		return result.code === 0 ? result.stdout : undefined;
	});
}

async function editor(dataDir: string): Promise<string> {
	const path = join(dataDir, "editor.mjs");
	await writeFile(
		path,
		[
			'import { readFileSync, writeFileSync } from "node:fs";',
			"const file = process.argv.at(-1);",
			'writeFileSync(file, readFileSync(file, "utf8") + "\\nHuman edit from e2e.\\n");',
		].join("\n"),
	);
	return path;
}

async function freeLoopbackPort(): Promise<number> {
	const server = createTcpServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	return port;
}

async function startConfiguredPortServer(
	configFile: string,
	dataDir: string,
): Promise<{ server: Server; port: number }> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = await freeLoopbackPort();
		await writeFile(
			configFile,
			`[server]\nport = ${port}\n[paths]\ndata_dir = ${JSON.stringify(dataDir)}\n`,
		);
		try {
			const server = await startServer("", "clean", payoRoot, {
				configFile,
				testPort: null,
				tomlDataDir: true,
			});
			return { server, port };
		} catch (error) {
			if (!String(error).includes("EADDRINUSE") || attempt === 4) throw error;
		}
	}
	throw new Error("could not reserve a free loopback port for Payo");
}

async function waitForApproval(
	dataDir: string,
	url: string,
	runId: string,
	minimumGateEvents = 1,
): Promise<void> {
	await waitFor(async () => {
		const text = await status(dataDir, url, runId);
		if (!text.includes("stage: Approval")) return undefined;
		const events = await logs(dataDir, url, runId);
		const gates = events.split('"kind":"approval"').length - 1;
		return gates >= minimumGateEvents ? true : undefined;
	});
}

it("revises, compares and restores plan versions through the CLI", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-e2e-versions-"));
	const server = await startServer(dataDir, "clean");
	try {
		const started = await cli(dataDir, server.url, ["start", "ABC-123"]);
		expect(started.code).toBe(0);
		const runId = started.stdout.trim();
		await waitForApproval(dataDir, server.url, runId);
		const updated = await cli(dataDir, server.url, [
			"plan-update",
			runId,
			"Make it clearer",
		]);
		expect(updated.code, updated.stderr).toBe(0);
		await waitForApproval(dataDir, server.url, runId, 2);
		const history = await cli(dataDir, server.url, ["plan-versions", runId]);
		expect(history.stdout).toContain("2\tagent");
		expect(
			(await cli(dataDir, server.url, ["plan-show", runId, "2"])).stdout,
		).toContain("Revised plan");
		const diff = await cli(dataDir, server.url, ["plan-diff", runId, "1", "2"]);
		expect(diff.stdout).toContain("Removed from version 1:");
		expect(diff.stdout).toContain("Added in version 2:");
		const restored = await cli(dataDir, server.url, [
			"plan-restore",
			runId,
			"1",
		]);
		expect(restored.code, restored.stderr).toBe(0);
		await waitForApproval(dataDir, server.url, runId, 3);
		expect(
			(await cli(dataDir, server.url, ["plan-versions", runId])).stdout,
		).toContain("3\trestore");
	} finally {
		await server.stop();
	}
}, 30_000);

it("uses TOML data_dir for the dynamic-port server token and fake run", async () => {
	const root = await mkdtemp(join(tmpdir(), "payo-e2e-toml-dynamic-"));
	const dataDir = join(root, "state");
	const configFile = join(root, "config.toml");
	await writeFile(
		configFile,
		`[paths]\ndata_dir = ${JSON.stringify(dataDir)}\n`,
	);
	const server = await startServer("", "clean", payoRoot, {
		configFile,
		testPort: "0",
		tomlDataDir: true,
	});
	const configEnv = { PAYO_CONFIG_FILE: configFile };
	try {
		const token = await readFile(join(dataDir, "server-token"), "utf8");
		const printed = await cli(null, server.url, ["token"], configEnv);
		expect(printed.code).toBe(0);
		expect(printed.stdout).toBe(`${token.trim()}\n`);

		const started = await cli(
			null,
			server.url,
			["start", "ABC-123"],
			configEnv,
		);
		expect(started.code).toBe(0);
		const runId = started.stdout.trim();
		const observed = await waitFor(async () => {
			const result = await cli(null, server.url, ["status", runId], configEnv);
			return result.code === 0 && result.stdout.includes("stage: Approval")
				? result.stdout
				: undefined;
		});
		expect(observed).toContain("stage: Approval");
	} finally {
		await server.stop();
	}
}, 30_000);

it("uses the TOML port across server and CLI without test URL or port overrides", async () => {
	const root = await mkdtemp(join(tmpdir(), "payo-e2e-toml-port-"));
	const dataDir = join(root, "state");
	const configFile = join(root, "config.toml");
	const { server, port } = await startConfiguredPortServer(configFile, dataDir);
	try {
		expect(server.url).toBe(`http://127.0.0.1:${port}`);
		const started = await cli(
			null,
			"",
			["start", "ABC-123"],
			{ PAYO_CONFIG_FILE: configFile },
			{ testServerUrl: false },
		);
		expect(started.code, started.stderr).toBe(0);
		const runId = started.stdout.trim();
		const observed = await waitFor(async () => {
			const result = await cli(
				null,
				"",
				["status", runId],
				{ PAYO_CONFIG_FILE: configFile },
				{ testServerUrl: false },
			);
			return result.code === 0 && result.stdout.includes("stage: Approval")
				? result.stdout
				: undefined;
		});
		expect(observed).toContain("stage: Approval");
	} finally {
		await server.stop();
	}
}, 30_000);

it("runs the clean fake flow through the CLI, edits, request-changes, answers and approves", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-e2e-"));
	const server = await startServer(dataDir, "clean-twice");
	try {
		const started = await cli(dataDir, server.url, [
			"start",
			"ABC-123",
			"--base",
			"main",
		]);
		expect(started.code).toBe(0);
		const runId = started.stdout.trim();
		expect(runId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		await waitForApproval(dataDir, server.url, runId);
		const first = await status(dataDir, server.url, runId);
		expect(first).toContain(`repo: ${payoRoot}`);
		expect(first).toContain("base: main");
		expect(first).toContain("stage: Approval");
		expect(first).toContain("[approval]");

		expect(await logs(dataDir, server.url, runId)).toContain(
			'"type":"run.created"',
		);

		const editorPath = await editor(dataDir);
		const edited = await cli(dataDir, server.url, ["edit", runId], {
			EDITOR: `${process.execPath} ${editorPath}`,
		});
		expect(edited.code).toBe(0);
		const planPath = join(dataDir, "runs", runId, "plan.md");
		expect(await readFile(planPath, "utf8")).toContain("Human edit from e2e.");

		const changed = await cli(dataDir, server.url, ["request-changes", runId]);
		expect(changed.code).toBe(0);
		expect(changed.stdout.trim()).toBe(runId);
		await waitForApproval(dataDir, server.url, runId, 2);
		expect(await readFile(planPath, "utf8")).toContain("Human edit from e2e.");

		const answered = await cli(dataDir, server.url, [
			"answer",
			runId,
			"q1",
			"Because",
			"it",
			"is",
			"safer",
		]);
		expect(answered.code).toBe(0);
		expect(answered.stdout).toContain(`Run ${runId}`);

		const approved = await cli(dataDir, server.url, ["approve", runId]);
		expect(approved.code).toBe(0);
		const final = await status(dataDir, server.url, runId);
		expect(final).toContain("status: ended (approved)");
		expect(final).toContain("open gates: none");
		const plan = await readFile(planPath, "utf8");
		expect(plan).toContain("Human edit from e2e.");
		expect(plan).toContain("Because it is safer");
	} finally {
		await server.stop();
	}
}, 30_000);

it("executes two phases through the CLI and resumes a later phase after restart", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-e2e-execution-"));
	const configFile = join(dataDir, "payo.toml");
	await writeFile(
		configFile,
		'[execution]\nchecks = [{ name = "unit", command = "true", args = [], timeout_ms = 1000 }]\n',
	);
	const first = await startServer(dataDir, "execution-interruption", payoRoot, {
		configFile,
	});
	const started = await cli(dataDir, first.url, ["start", "ABC-123"]);
	expect(started.code, started.stderr).toBe(0);
	const sourceRunId = started.stdout.trim();
	await waitForApproval(dataDir, first.url, sourceRunId);
	const answer = await cli(dataDir, first.url, [
		"answer",
		sourceRunId,
		"q1",
		"Because the phases can be validated independently.",
	]);
	expect(answer.code, answer.stderr).toBe(0);
	const approved = await cli(dataDir, first.url, ["approve", sourceRunId]);
	expect(approved.code, approved.stderr).toBe(0);
	const accepted = await cli(dataDir, first.url, [
		"implement",
		sourceRunId,
		"--pr",
		"pr-1",
	]);
	expect(accepted.code, accepted.stderr).toBe(0);
	const executionRunId = accepted.stdout.trim();
	await waitFor(async () => {
		const events = await logs(dataDir, first.url, executionRunId);
		return events.includes("implement phase-2") ? true : undefined;
	});
	const stopped = await first.stop("SIGTERM");
	expect(stopped.code).toBe(0);

	const second = await startServer(
		dataDir,
		"execution-interruption",
		payoRoot,
		{ configFile },
	);
	try {
		const gated = await waitFor(async () => {
			const text = await status(dataDir, second.url, executionRunId);
			return text.includes("stage: Escalated") ? text : undefined;
		});
		expect(gated).toContain("open gates:");
		expect(
			(await cli(dataDir, second.url, ["resume", executionRunId])).code,
		).toBe(0);
		const completed = await waitFor(async () => {
			const text = await status(dataDir, second.url, executionRunId);
			return text.includes("status: ended (reviewed)") ? text : undefined;
		}, 30_000);
		expect(completed).toContain("completed phases: 2/2");
		expect(completed).toMatch(/result commit: fake-result-commit-2/);
		expect(await status(dataDir, second.url, sourceRunId)).toContain(
			"status: ended (approved)",
		);
		const events = await logs(dataDir, second.url, executionRunId);
		expect(events).toContain('"type":"run.ended","outcome":"reviewed"');
		expect(events).toContain(
			'"note":"operator resumed execution with retained workspace"',
		);
	} finally {
		await second.stop();
	}
}, 60_000);

it("survives a crash during a hung attempt, gates before retry, and resumes explicitly", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-e2e-crash-"));
	const first = await startServer(dataDir, "hang-planner");
	const started = await cli(dataDir, first.url, ["start", "ABC-123"]);
	expect(started.code).toBe(0);
	const runId = started.stdout.trim();
	await waitFor(async () => {
		const text = await logs(dataDir, first.url, runId);
		return text.includes('"type":"attempt.started"') ? true : undefined;
	});

	await first.stop("SIGKILL");
	expect(first.stderr).toBe("");

	const second = await startServer(dataDir, "clean");
	try {
		const recovered = await waitFor(async () => {
			const text = await cli(dataDir, second.url, ["status", runId]);
			return text.code === 0 && text.stdout.includes("stage: Escalated")
				? text.stdout
				: undefined;
		});
		expect(recovered).toContain("[interrupted-attempt]");
		expect(recovered).toContain("[factory-escalation]");

		const resumed = await cli(dataDir, second.url, ["resume", runId]);
		expect(resumed.code).toBe(0);
		expect(resumed.stdout.trim()).toBe(runId);
		await waitForApproval(dataDir, second.url, runId);

		const answered = await cli(dataDir, second.url, [
			"answer",
			runId,
			"q1",
			"Because",
		]);
		expect(answered.code).toBe(0);
		expect((await cli(dataDir, second.url, ["approve", runId])).code).toBe(0);
		expect(await status(dataDir, second.url, runId)).toContain(
			"status: ended (approved)",
		);

		const events = await logs(dataDir, second.url, runId);
		expect(events).toContain('"outcome":"interrupted"');
		expect(events).toContain('"type":"attempt.started"');
		expect(events).toContain('"outcome":"approved"');
		expect(events).toContain('"command":"resume"');
	} finally {
		await second.stop();
	}
}, 40_000);

it("settles active work before closing the store on graceful shutdown", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "payo-e2e-term-"));
	const first = await startServer(dataDir, "hang-planner");
	const started = await cli(dataDir, first.url, ["start", "ABC-123"]);
	expect(started.code).toBe(0);
	const runId = started.stdout.trim();
	await waitFor(async () => {
		const text = await logs(dataDir, first.url, runId);
		return text.includes('"type":"attempt.started"') ? true : undefined;
	});

	const stopped = await first.stop("SIGTERM");
	expect(stopped.code).toBe(0);
	expect(stopped.stderr).toBe("");

	const second = await startServer(dataDir, "clean");
	try {
		const recovered = await waitFor(async () => {
			const result = await cli(dataDir, second.url, ["status", runId]);
			return result.code === 0 && result.stdout.includes("stage: Escalated")
				? result.stdout
				: undefined;
		});
		expect(recovered).toContain("[factory-escalation]");
		const events = await logs(dataDir, second.url, runId);
		expect(events).toContain('"outcome":"cancelled"');
		expect(events).toContain('"type":"step.finished"');
	} finally {
		await second.stop();
	}
}, 40_000);

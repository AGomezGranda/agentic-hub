import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	activeEnvironmentOverrides,
	ConfigRevisionConflictError,
	loadPayoConfig as loadSharedConfig,
	MISSING_CONFIG_REVISION,
	PayoConfigPathError,
	readPayoConfigDocument,
	resolveConfigPath,
	resolvePayoConfigDocument,
	resolveDataDir as resolveSharedDataDir,
	writePayoConfigDocument,
} from "./index.ts";

const tempDirs: string[] = [];
const cwd = "/work/payo";

function loadPayoConfig(
	env: NodeJS.ProcessEnv = {},
	workingDirectory: string = cwd,
) {
	return loadSharedConfig(
		{ HOME: env.HOME ?? tempHome(), ...env },
		workingDirectory,
	);
}

function resolveDataDir(
	env: NodeJS.ProcessEnv = {},
	workingDirectory: string = cwd,
): string {
	return resolveSharedDataDir(
		{ HOME: env.HOME ?? tempHome(), ...env },
		workingDirectory,
	);
}

function tempHome(): string {
	const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "payo-config-"));
	tempDirs.push(home);
	return home;
}

function configFile(contents: string, home = tempHome()): string {
	const path = join(home, "selected.toml");
	writeFileSync(path, contents);
	return path;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

it("uses defaults when the per-user config file is absent", () => {
	const home = tempHome();
	const config = loadPayoConfig({ HOME: home }, cwd);
	expect(config).toMatchObject({
		configFile: join(home, ".config/payo/config.toml"),
		dataDir: join(home, ".payo"),
		repo: cwd,
		baseBranch: "main",
		maxConcurrentAgents: 4,
		port: 7331,
		webOrigins: [],
		tools: { pi: "pi", acli: "acli", git: "git" },
		piProvider: "anthropic",
		model: null,
		checks: [],
		roles: {
			planner: { model: null, timeoutMs: 300000 },
			reviewer: { model: null, timeoutMs: 300000 },
			verifier: { model: null, timeoutMs: 300000 },
			reviser: { model: null, timeoutMs: 300000 },
		},
	});
	expect(config.roles.implementer).toBeUndefined();
	expect(resolveConfigPath({ HOME: home })).toBe(
		join(home, ".config/payo/config.toml"),
	);
	expect(resolveDataDir({ HOME: home }, cwd)).toBe(join(home, ".payo"));
});

it("parses a complete TOML config with strict sections and typed values", () => {
	const home = tempHome();
	const path = configFile(
		`
[server]
port = 7444
web_origins = ["http://localhost:5173"]

[paths]
data_dir = "/var/tmp/payo"
repo = "/work/project"
base_branch = "develop"

[execution]
max_concurrent_agents = 3
checks = [{ name = "unit", command = "pnpm", args = ["test"], timeout_ms = 120000 }]

[tools]
pi = "/opt/pi"
acli = "acli-custom"
git = "git-custom"

[model]
provider = "openai"
id = "gpt-5"

[roles.implementer]
timeout_ms = 90000
`,
		home,
	);
	const config = loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd);
	expect(config).toMatchObject({
		configFile: path,
		port: 7444,
		webOrigins: ["http://localhost:5173"],
		dataDir: "/var/tmp/payo",
		repo: "/work/project",
		baseBranch: "develop",
		maxConcurrentAgents: 3,
		checks: [
			{ name: "unit", command: "pnpm", args: ["test"], timeout_ms: 120000 },
		],
		tools: { pi: "/opt/pi", acli: "acli-custom", git: "git-custom" },
		piProvider: "openai",
		model: { provider: "openai", id: "gpt-5" },
	});
	expect(config.roles.implementer).toEqual({
		model: { provider: "openai", id: "gpt-5" },
		timeoutMs: 90000,
	});
});

it("uses only an absolute explicit config path and errors if it is missing", () => {
	const home = tempHome();
	const selected = join(home, "chosen.toml");
	expect(resolveConfigPath({ HOME: home, PAYO_CONFIG_FILE: selected })).toBe(
		selected,
	);
	expect(() =>
		loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: selected }, cwd),
	).toThrow(
		new RegExp(`${selected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*not found`),
	);
	expect(() =>
		resolveConfigPath({ HOME: home, PAYO_CONFIG_FILE: "relative.toml" }),
	).toThrow(/PAYO_CONFIG_FILE.*absolute/);
});

it("does not require the default config file to exist", () => {
	const home = tempHome();
	mkdirSync(join(home, ".config/payo"), { recursive: true });
	expect(loadPayoConfig({ HOME: home }, cwd).configFile).toBe(
		join(home, ".config/payo/config.toml"),
	);
});

it.each([
	["malformed TOML", "[server\nport = 7331"],
	["duplicate keys", "[server]\nport = 7331\nport = 7332"],
	["unsafe keys", "__proto__.polluted = true"],
])("reports %s with the selected path", (_name, contents) => {
	const home = tempHome();
	const path = configFile(contents, home);
	expect(() =>
		loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
	).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

it("rejects unknown settings with a path-qualified error", () => {
	const home = tempHome();
	const path = configFile(
		"[server]\nport = 7331\nlisten_address = '0.0.0.0'",
		home,
	);
	expect(() =>
		loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
	).toThrow(
		new RegExp(
			`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*server\\.listen_address`,
		),
	);
});

it("resolves defaults, TOML, then environment overrides", () => {
	const home = tempHome();
	const path = configFile(
		`
[server]
port = 7444
web_origins = ["http://localhost:5173"]
[paths]
data_dir = "/from-file"
repo = "/repo-from-file"
base_branch = "release"
[execution]
max_concurrent_agents = 2
[tools]
pi = "pi-file"
[model]
provider = "openai"
id = "gpt-file"
`,
		home,
	);
	const config = loadPayoConfig(
		{
			HOME: home,
			PAYO_CONFIG_FILE: path,
			PAYO_PORT: "7555",
			PAYO_DATA_DIR: "/from-env",
			PAYO_REPO: "/repo-from-env",
			PAYO_BASE_BRANCH: "hotfix",
			PAYO_MAX_CONCURRENT_AGENTS: "5",
			PAYO_WEB_ORIGINS: "https://127.0.0.1:3000, http://[::1]:4200",
			PAYO_PI_BIN: "pi-env",
			PAYO_PI_PROVIDER: "custom-provider",
			PAYO_MODEL: "custom-model",
		},
		cwd,
	);
	expect(config).toMatchObject({
		port: 7555,
		dataDir: "/from-env",
		repo: "/repo-from-env",
		baseBranch: "hotfix",
		maxConcurrentAgents: 5,
		webOrigins: ["https://127.0.0.1:3000", "http://[::1]:4200"],
		tools: { pi: "pi-env", acli: "acli", git: "git" },
		piProvider: "custom-provider",
		model: { provider: "custom-provider", id: "custom-model" },
	});
});

it("treats blank optional environment values as unset and rejects blank executables", () => {
	const config = loadPayoConfig(
		{
			HOME: tempHome(),
			PAYO_DATA_DIR: " ",
			PAYO_REPO: " ",
			PAYO_BASE_BRANCH: " ",
			PAYO_PORT: " ",
			PAYO_WEB_ORIGINS: " ",
			PAYO_MODEL: " ",
		},
		cwd,
	);
	expect(config).toMatchObject({
		repo: cwd,
		baseBranch: "main",
		port: 7331,
		model: null,
	});
	expect(() =>
		loadPayoConfig({ HOME: tempHome(), PAYO_PI_BIN: " " }, cwd),
	).toThrow(/PAYO_PI_BIN must not be blank/);
});

it("requires configured paths to be absolute", () => {
	const home = tempHome();
	const path = configFile('[paths]\ndata_dir = "relative"', home);
	expect(() =>
		loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
	).toThrow(/config.*paths\.data_dir.*absolute/);
	for (const env of [{ PAYO_DATA_DIR: "relative" }, { PAYO_REPO: "relative" }])
		expect(() => loadPayoConfig({ HOME: home, ...env }, cwd)).toThrow(
			/absolute/,
		);
});

it("validates port and concurrency ranges", () => {
	for (const port of [0, -1, 65536]) {
		const home = tempHome();
		const path = configFile(`[server]\nport = ${port}`, home);
		expect(() =>
			loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
		).toThrow();
	}
	for (const value of ["0", "-1", "1.5", "many"])
		expect(() =>
			loadPayoConfig({ PAYO_MAX_CONCURRENT_AGENTS: value }, cwd),
		).toThrow(/PAYO_MAX_CONCURRENT_AGENTS.*positive integer/);
	for (const value of ["0", "65536", "1.5", "many"])
		expect(() => loadPayoConfig({ PAYO_PORT: value }, cwd)).toThrow(
			/PAYO_PORT/,
		);
});

it("accepts only exact loopback web origins", () => {
	for (const origin of [
		"*",
		"http://127.0.0.1:5173/",
		"http://127.0.0.1:5173/path",
		"http://example.com",
		"https://127.0.0.1:5173?x=1",
	])
		expect(() => loadPayoConfig({ PAYO_WEB_ORIGINS: origin }, cwd)).toThrow(
			/origin|loopback/,
		);
	expect(
		loadPayoConfig({ PAYO_WEB_ORIGINS: "http://[::1]:3000" }, cwd).webOrigins,
	).toEqual(["http://[::1]:3000"]);
});

it("inherits the global model and resolves independent role overrides and timeouts", () => {
	const home = tempHome();
	const path = configFile(
		`[model]
provider = "anthropic"
id = "claude-default"
[roles.planner]
timeout_ms = 60000
model = { provider = "openai", id = "o3" }
[roles.reviewer]
model = { provider = "google", id = "gemini-pro" }`,
		home,
	);
	const config = loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd);
	expect(config.roles).toEqual({
		planner: { model: { provider: "openai", id: "o3" }, timeoutMs: 60000 },
		reviewer: {
			model: { provider: "google", id: "gemini-pro" },
			timeoutMs: 300000,
		},
		verifier: {
			model: { provider: "anthropic", id: "claude-default" },
			timeoutMs: 300000,
		},
		reviser: {
			model: { provider: "anthropic", id: "claude-default" },
			timeoutMs: 300000,
		},
	});
});

it("rejects invalid role timeout ranges and incomplete model pairs", () => {
	for (const contents of [
		"[roles.planner]\ntimeout_ms = 2147483648",
		"[roles.planner]\ntimeout_ms = 0",
		'[roles.planner.model]\nprovider = "openai"',
	]) {
		const home = tempHome();
		const path = configFile(contents, home);
		expect(() =>
			loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
		).toThrow(/config.*roles\.planner/);
	}
});

it("lets legacy provider and model variables override every role", () => {
	const home = tempHome();
	const path = configFile(
		`[model]
provider = "anthropic"
id = "claude-default"
[roles.planner]
model = { provider = "openai", id = "o3" }
[roles.reviewer]
model = { provider = "google", id = "gemini-pro" }`,
		home,
	);
	const config = loadPayoConfig(
		{
			HOME: home,
			PAYO_CONFIG_FILE: path,
			PAYO_PI_PROVIDER: "legacy-provider",
			PAYO_MODEL: "legacy-model",
		},
		cwd,
	);
	for (const role of ["planner", "reviewer", "verifier", "reviser"] as const)
		expect(config.roles[role].model).toEqual({
			provider: "legacy-provider",
			id: "legacy-model",
		});
});

it("rejects slash-containing provider and model values", () => {
	const home = tempHome();
	const path = configFile(
		'[model]\nprovider = "openai/custom"\nid = "gpt-5"',
		home,
	);
	expect(() =>
		loadPayoConfig({ HOME: home, PAYO_CONFIG_FILE: path }, cwd),
	).toThrow(/model\.provider/);
	expect(() => loadPayoConfig({ PAYO_MODEL: "provider/model" }, cwd)).toThrow(
		/PAYO_MODEL.*provider/,
	);
});

const completeDocument = {
	server: {
		port: 7444,
		web_origins: ["http://localhost:5173"],
	},
	paths: {
		data_dir: "/var/tmp/payo",
		repo: "/work/project",
		base_branch: "develop",
	},
	execution: { max_concurrent_agents: 3 },
	tools: { pi: "/opt/pi", acli: "acli-custom", git: "git-custom" },
	model: { provider: "openai", id: "gpt-5" },
	roles: {
		planner: {
			timeout_ms: 60_000,
			model: { provider: "anthropic", id: "claude" },
		},
		reviewer: { model: { provider: "google", id: "gemini-pro" } },
		verifier: {},
		reviser: { timeout_ms: 1 },
	},
};

it("reads a missing file as an empty document with a distinct revision", () => {
	const path = join(tempHome(), "missing.toml");
	expect(readPayoConfigDocument(path)).toEqual({
		configFile: path,
		revision: MISSING_CONFIG_REVISION,
		document: {},
	});
});

it("reads a complete explicit file and its byte revision", () => {
	const home = tempHome();
	const path = configFile(
		`[server]
port = 7444
web_origins = ["http://localhost:5173"]

[paths]
data_dir = "/var/tmp/payo"
repo = "/work/project"
base_branch = "develop"

[execution]
max_concurrent_agents = 3

[tools]
pi = "/opt/pi"
acli = "acli-custom"
git = "git-custom"

[model]
provider = "openai"
id = "gpt-5"

[roles.planner]
timeout_ms = 60000
model = { provider = "anthropic", id = "claude" }

[roles.reviewer]
model = { provider = "google", id = "gemini-pro" }

[roles.verifier]

[roles.reviser]
timeout_ms = 1
`,
		home,
	);
	const snapshot = readPayoConfigDocument(path);
	expect(snapshot.document).toMatchObject(completeDocument);
	expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
	expect(snapshot.revision).toBe(readPayoConfigDocument(path).revision);
});

it("round-trips every key through canonical TOML", async () => {
	const path = join(tempHome(), "nested", "deeper", "config.toml");
	const written = await writePayoConfigDocument(
		path,
		completeDocument,
		MISSING_CONFIG_REVISION,
	);
	expect(written.document).toEqual(completeDocument);
	expect(written.revision).toMatch(/^[0-9a-f]{64}$/);
	expect(readPayoConfigDocument(path)).toEqual(written);
	const config = loadSharedConfig(
		{ HOME: tempHome(), PAYO_CONFIG_FILE: path },
		cwd,
	);
	expect(config).toMatchObject({
		configFile: path,
		port: 7444,
		dataDir: "/var/tmp/payo",
		repo: "/work/project",
		baseBranch: "develop",
		maxConcurrentAgents: 3,
		webOrigins: ["http://localhost:5173"],
		tools: { pi: "/opt/pi", acli: "acli-custom", git: "git-custom" },
		piProvider: "openai",
		model: { provider: "openai", id: "gpt-5" },
		roles: {
			planner: {
				model: { provider: "anthropic", id: "claude" },
				timeoutMs: 60_000,
			},
			reviewer: {
				model: { provider: "google", id: "gemini-pro" },
				timeoutMs: 300_000,
			},
			verifier: {
				model: { provider: "openai", id: "gpt-5" },
				timeoutMs: 300_000,
			},
			reviser: { model: { provider: "openai", id: "gpt-5" }, timeoutMs: 1 },
		},
	});
});

it("creates owner-only files and directories without changing existing modes", async () => {
	const root = tempHome();
	const existing = join(root, "existing");
	mkdirSync(existing, { mode: 0o755 });
	const path = join(existing, "config.toml");
	await writePayoConfigDocument(
		path,
		{ server: { port: 7331 } },
		MISSING_CONFIG_REVISION,
	);
	if (process.platform !== "win32") {
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(existing).mode & 0o777).toBe(0o755);
	}
	const created = join(root, "new", "nested", "config.toml");
	await writePayoConfigDocument(created, {}, MISSING_CONFIG_REVISION);
	if (process.platform !== "win32") {
		expect(statSync(created).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(created)).mode & 0o777).toBe(0o700);
		expect(statSync(dirname(dirname(created))).mode & 0o777).toBe(0o700);
	}
});

it("rejects invalid candidates without changing existing bytes", async () => {
	const home = tempHome();
	const path = configFile("[server]\nport = 7331\n", home);
	const before = readFileSync(path);
	const revision = readPayoConfigDocument(path).revision;
	await expect(
		writePayoConfigDocument(
			path,
			{ paths: { data_dir: "relative" } },
			revision,
		),
	).rejects.toThrow(/absolute/);
	expect(readFileSync(path)).toEqual(before);
	if (process.platform !== "win32") {
		await expect(
			writePayoConfigDocument(
				path,
				{ paths: { data_dir: "C:\\tmp\\payo" } },
				revision,
			),
		).rejects.toBeInstanceOf(PayoConfigPathError);
		expect(() =>
			resolvePayoConfigDocument({ paths: { repo: "C:\\repo" } }, {}, cwd),
		).toThrow(PayoConfigPathError);
	}
	expect(readFileSync(path)).toEqual(before);
});

it("refuses to save through a symlink", async () => {
	const dir = tempHome();
	const target = join(dir, "target.toml");
	writeFileSync(target, "[server]\nport = 7331\n");
	const link = join(dir, "link.toml");
	symlinkSync(target, link);
	const revision = readPayoConfigDocument(link).revision;
	await expect(
		writePayoConfigDocument(link, { server: { port: 7444 } }, revision),
	).rejects.toThrow(/symbolic link/);
	expect(readFileSync(target, "utf8")).toContain("7331");
});

it("rejects a stale revision and preserves an external edit", async () => {
	const home = tempHome();
	const path = configFile("[server]\nport = 7331\n", home);
	const revision = readPayoConfigDocument(path).revision;
	await writePayoConfigDocument(path, { server: { port: 7444 } }, revision);
	await expect(
		writePayoConfigDocument(path, { server: { port: 7555 } }, revision),
	).rejects.toBeInstanceOf(ConfigRevisionConflictError);
	expect(readPayoConfigDocument(path).document.server?.port).toBe(7444);

	const externalRevision = readPayoConfigDocument(path).revision;
	writeFileSync(path, "[server]\nport = 7999\n");
	await expect(
		writePayoConfigDocument(path, { server: { port: 7444 } }, externalRevision),
	).rejects.toBeInstanceOf(ConfigRevisionConflictError);
	expect(readFileSync(path, "utf8")).toContain("7999");
});

it("serializes concurrent writes so one revision cannot win twice", async () => {
	const path = join(tempHome(), "config.toml");
	await writePayoConfigDocument(path, {}, MISSING_CONFIG_REVISION);
	const revision = readPayoConfigDocument(path).revision;
	const results = await Promise.allSettled([
		writePayoConfigDocument(path, { server: { port: 7444 } }, revision),
		writePayoConfigDocument(path, { server: { port: 7555 } }, revision),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected");
	expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
		ConfigRevisionConflictError,
	);
	const saved = readPayoConfigDocument(path).document.server?.port;
	expect([7444, 7555]).toContain(saved);
});

it("leaves the original bytes and removes the temporary file on failure", async () => {
	const home = tempHome();
	const path = configFile("[server]\nport = 7331\n", home);
	const before = readFileSync(path);
	const revision = readPayoConfigDocument(path).revision;
	await expect(
		writePayoConfigDocument(path, { server: { port: 7444 } }, revision, {
			rename() {
				throw new Error("injected rename failure");
			},
		}),
	).rejects.toThrow("injected rename failure");
	expect(readFileSync(path)).toEqual(before);
	expect(
		readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")),
	).toEqual([]);

	await expect(
		writePayoConfigDocument(path, { server: { port: 7444 } }, revision, {
			writeFile(target, data, options) {
				writeFileSync(target, data.slice(0, 4), options);
				throw new Error("injected write failure");
			},
		}),
	).rejects.toThrow("injected write failure");
	expect(readFileSync(path)).toEqual(before);
	expect(
		readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")),
	).toEqual([]);
});

it("keeps environment overrides authoritative after writing", async () => {
	const path = join(tempHome(), "config.toml");
	await writePayoConfigDocument(
		path,
		{ server: { port: 7444 }, paths: { data_dir: "/file-dir" } },
		MISSING_CONFIG_REVISION,
	);
	const env = {
		HOME: tempHome(),
		PAYO_CONFIG_FILE: path,
		PAYO_PORT: "7555",
		PAYO_DATA_DIR: "/env-dir",
		PAYO_WEB_ORIGINS: " ",
	};
	const config = loadSharedConfig(env, cwd);
	expect(config.port).toBe(7555);
	expect(config.dataDir).toBe("/env-dir");
	expect(activeEnvironmentOverrides(env)).toEqual([
		"PAYO_PORT",
		"PAYO_DATA_DIR",
	]);
	expect(
		activeEnvironmentOverrides({ PAYO_MODEL: "m", PAYO_PI_PROVIDER: "p" }),
	).toEqual(["PAYO_PI_PROVIDER", "PAYO_MODEL"]);
});

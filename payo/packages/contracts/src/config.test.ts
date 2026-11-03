import { describe, expect, it } from "vitest";
import {
	ConfigSettingsSnapshot,
	PayoConfigDocument,
	SaveConfigSettingsRequest,
} from "./config.ts";
import { ExecutionRunConfig } from "./execution.ts";

const full = {
	server: {
		port: 7444,
		web_origins: ["http://localhost:5173", "https://127.0.0.1:3000"],
	},
	paths: {
		data_dir: "/var/tmp/payo",
		repo: "/work/project",
		base_branch: "develop",
	},
	execution: {
		max_concurrent_agents: 3,
		checks: [
			{
				name: "unit",
				command: "pnpm",
				args: ["test"],
				timeout_ms: 120000,
			},
		],
	},
	tools: { pi: "/opt/pi", acli: "acli-custom", git: "git-custom" },
	model: { provider: "openai", id: "gpt-5" },
	roles: {
		planner: { timeout_ms: 60_000, model: { provider: "openai", id: "o3" } },
		reviewer: { model: { provider: "google", id: "gemini-pro" } },
		verifier: {},
		reviser: { timeout_ms: 1 },
		implementer: { timeout_ms: 90_000 },
	},
};

describe("PayoConfigDocument", () => {
	it("accepts a full document with every section and role", () => {
		expect(PayoConfigDocument.parse(full)).toEqual(full);
	});

	it("accepts absent sections and optional keys", () => {
		expect(PayoConfigDocument.parse({})).toEqual({});
		expect(
			PayoConfigDocument.parse({
				server: {},
				paths: { repo: "/repo" },
				execution: {},
				tools: { pi: "pi" },
				roles: { planner: {} },
			}),
		).toEqual({
			server: {},
			paths: { repo: "/repo" },
			execution: {},
			tools: { pi: "pi" },
			roles: { planner: {} },
		});
	});

	it("accepts Windows absolute paths without Node built-ins", () => {
		expect(
			PayoConfigDocument.parse({
				paths: { data_dir: "C:\\Users\\me\\.payo", repo: "\\\\share\\repo" },
			}),
		).toEqual({
			paths: { data_dir: "C:\\Users\\me\\.payo", repo: "\\\\share\\repo" },
		});
	});

	it.each([
		["unknown top-level field", { extra: true }],
		["unknown server field", { server: { listen_address: "0.0.0.0" } }],
		["unknown role field", { roles: { planner: { retries: 2 } } }],
		["port zero", { server: { port: 0 } }],
		["port too high", { server: { port: 65_536 } }],
		["fractional port", { server: { port: 7331.5 } }],
		["string port", { server: { port: "7331" } }],
		["zero concurrency", { execution: { max_concurrent_agents: 0 } }],
		["negative concurrency", { execution: { max_concurrent_agents: -1 } }],
		["fractional concurrency", { execution: { max_concurrent_agents: 1.5 } }],
		["empty checks", { execution: { checks: [] } }],
		[
			"duplicate check names",
			{
				execution: {
					checks: [
						{ name: "test", command: "pnpm", args: [], timeout_ms: 1 },
						{ name: "test", command: "pnpm", args: [], timeout_ms: 1 },
					],
				},
			},
		],
		[
			"blank check command",
			{
				execution: {
					checks: [{ name: "test", command: " ", args: [], timeout_ms: 1 }],
				},
			},
		],
		[
			"zero check timeout",
			{
				execution: {
					checks: [{ name: "test", command: "pnpm", args: [], timeout_ms: 0 }],
				},
			},
		],
		[
			"unknown check field",
			{
				execution: {
					checks: [
						{
							name: "test",
							command: "pnpm",
							args: [],
							timeout_ms: 1,
							shell: true,
						},
					],
				},
			},
		],
		["zero timeout", { roles: { planner: { timeout_ms: 0 } } }],
		["timeout too high", { roles: { planner: { timeout_ms: 2_147_483_648 } } }],
		["relative data dir", { paths: { data_dir: "relative" } }],
		["relative repo", { paths: { repo: "../repo" } }],
		["wildcard origin", { server: { web_origins: ["*"] } }],
		[
			"origin with trailing slash",
			{ server: { web_origins: ["http://127.0.0.1:5173/"] } },
		],
		[
			"origin with path",
			{ server: { web_origins: ["http://127.0.0.1:5173/path"] } },
		],
		["remote origin", { server: { web_origins: ["http://example.com"] } }],
		["blank executable", { tools: { pi: "  " } }],
		["incomplete global model", { model: { provider: "openai" } }],
		["incomplete role model", { roles: { planner: { model: { id: "o3" } } } }],
		["slash in model provider", { model: { provider: "openai/x", id: "y" } }],
	])("rejects %s", (_name, input) => {
		expect(PayoConfigDocument.safeParse(input).success).toBe(false);
	});
});

it("requires an execution suite while planning config keeps it optional", () => {
	expect(PayoConfigDocument.safeParse({}).success).toBe(true);
	const config = {
		kind: "factory-execution",
		sourceRunId: "source",
		sourceBaseBranch: "main",
		plan: {
			sha256: "a".repeat(64),
			size: 1,
			kind: "factory-plan-version-v1",
			mediaType: "application/json",
		},
		prId: "pr",
		baseCommit: "commit",
		roles: {},
		roleArtifacts: {},
		roleProvenance: {},
		maxConcurrentAgents: 1,
	};
	expect(ExecutionRunConfig.safeParse(config).success).toBe(false);
	expect(
		ExecutionRunConfig.safeParse({
			...config,
			checks: [
				{ name: "test", command: "pnpm", args: ["test"], timeout_ms: 1000 },
			],
		}).success,
	).toBe(true);
});

describe("settings envelopes", () => {
	it("accepts a snapshot and a save request", () => {
		expect(
			ConfigSettingsSnapshot.parse({
				configFile: "/home/me/.config/payo/config.toml",
				revision: "missing",
				document: full,
				environmentOverrides: ["PAYO_PORT"],
			}),
		).toMatchObject({ revision: "missing", document: full });
		expect(
			SaveConfigSettingsRequest.parse({ revision: "abc", document: full }),
		).toEqual({ revision: "abc", document: full });
	});

	it.each([
		[
			"snapshot unknown key",
			ConfigSettingsSnapshot,
			{
				configFile: "/tmp/config.toml",
				revision: "missing",
				document: {},
				environmentOverrides: [],
				extra: true,
			},
		],
		[
			"save unknown key",
			SaveConfigSettingsRequest,
			{ revision: "abc", document: {}, extra: true },
		],
		["save missing revision", SaveConfigSettingsRequest, { document: {} }],
	])("rejects %s", (_name, schema, input) => {
		expect(schema.safeParse(input).success).toBe(false);
	});
});

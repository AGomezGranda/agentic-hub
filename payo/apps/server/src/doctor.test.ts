import { resolvePayoConfigDocument } from "@payo/config";
import type { DoctorCheck } from "@payo/contracts";
import { expect, it } from "vitest";
import type { ServerConfig } from "./config.ts";
import {
	type DoctorProbes,
	runDoctor,
	startupBlockingFailures,
} from "./doctor.ts";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		ghBin: "gh",
		publication: resolvePayoConfigDocument({}, {}, "/repo").publication,
		configFile: "/data/config.toml",
		dataDir: "/data",
		repo: "/repo",
		baseBranch: "main",
		maxConcurrentAgents: 4,
		webOrigins: [],
		checks: [],
		devFakes: false,
		scenario: null,
		port: 0,
		testMode: true,
		piBin: "pi-bin",
		acliBin: "acli-bin",
		gitBin: "git-bin",
		piProvider: "openai",
		model: "test-model",
		roles: {
			planner: {
				model: { provider: "openai", id: "planner" },
				timeoutMs: 300_000,
			},
			reviewer: {
				model: { provider: "openai", id: "reviewer" },
				timeoutMs: 300_000,
			},
			verifier: {
				model: { provider: "openai", id: "verifier" },
				timeoutMs: 300_000,
			},
			reviser: {
				model: { provider: "openai", id: "reviser" },
				timeoutMs: 300_000,
			},
		},
		...overrides,
	};
}

function ok(name: string): DoctorCheck {
	return { name, ok: true, detail: "ready" };
}

function probes(seen: Record<string, unknown> = {}): Partial<DoctorProbes> {
	return {
		pi: async (options) => {
			seen.pi = options;
			return ok("pi");
		},
		acli: async (options) => {
			seen.acli = options;
			return ok("acli");
		},
		git: async (options) => {
			seen.git = options;
			return ok("git");
		},
		roleSources: async (repo, base, exec) => {
			seen.skills = { repo, base, exec };
			return ok("skills");
		},
	};
}

it("reports ok when every probe passes, in a stable order", async () => {
	const report = await runDoctor(config(), probes());
	expect(report.ok).toBe(true);
	expect(report.checks.map((check) => check.name)).toEqual([
		"pi",
		"acli",
		"git",
		"skills",
	]);
});

it("is not ok when a single check fails", async () => {
	const report = await runDoctor(config(), {
		...probes(),
		acli: async () => ({ name: "acli", ok: false, detail: "not logged in" }),
	});
	expect(report.ok).toBe(false);
	expect(report.checks.find((check) => check.name === "acli")).toMatchObject({
		ok: false,
		detail: "not logged in",
	});
});

it("ignores only failed acli checks for startup readiness", async () => {
	const jiraUnavailable = await runDoctor(config(), {
		...probes(),
		acli: async () => ({ name: "acli", ok: false, detail: "missing" }),
	});
	expect(jiraUnavailable.ok).toBe(false);
	expect(startupBlockingFailures(jiraUnavailable)).toEqual([]);

	for (const name of ["pi", "git", "skills"]) {
		const report = await runDoctor(config(), {
			...probes(),
			[name === "skills" ? "roleSources" : name]: async () => ({
				name,
				ok: false,
				detail: "unavailable",
			}),
		});
		expect(startupBlockingFailures(report)).toEqual([
			{
				name,
				ok: false,
				detail: name === "pi" ? "openai: unavailable" : "unavailable",
			},
		]);
	}

	const everyFailure = await runDoctor(config(), {
		pi: async () => ({ name: "pi", ok: false, detail: "pi" }),
		acli: async () => ({ name: "acli", ok: false, detail: "acli" }),
		git: async () => ({ name: "git", ok: false, detail: "git" }),
		roleSources: async () => ({ name: "skills", ok: false, detail: "skills" }),
	});
	expect(
		startupBlockingFailures(everyFailure).map((check) => check.name),
	).toEqual(["pi", "git", "skills"]);
	const reported = await runDoctor(config(), probes());
	expect(reported.checks.map((check) => check.name)).toEqual([
		"pi",
		"acli",
		"git",
		"skills",
	]);
});

it("checks each distinct configured provider once and returns one aggregate Pi check", async () => {
	const providers: string[] = [];
	const report = await runDoctor(
		config({
			roles: {
				planner: { model: { provider: "openai", id: "o3" }, timeoutMs: 1 },
				reviewer: {
					model: { provider: "anthropic", id: "claude" },
					timeoutMs: 1,
				},
				verifier: { model: { provider: "openai", id: "o4" }, timeoutMs: 1 },
				reviser: { model: null, timeoutMs: 1 },
			},
		}),
		{
			...probes(),
			pi: async (options) => {
				providers.push(options.provider ?? "");
				return ok("pi");
			},
		},
	);
	expect(providers).toEqual(["openai", "anthropic"]);
	expect(report.checks.filter((check) => check.name === "pi")).toHaveLength(1);
	expect(report.checks[0]).toMatchObject({ name: "pi", ok: true });
});

it("uses the default provider when no role has a selected model", async () => {
	let provider = "";
	await runDoctor(
		config({
			piProvider: "google",
			roles: {
				planner: { model: null, timeoutMs: 1 },
				reviewer: { model: null, timeoutMs: 1 },
				verifier: { model: null, timeoutMs: 1 },
				reviser: { model: null, timeoutMs: 1 },
			},
		}),
		{
			...probes(),
			pi: async (options) => {
				provider = options.provider ?? "";
				return ok("pi");
			},
		},
	);
	expect(provider).toBe("google");
});

it("fails the aggregate Pi check for provider failures and redacts credentials", async () => {
	const providers: string[] = [];
	const report = await runDoctor(
		config({
			roles: {
				planner: { model: { provider: "openai", id: "o3" }, timeoutMs: 1 },
				reviewer: {
					model: { provider: "anthropic", id: "claude" },
					timeoutMs: 1,
				},
				verifier: { model: { provider: "openai", id: "o4" }, timeoutMs: 1 },
				reviser: { model: null, timeoutMs: 1 },
			},
		}),
		{
			...probes(),
			pi: async (options) => {
				const provider = options.provider ?? "";
				providers.push(provider);
				return {
					name: "pi",
					ok: false,
					detail: provider === "openai" ? "Bearer supersecret" : "sk-secret",
				};
			},
		},
	);
	const check = report.checks.find((item) => item.name === "pi");
	expect(providers).toEqual(["openai", "anthropic"]);
	expect(check?.ok).toBe(false);
	expect(check?.detail).toContain("openai");
	expect(check?.detail).toContain("anthropic");
	expect(check?.detail).not.toContain("supersecret");
	expect(check?.detail).not.toContain("sk-secret");
});

it("turns a rejecting probe into a failed check", async () => {
	const report = await runDoctor(config(), {
		...probes(),
		pi: async () => {
			throw new Error("spawn failed");
		},
	});
	expect(report.ok).toBe(false);
	expect(report.checks[0]).toEqual({
		name: "pi",
		ok: false,
		detail: "openai: spawn failed",
	});
});

it("passes config values and one git exec to the probes", async () => {
	const seen: Record<string, unknown> = {};
	await runDoctor(config(), probes(seen));
	expect(seen.pi).toMatchObject({
		bin: "pi-bin",
		provider: "openai",
		model: "test-model",
	});
	expect(seen.acli).toMatchObject({ bin: "acli-bin" });
	expect(seen.git).toMatchObject({
		bin: "git-bin",
		repo: "/repo",
		base: "main",
		exec: expect.any(Function),
	});
	expect(seen.skills).toMatchObject({
		repo: "/repo",
		base: "main",
		exec: expect.any(Function),
	});
	expect((seen.git as { exec: unknown }).exec).toBe(
		(seen.skills as { exec: unknown }).exec,
	);
});

it("caps and redacts check details", async () => {
	const report = await runDoctor(config(), {
		...probes(),
		git: async () => ({
			name: "git",
			ok: false,
			detail: `ghp_secret Bearer supersecret ${"x".repeat(600)}`,
		}),
	});
	const detail = report.checks[2]?.detail ?? "";
	expect(detail.length).toBeLessThanOrEqual(512);
	expect(detail).not.toContain("ghp_secret");
	expect(detail).not.toContain("supersecret");
	expect(detail).toContain("[redacted]");
});

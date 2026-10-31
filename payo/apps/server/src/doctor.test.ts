import type { DoctorCheck } from "@payo/contracts";
import { expect, it } from "vitest";
import type { ServerConfig } from "./config.ts";
import { type DoctorProbes, runDoctor } from "./doctor.ts";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		dataDir: "/data",
		repo: "/repo",
		baseBranch: "main",
		maxConcurrentAgents: 4,
		webOrigins: [],
		devFakes: false,
		scenario: null,
		port: 0,
		testMode: true,
		piBin: "pi-bin",
		acliBin: "acli-bin",
		gitBin: "git-bin",
		piProvider: "openai",
		model: "test-model",
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
		detail: "spawn failed",
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

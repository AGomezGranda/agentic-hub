import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPayoConfigDocument } from "@payo/config";
import { afterEach, expect, it } from "vitest";
import { createConfigSettingsService } from "./settings.ts";

const dirs: string[] = [];

function tempConfig(contents = ""): string {
	const dir = mkdtempSync(join(tmpdir(), "payo-settings-"));
	dirs.push(dir);
	const path = join(dir, "config.toml");
	writeFileSync(path, contents);
	return path;
}

function service(
	configFile: string,
	options: { env?: NodeJS.ProcessEnv; cwd?: string; devFakes?: boolean } = {},
) {
	return createConfigSettingsService({
		configFile,
		env: options.env ?? {},
		cwd: options.cwd ?? "/work",
		devFakes: options.devFakes ?? true,
	});
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

it("returns the selected path, document, revision and override names", async () => {
	const configFile = tempConfig("[server]\nport = 7444\n");
	const snapshot = await service(configFile, {
		env: { PAYO_PORT: "7555", PAYO_MODEL: "secret-model" },
	}).snapshot();
	expect(snapshot).toMatchObject({
		configFile,
		document: { server: { port: 7444 } },
		environmentOverrides: ["PAYO_PORT", "PAYO_MODEL"],
	});
	expect(snapshot.revision).toMatch(/^[0-9a-f]{64}$/);
});

it("saves the exact document and returns the new revision", async () => {
	const configFile = tempConfig("[server]\nport = 7331\n");
	const settings = service(configFile);
	const before = await settings.snapshot();
	const saved = await settings.save({
		revision: before.revision,
		document: { server: { port: 7444 }, tools: { pi: "/opt/pi" } },
	});
	expect(saved.document).toEqual({
		server: { port: 7444 },
		tools: { pi: "/opt/pi" },
	});
	expect(saved.revision).not.toBe(before.revision);
	expect(readPayoConfigDocument(configFile)).toMatchObject({
		revision: saved.revision,
		document: saved.document,
	});
});

it("rejects a real-mode candidate without an effective model before writing", async () => {
	const original = "[model]\nprovider = 'anthropic'\nid = 'claude'\n";
	const configFile = tempConfig(original);
	const settings = service(configFile, { devFakes: false });
	const before = await settings.snapshot();
	await expect(
		settings.save({ revision: before.revision, document: {} }),
	).rejects.toThrow(/real mode requires a model.*planner/);
	expect(readFileSync(configFile, "utf8")).toBe(original);
});

it("accepts an unset model in fake mode", async () => {
	const configFile = tempConfig(
		"[model]\nprovider = 'anthropic'\nid = 'claude'\n",
	);
	const settings = service(configFile, { devFakes: true });
	const before = await settings.snapshot();
	await settings.save({ revision: before.revision, document: {} });
	expect((await settings.snapshot()).document).toEqual({});
});

it("keeps legacy model and provider overrides effective", async () => {
	const configFile = tempConfig();
	const env = {
		PAYO_MODEL: "secret-model",
		PAYO_PI_PROVIDER: "secret-provider",
	};
	const settings = service(configFile, { env, devFakes: false });
	const before = await settings.snapshot();
	expect(before.environmentOverrides).toEqual([
		"PAYO_PI_PROVIDER",
		"PAYO_MODEL",
	]);
	const saved = await settings.save({
		revision: before.revision,
		document: {},
	});
	expect(saved.document).toEqual({});
	expect(readFileSync(configFile, "utf8")).not.toContain("secret");
});

it("does not leak values when a stale revision fails", async () => {
	const configFile = tempConfig(
		"[model]\nprovider = 'openai'\nid = 'secret'\n",
	);
	const settings = service(configFile, { env: { PAYO_MODEL: "secret-env" } });
	const before = await settings.snapshot();
	await settings.save({
		revision: before.revision,
		document: { server: { port: 7444 } },
	});
	const failure = await settings
		.save({ revision: before.revision, document: { server: { port: 7555 } } })
		.catch((error: Error) => error);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).not.toContain("secret");
	expect((failure as Error).message).not.toContain("7444");
	expect(readPayoConfigDocument(configFile).document).toEqual({
		server: { port: 7444 },
	});
});

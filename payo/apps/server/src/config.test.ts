import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	assertListenerPort,
	DEFAULT_MAX_CONCURRENT_AGENTS,
	loadConfig,
	PRODUCTION_PORT,
	resolveDataDir,
} from "./config.ts";

const cwd = "/repo";

describe("server config", () => {
	it("uses documented defaults", () => {
		const config = loadConfig({}, [], cwd);
		expect(config).toMatchObject({
			dataDir: `${homedir()}/.payo`,
			repo: cwd,
			baseBranch: "main",
			maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
			webOrigins: [],
			devFakes: false,
			port: PRODUCTION_PORT,
			testMode: false,
			piBin: "pi",
			acliBin: "acli",
			gitBin: "git",
			piProvider: "anthropic",
			model: null,
		});
	});

	it("reads overrides and flags", () => {
		const config = loadConfig(
			{
				PAYO_DATA_DIR: "/tmp/payo",
				PAYO_REPO: "/work",
				PAYO_BASE_BRANCH: "develop",
				PAYO_MAX_CONCURRENT_AGENTS: "2",
				PAYO_WEB_ORIGINS: "http://127.0.0.1:5173, http://localhost:3000",
				PAYO_SCENARIO: "clean-twice",
				PAYO_PI_BIN: " /opt/pi ",
				PAYO_ACLI_BIN: "/opt/acli",
				PAYO_GIT_BIN: "/opt/git",
				PAYO_PI_PROVIDER: " openai ",
				PAYO_MODEL: "gpt-5",
			},
			["--dev-fakes"],
			cwd,
		);
		expect(config).toMatchObject({
			dataDir: "/tmp/payo",
			repo: "/work",
			baseBranch: "develop",
			maxConcurrentAgents: 2,
			webOrigins: ["http://127.0.0.1:5173", "http://localhost:3000"],
			devFakes: true,
			scenario: "clean-twice",
			piBin: "/opt/pi",
			acliBin: "/opt/acli",
			gitBin: "/opt/git",
			piProvider: "openai",
			model: "gpt-5",
		});
	});

	it("requires --dev-fakes for scenarios and validates tools and model", () => {
		expect(() => loadConfig({ PAYO_SCENARIO: "clean" }, [], cwd)).toThrow(
			/--dev-fakes/,
		);
		for (const name of [
			"PAYO_PI_BIN",
			"PAYO_ACLI_BIN",
			"PAYO_GIT_BIN",
			"PAYO_PI_PROVIDER",
		])
			expect(() => loadConfig({ [name]: "  " }, [], cwd)).toThrow(/blank/);
		expect(() =>
			loadConfig({ PAYO_MODEL: "anthropic/claude" }, [], cwd),
		).toThrow(/provider/);
		expect(loadConfig({ PAYO_MODEL: "  " }, [], cwd).model).toBeNull();
	});

	it("rejects relative paths and bad concurrency", () => {
		expect(() => loadConfig({ PAYO_DATA_DIR: "relative" }, [], cwd)).toThrow(
			/absolute/,
		);
		expect(() => loadConfig({ PAYO_REPO: "relative" }, [], cwd)).toThrow(
			/absolute/,
		);
		for (const value of ["0", "-1", "1.5", "many"])
			expect(() =>
				loadConfig({ PAYO_MAX_CONCURRENT_AGENTS: value }, [], cwd),
			).toThrow(/positive integer/);
	});

	it("accepts only exact loopback origins", () => {
		for (const value of [
			"*",
			"http://127.0.0.1:5173/",
			"http://127.0.0.1:5173/path",
			"http://example.com",
			"https://127.0.0.1:5173?x=1",
		])
			expect(() => loadConfig({ PAYO_WEB_ORIGINS: value }, [], cwd)).toThrow(
				/origin|loopback/,
			);
		expect(
			loadConfig({ PAYO_WEB_ORIGINS: "http://[::1]:3000" }, [], cwd).webOrigins,
		).toEqual(["http://[::1]:3000"]);
	});

	it("accepts PAYO_TEST_PORT only in test mode, including zero", () => {
		expect(
			loadConfig({ NODE_ENV: "test", PAYO_TEST_PORT: "0" }, [], cwd).port,
		).toBe(0);
		expect(
			loadConfig({ NODE_ENV: "test", PAYO_TEST_PORT: "4555" }, [], cwd).port,
		).toBe(4555);
		expect(() => loadConfig({ PAYO_TEST_PORT: "4555" }, [], cwd)).toThrow(
			/NODE_ENV=test/,
		);
		for (const value of ["-1", "65536", "abc"])
			expect(() =>
				loadConfig({ NODE_ENV: "test", PAYO_TEST_PORT: value }, [], cwd),
			).toThrow(/between 0 and 65535/);
	});

	it("validates injected listener ports", () => {
		expect(assertListenerPort(0)).toBe(0);
		expect(assertListenerPort(65535)).toBe(65535);
		for (const value of [-1, 65536, 1.5, Number.NaN])
			expect(() => assertListenerPort(value)).toThrow(/between 0 and 65535/);
	});

	it("resolves the data directory from the environment", () => {
		expect(resolveDataDir({ PAYO_DATA_DIR: "/tmp/x" })).toBe("/tmp/x");
		expect(resolveDataDir({})).toBe(`${homedir()}/.payo`);
	});
});

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PRODUCTION_PORT = 7331;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

export interface ServerConfig {
	dataDir: string;
	repo: string;
	baseBranch: string;
	maxConcurrentAgents: number;
	webOrigins: string[];
	devFakes: boolean;
	scenario: string | null;
	port: number;
	testMode: boolean;
	piBin: string;
	acliBin: string;
	gitBin: string;
	piProvider: string;
	model: string | null;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PAYO_DATA_DIR?.trim() || join(homedir(), ".payo");
}

function positiveInteger(value: string, name: string): number {
	if (!/^\d+$/.test(value) || Number(value) < 1)
		throw new Error(`${name} must be a positive integer`);
	return Number(value);
}

function listenerPort(env: NodeJS.ProcessEnv): number {
	const raw = env.PAYO_TEST_PORT?.trim();
	if (!raw) return PRODUCTION_PORT;
	if (env.NODE_ENV !== "test")
		throw new Error("PAYO_TEST_PORT is only allowed when NODE_ENV=test");
	if (!/^\d+$/.test(raw) || Number(raw) > 65535)
		throw new Error("PAYO_TEST_PORT must be an integer between 0 and 65535");
	return Number(raw);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function exactOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`invalid origin ${JSON.stringify(value)}`);
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		!LOOPBACK.has(url.hostname) ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.origin !== value
	)
		throw new Error(
			`origin ${JSON.stringify(value)} is not an exact loopback origin`,
		);
	return url.origin;
}

function webOrigins(env: NodeJS.ProcessEnv): string[] {
	const raw = env.PAYO_WEB_ORIGINS?.trim();
	if (!raw) return [];
	return raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.map(exactOrigin);
}

function scenario(env: NodeJS.ProcessEnv): string | null {
	const value = env.PAYO_SCENARIO?.trim();
	return value || null;
}

function executable(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	if (value === undefined) return fallback;
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${name} must not be blank`);
	return trimmed;
}

function model(env: NodeJS.ProcessEnv): string | null {
	const value = env.PAYO_MODEL?.trim();
	if (!value) return null;
	if (value.includes("/"))
		throw new Error(
			"PAYO_MODEL must not include a provider (set PAYO_PI_PROVIDER)",
		);
	return value;
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv.slice(2),
	cwd: string = process.cwd(),
): ServerConfig {
	const dataDir = resolveDataDir(env);
	const repo = env.PAYO_REPO?.trim() || cwd;
	if (!isAbsolute(dataDir)) throw new Error("PAYO_DATA_DIR must be absolute");
	if (!isAbsolute(repo)) throw new Error("PAYO_REPO must be absolute");
	const maxRaw = env.PAYO_MAX_CONCURRENT_AGENTS?.trim();
	const maxConcurrentAgents = maxRaw
		? positiveInteger(maxRaw, "PAYO_MAX_CONCURRENT_AGENTS")
		: DEFAULT_MAX_CONCURRENT_AGENTS;
	const devFakes = argv.includes("--dev-fakes");
	const scenarioValue = scenario(env);
	if (scenarioValue !== null && !devFakes)
		throw new Error("PAYO_SCENARIO requires --dev-fakes");
	return {
		dataDir,
		repo,
		baseBranch: env.PAYO_BASE_BRANCH?.trim() || "main",
		maxConcurrentAgents,
		webOrigins: webOrigins(env),
		devFakes,
		scenario: scenarioValue,
		port: listenerPort(env),
		testMode: env.NODE_ENV === "test",
		piBin: executable(env.PAYO_PI_BIN, "pi", "PAYO_PI_BIN"),
		acliBin: executable(env.PAYO_ACLI_BIN, "acli", "PAYO_ACLI_BIN"),
		gitBin: executable(env.PAYO_GIT_BIN, "git", "PAYO_GIT_BIN"),
		piProvider: executable(
			env.PAYO_PI_PROVIDER,
			"anthropic",
			"PAYO_PI_PROVIDER",
		),
		model: model(env),
	};
}

export function assertListenerPort(port: number): number {
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("listener port must be an integer between 0 and 65535");
	return port;
}

import {
	loadPayoConfig,
	type ModelSelection,
	PAYO_ROLES,
	type PayoRole,
	type PayoRoleSetting,
	resolveDataDir as resolveSharedDataDir,
} from "@payo/config";
import type { ExecutionCheck } from "@payo/contracts";

export const PRODUCTION_PORT = 7331;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

export interface ServerConfig {
	configFile: string;
	dataDir: string;
	repo: string;
	baseBranch: string;
	maxConcurrentAgents: number;
	webOrigins: string[];
	checks: ExecutionCheck[];
	devFakes: boolean;
	scenario: string | null;
	port: number;
	testMode: boolean;
	piBin: string;
	acliBin: string;
	gitBin: string;
	piProvider: string;
	model: string | null;
	roles: Record<PayoRole, PayoRoleSetting> & { implementer?: PayoRoleSetting };
}

export type { ModelSelection, PayoRole };

export function resolveDataDir(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): string {
	return resolveSharedDataDir(env, cwd);
}

function listenerPort(env: NodeJS.ProcessEnv, configuredPort: number): number {
	const raw = env.PAYO_TEST_PORT?.trim();
	if (!raw) return configuredPort;
	if (env.NODE_ENV !== "test")
		throw new Error("PAYO_TEST_PORT is only allowed when NODE_ENV=test");
	if (!/^\d+$/.test(raw) || Number(raw) > 65535)
		throw new Error("PAYO_TEST_PORT must be an integer between 0 and 65535");
	return Number(raw);
}

function scenario(env: NodeJS.ProcessEnv): string | null {
	const value = env.PAYO_SCENARIO?.trim();
	return value || null;
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv.slice(2),
	cwd: string = process.cwd(),
): ServerConfig {
	const shared = loadPayoConfig(env, cwd);
	const devFakes = argv.includes("--dev-fakes");
	const scenarioValue = scenario(env);
	if (scenarioValue !== null && !devFakes)
		throw new Error("PAYO_SCENARIO requires --dev-fakes");
	return {
		configFile: shared.configFile,
		dataDir: shared.dataDir,
		repo: shared.repo,
		baseBranch: shared.baseBranch,
		maxConcurrentAgents: shared.maxConcurrentAgents,
		webOrigins: shared.webOrigins,
		checks: shared.checks,
		devFakes,
		scenario: scenarioValue,
		port: listenerPort(env, shared.port),
		testMode: env.NODE_ENV === "test",
		piBin: shared.tools.pi,
		acliBin: shared.tools.acli,
		gitBin: shared.tools.git,
		piProvider: shared.piProvider,
		model: shared.model?.id ?? null,
		roles: shared.roles,
	};
}

export function assertRealModeRoleModels(
	roles: ServerConfig["roles"],
	devFakes: boolean,
): void {
	if (devFakes) return;
	const missing = PAYO_ROLES.filter((role) => roles[role].model === null);
	if (missing.length > 0)
		throw new Error(
			`real mode requires a model for every role; missing: ${missing.join(", ")}. Configure [model] or [roles.<role>].model (or PAYO_MODEL and PAYO_PI_PROVIDER).`,
		);
}

export function assertRealModeModels(config: ServerConfig): void {
	assertRealModeRoleModels(config.roles, config.devFakes);
}

export function assertListenerPort(port: number): number {
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("listener port must be an integer between 0 and 65535");
	return port;
}

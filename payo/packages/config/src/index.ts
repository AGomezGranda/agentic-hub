import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	type ExecutionCheck,
	isExactLoopbackOrigin,
	PayoConfigDocument,
	type PublicationPolicy,
} from "@payo/contracts";
import { parse, stringify } from "smol-toml";
import type * as z from "zod";

export type PayoRole = "planner" | "reviewer" | "verifier" | "reviser";
export const PAYO_ROLES: readonly PayoRole[] = [
	"planner",
	"reviewer",
	"verifier",
	"reviser",
];

export interface ModelSelection {
	provider: string;
	id: string;
}

export interface PayoRoleSetting {
	model: ModelSelection | null;
	timeoutMs: number;
}

export interface PayoConfig {
	configFile: string;
	port: number;
	dataDir: string;
	repo: string;
	baseBranch: string;
	maxConcurrentAgents: number;
	webOrigins: string[];
	checks: ExecutionCheck[];
	tools: { pi: string; acli: string; git: string; gh: string };
	publication: Omit<PublicationPolicy, "prBodyTemplate"> & {
		prBodyTemplate?: string;
	};
	piProvider: string;
	model: ModelSelection | null;
	roles: Record<PayoRole, PayoRoleSetting> & { implementer?: PayoRoleSetting };
}

export interface PayoConfigDocumentSnapshot {
	configFile: string;
	revision: string;
	document: PayoConfigDocument;
}

export interface ConfigWriteOperations {
	writeFile?(
		path: string,
		data: string,
		options: { flag: "wx"; mode: number },
	): void;
	rename?(from: string, to: string): void;
}

/** Distinguishes an absent file from any real byte revision. */
export const MISSING_CONFIG_REVISION = "missing";

export class ConfigRevisionConflictError extends Error {
	constructor(configFile: string) {
		super(`${configFile}: config file changed since it was loaded`);
		this.name = "ConfigRevisionConflictError";
	}
}

export class PayoConfigPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PayoConfigPathError";
	}
}

const DEFAULT_PORT = 7331;
const DEFAULT_DATA_DIR = ".payo";
const DEFAULT_MAX_CONCURRENT_AGENTS = 4;

const OVERRIDE_VARIABLES = [
	"PAYO_PORT",
	"PAYO_WEB_ORIGINS",
	"PAYO_DATA_DIR",
	"PAYO_REPO",
	"PAYO_BASE_BRANCH",
	"PAYO_MAX_CONCURRENT_AGENTS",
	"PAYO_PI_BIN",
	"PAYO_ACLI_BIN",
	"PAYO_GIT_BIN",
	"PAYO_PI_PROVIDER",
	"PAYO_MODEL",
] as const;

/** Names only: values are effective process state, never this file's content. */
export function activeEnvironmentOverrides(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return OVERRIDE_VARIABLES.filter(
		(name) => optionalEnvValue(env[name]) !== undefined,
	);
}

export function resolveConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.PAYO_CONFIG_FILE !== undefined) {
		const selected = env.PAYO_CONFIG_FILE.trim();
		if (!selected || !isAbsolute(selected))
			throw new Error("PAYO_CONFIG_FILE must be an absolute path");
		return selected;
	}
	return join(homeDirectory(env), ".config", "payo", "config.toml");
}

export function loadPayoConfig(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): PayoConfig {
	const configPath = resolveConfigPath(env);
	const explicitConfig = env.PAYO_CONFIG_FILE !== undefined;
	let fileConfig: PayoConfigDocument = {};
	try {
		const source = readFileSync(configPath, "utf8");
		fileConfig = parseConfigDocument(configPath, source);
	} catch (error) {
		if (isMissingFile(error) && !explicitConfig) {
			fileConfig = {};
		} else if (isMissingFile(error)) {
			throw new Error(`${configPath}: config file not found`);
		} else {
			throw error;
		}
	}

	return resolvePayoConfigDocument(fileConfig, env, cwd);
}

/** Startup and candidate-save validation share this precedence exactly. */
export function resolvePayoConfigDocument(
	document: PayoConfigDocument,
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): PayoConfig {
	const configPath = resolveConfigPath(env);
	const fileConfig = document;

	const configuredDataDir =
		optionalEnvValue(env.PAYO_DATA_DIR) ?? fileConfig.paths?.data_dir;
	const dataDir =
		configuredDataDir ?? join(homeDirectory(env), DEFAULT_DATA_DIR);
	const repo = optionalEnvValue(env.PAYO_REPO) ?? fileConfig.paths?.repo ?? cwd;
	if (!isAbsolute(dataDir))
		throw new PayoConfigPathError(
			"PAYO_DATA_DIR/paths.data_dir must be absolute",
		);
	if (!isAbsolute(repo))
		throw new PayoConfigPathError("PAYO_REPO/paths.repo must be absolute");

	const configuredBaseBranch = optionalEnvValue(env.PAYO_BASE_BRANCH);
	const baseBranch =
		configuredBaseBranch ?? fileConfig.paths?.base_branch ?? "main";
	const maxConcurrentAgents = environmentPositiveInteger(
		env.PAYO_MAX_CONCURRENT_AGENTS,
		fileConfig.execution?.max_concurrent_agents ??
			DEFAULT_MAX_CONCURRENT_AGENTS,
		"PAYO_MAX_CONCURRENT_AGENTS",
	);
	const port = environmentPort(
		env.PAYO_PORT,
		fileConfig.server?.port ?? DEFAULT_PORT,
	);
	const webOrigins = environmentOrigins(
		env.PAYO_WEB_ORIGINS,
		fileConfig.server?.web_origins ?? [],
	);
	const tools = {
		gh: fileConfig.tools?.gh ?? "gh",
		pi: environmentExecutable(
			env.PAYO_PI_BIN,
			fileConfig.tools?.pi ?? "pi",
			"PAYO_PI_BIN",
		),
		acli: environmentExecutable(
			env.PAYO_ACLI_BIN,
			fileConfig.tools?.acli ?? "acli",
			"PAYO_ACLI_BIN",
		),
		git: environmentExecutable(
			env.PAYO_GIT_BIN,
			fileConfig.tools?.git ?? "git",
			"PAYO_GIT_BIN",
		),
	};

	const envModel = optionalEnvValue(env.PAYO_MODEL);
	if (envModel?.includes("/"))
		throw new Error(
			"PAYO_MODEL must not include a provider (set PAYO_PI_PROVIDER)",
		);
	const configuredProvider = environmentModelPart(
		env.PAYO_PI_PROVIDER,
		fileConfig.model?.provider ?? "anthropic",
		"PAYO_PI_PROVIDER",
	);
	const environmentProvider = optionalEnvValue(env.PAYO_PI_PROVIDER);
	const modelId = envModel ?? fileConfig.model?.id;
	const roleSetting = (roleConfig: {
		model?: { provider: string; id: string };
		timeout_ms?: number;
	}) => {
		const selectedModel = roleConfig.model ?? fileConfig.model;
		const id = envModel ?? selectedModel?.id;
		const provider =
			environmentProvider ?? selectedModel?.provider ?? configuredProvider;
		return {
			model: id === undefined ? null : { provider, id },
			timeoutMs: roleConfig.timeout_ms ?? 300_000,
		};
	};
	const roles = Object.fromEntries(
		PAYO_ROLES.map((role) => [
			role,
			roleSetting(fileConfig.roles?.[role] ?? {}),
		]),
	) as Record<PayoRole, PayoRoleSetting> & {
		implementer?: PayoRoleSetting;
	};
	const implementer = fileConfig.roles?.implementer;
	if (implementer !== undefined) roles.implementer = roleSetting(implementer);

	return {
		configFile: configPath,
		port,
		dataDir,
		repo,
		baseBranch,
		maxConcurrentAgents,
		webOrigins,
		checks: fileConfig.execution?.checks ?? [],
		tools,
		publication: {
			remote: fileConfig.publication?.remote ?? "origin",
			branchTemplate:
				fileConfig.publication?.branch_template ?? "{ticketId}/{slug}",
			commitTemplate:
				fileConfig.publication?.commit_template ?? "[{ticketId}] {description}",
			prTitleTemplate:
				fileConfig.publication?.pr_title_template ??
				"[{ticketId}] {description}",
			...(fileConfig.publication?.pr_body_template === undefined
				? {}
				: { prBodyTemplate: fileConfig.publication.pr_body_template }),
		},
		piProvider: configuredProvider,
		model:
			modelId === undefined
				? null
				: { provider: configuredProvider, id: modelId },
		roles,
	};
}

export function resolveDataDir(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
): string {
	return loadPayoConfig(env, cwd).dataDir;
}

/** Reads the selected file; a missing file is `{}` with a distinct revision. */
export function readPayoConfigDocument(
	configFile: string,
): PayoConfigDocumentSnapshot {
	let bytes: Buffer;
	try {
		bytes = readFileSync(configFile);
	} catch (error) {
		if (isMissingFile(error))
			return {
				configFile,
				revision: MISSING_CONFIG_REVISION,
				document: {},
			};
		throw error;
	}
	const source = bytes.toString("utf8");
	return {
		configFile,
		revision: revisionOf(bytes),
		document: parseConfigDocument(configFile, source),
	};
}

/**
 * Canonical TOML replaces comments and formatting. Revision checks close the
 * window for edits already visible, not a concurrent external write during the
 * final rename.
 */
export async function writePayoConfigDocument(
	configFile: string,
	document: PayoConfigDocument,
	expectedRevision: string,
	operations: ConfigWriteOperations = {},
): Promise<PayoConfigDocumentSnapshot> {
	const validated = PayoConfigDocument.parse(document);
	assertHostAbsolutePaths(validated);
	const text = stringify(validated);
	return withWriteLock(configFile, async () => {
		assertNotSymlink(configFile);
		if (currentRevision(configFile) !== expectedRevision)
			throw new ConfigRevisionConflictError(configFile);
		writeAtomically(configFile, text, operations);
		return {
			configFile,
			revision: revisionOf(Buffer.from(text)),
			document: validated,
		};
	});
}

const writeLocks = new Map<string, Promise<unknown>>();

function withWriteLock<T>(
	configFile: string,
	work: () => Promise<T>,
): Promise<T> {
	const previous = writeLocks.get(configFile) ?? Promise.resolve();
	const next = previous.then(work, work);
	writeLocks.set(
		configFile,
		next.catch(() => {}),
	);
	return next;
}

function currentRevision(configFile: string): string {
	try {
		return revisionOf(readFileSync(configFile));
	} catch (error) {
		if (isMissingFile(error)) return MISSING_CONFIG_REVISION;
		throw error;
	}
}

function assertNotSymlink(configFile: string): void {
	try {
		if (lstatSync(configFile).isSymbolicLink())
			throw new Error(
				`${configFile}: refusing to save through a symbolic link`,
			);
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}
}

function assertHostAbsolutePaths(document: PayoConfigDocument): void {
	for (const [name, value] of [
		["paths.data_dir", document.paths?.data_dir],
		["paths.repo", document.paths?.repo],
	] as const) {
		if (value !== undefined && !isAbsolute(value))
			throw new PayoConfigPathError(`${name} must be an absolute path`);
	}
}

function writeAtomically(
	configFile: string,
	text: string,
	operations: ConfigWriteOperations,
): void {
	mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
	const temporary = join(
		dirname(configFile),
		`.${basename(configFile)}.${process.pid}.${randomUUID()}.tmp`,
	);
	try {
		const write = operations.writeFile ?? writeFileSync;
		// POSIX owner-only 0600. Windows mode bits do not guarantee owner-only
		// access; this phase leaves ACLs unchanged.
		write(temporary, text, { flag: "wx", mode: 0o600 });
		const rename = operations.rename ?? renameSync;
		rename(temporary, configFile);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function revisionOf(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function parseConfigDocument(
	configFile: string,
	source: string,
): PayoConfigDocument {
	let parsed: unknown;
	try {
		parsed = parse(source, { unsafeKeyBehaviour: "throw" });
	} catch (error) {
		throw configError(configFile, errorMessage(error));
	}
	const result = PayoConfigDocument.safeParse(parsed);
	if (!result.success)
		throw configError(configFile, formatIssues(result.error));
	return result.data;
}

function homeDirectory(env: NodeJS.ProcessEnv): string {
	const configuredHome = env.HOME?.trim();
	return configuredHome && isAbsolute(configuredHome)
		? configuredHome
		: homedir();
}

function optionalEnvValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function environmentPositiveInteger(
	value: string | undefined,
	fallback: number,
	name: string,
): number {
	const raw = optionalEnvValue(value);
	if (raw === undefined) return fallback;
	if (
		!/^\d+$/.test(raw) ||
		Number(raw) < 1 ||
		!Number.isSafeInteger(Number(raw))
	)
		throw new Error(`${name} must be a positive integer`);
	return Number(raw);
}

function environmentPort(value: string | undefined, fallback: number): number {
	const raw = optionalEnvValue(value);
	if (raw === undefined) return fallback;
	if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535)
		throw new Error("PAYO_PORT must be an integer between 1 and 65535");
	return Number(raw);
}

function environmentOrigins(
	value: string | undefined,
	fallback: string[],
): string[] {
	const raw = optionalEnvValue(value);
	if (raw === undefined) return fallback;
	return raw
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean)
		.map((origin) => {
			if (!isExactLoopbackOrigin(origin))
				throw new Error(
					`origin ${JSON.stringify(origin)} is not an exact loopback origin`,
				);
			return new URL(origin).origin;
		});
}

function environmentExecutable(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	if (value === undefined) return fallback;
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${name} must not be blank`);
	return trimmed;
}

function environmentModelPart(
	value: string | undefined,
	fallback: string,
	name: string,
): string {
	const trimmed = value?.trim();
	const effective = trimmed || fallback;
	if (value !== undefined && !trimmed)
		throw new Error(`${name} must not be blank`);
	if (!effective || effective.includes("/"))
		throw new Error(`${name} must not be blank or include '/'`);
	return effective;
}

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const prefix = issue.path.map(String).join(".");
			if (issue.code === "unrecognized_keys")
				return issue.keys
					.map(
						(key) =>
							`${prefix ? `${prefix}.` : ""}${key}: unrecognized setting`,
					)
					.join("; ");
			return `${prefix || "<root>"}: ${issue.message}`;
		})
		.join("; ");
}

function configError(configPath: string, detail: string): Error {
	return new Error(`${configPath}: invalid config: ${detail}`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

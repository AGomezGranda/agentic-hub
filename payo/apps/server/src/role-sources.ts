import { isAbsolute } from "node:path";
import type { DoctorCheck } from "@payo/contracts";
import {
	architectureRubricPaths,
	codeQualityRubricPaths,
	EXECUTION_PREPARER_SOURCE,
	planLensResourcePaths,
	type RoleSource,
	reviewContractPath,
} from "@payo/factory";
import { type GitExec, readBlobAt, resolveBaseCommit } from "@payo/git";

const planningResources = [
	reviewContractPath,
	...architectureRubricPaths,
	...codeQualityRubricPaths,
];
const reviewResources = [...planLensResourcePaths, ...planningResources];

export const roleSkillPaths = {
	planner: {
		path: "skills/create-plan/SKILL.md",
		resources: planningResources,
	},
	reviser: {
		path: "skills/create-plan/SKILL.md",
		resources: planningResources,
	},
	reviewer: {
		path: "skills/review-plan/SKILL.md",
		resources: reviewResources,
	},
	verifier: {
		path: "skills/review-plan/SKILL.md",
		resources: reviewResources,
	},
} as const;

type Role = keyof typeof roleSkillPaths;

const testingResources = [
	reviewContractPath,
	"skills/testing-strategy/references/overview.md",
	"skills/testing-strategy/references/unit.md",
	"skills/testing-strategy/references/integration.md",
	"skills/testing-strategy/references/component.md",
	"skills/testing-strategy/references/contract.md",
	"skills/testing-strategy/references/e2e.md",
	"skills/testing-strategy/references/async.md",
] as const;
const implementationReviewResources = [
	"skills/review-plan/references/lenses.md",
	"skills/architecture-audit/SKILL.md",
	...architectureRubricPaths,
	"skills/code-quality-audit/SKILL.md",
	...codeQualityRubricPaths,
	"skills/testing-strategy/SKILL.md",
	...testingResources,
] as const;

export const executionRoleSkillPaths = {
	implementer: {
		path: "skills/implement-plan/SKILL.md",
		resources: [
			...architectureRubricPaths,
			...codeQualityRubricPaths,
			...testingResources,
		],
	},
	scout: {
		path: "skills/review-implementation/SKILL.md",
		resources: implementationReviewResources,
	},
	reviewer: {
		path: "skills/review-implementation/SKILL.md",
		resources: implementationReviewResources,
	},
	verifier: {
		path: "skills/review-implementation/SKILL.md",
		resources: implementationReviewResources,
	},
} as const;

const MAX_DETAIL = 512;

export class MissingRoleSourcesError extends Error {
	readonly repo: string;
	readonly commit: string;
	readonly missing: string[];
	readonly required: string[];

	constructor(
		repo: string,
		commit: string,
		missing: string[],
		required: string[],
	) {
		super(
			`missing role source files at ${commit} in ${repo}: ${missing.join(", ")}. Add the full role source set: ${required.join(", ")}.`,
		);
		this.name = "MissingRoleSourcesError";
		this.repo = repo;
		this.commit = commit;
		this.missing = missing;
		this.required = required;
	}
}

export async function loadRoleSources(
	repo: string,
	base: string,
	exec: GitExec,
): Promise<Record<Role, RoleSource>> {
	const commit = await resolveBaseCommit(repo, base, exec);
	return loadAt(repo, commit, exec);
}

export async function loadExecutionRoleSources(
	repo: string,
	base: string,
	exec: GitExec,
): Promise<
	Record<
		"preparer" | "implementer" | "scout" | "reviewer" | "verifier",
		RoleSource
	>
> {
	const commit = await resolveBaseCommit(repo, base, exec);
	const required = [
		...new Set(
			Object.values(executionRoleSkillPaths).flatMap(({ path, resources }) => [
				path,
				...resources,
			]),
		),
	];
	const blobs = new Map<string, { sha: string; content: string }>();
	const missing: string[] = [];
	for (const file of required) {
		const relative = repoPath(file);
		const blob = await readBlobAt(repo, commit, relative, exec);
		if (blob === null) missing.push(relative);
		else blobs.set(relative, blob);
	}
	if (missing.length > 0)
		throw new MissingRoleSourcesError(repo, commit, missing, required);
	const sources = {} as Record<
		"implementer" | "scout" | "reviewer" | "verifier",
		RoleSource
	>;
	for (const role of Object.keys(executionRoleSkillPaths) as Array<
		keyof typeof executionRoleSkillPaths
	>) {
		const { path, resources } = executionRoleSkillPaths[role];
		const main = blobs.get(path);
		if (!main) throw new Error(`execution role source ${path} not found`);
		const loaded: Record<string, string> = {};
		for (const resource of resources) {
			const blob = blobs.get(resource);
			if (!blob)
				throw new Error(`execution role resource ${resource} not found`);
			loaded[resource] = blob.content;
		}
		sources[role] = {
			path,
			sha: main.sha,
			content: main.content,
			resources: loaded,
		};
	}
	return { preparer: EXECUTION_PREPARER_SOURCE, ...sources };
}

export async function checkRoleSources(
	repo: string,
	base: string,
	exec: GitExec,
): Promise<DoctorCheck> {
	try {
		const commit = await resolveBaseCommit(repo, base, exec);
		await loadAt(repo, commit, exec);
		return {
			name: "skills",
			ok: true,
			detail: clamp(
				`${Object.keys(roleSkillPaths).length} role sources at ${commit}`,
				MAX_DETAIL,
			),
		};
	} catch (error) {
		const detail =
			error instanceof MissingRoleSourcesError
				? compactMissing(error)
				: error instanceof Error
					? error.message
					: String(error);
		return { name: "skills", ok: false, detail: clamp(detail, MAX_DETAIL) };
	}
}

async function loadAt(
	repo: string,
	commit: string,
	exec: GitExec,
): Promise<Record<Role, RoleSource>> {
	const required = [
		...new Set(
			Object.values(roleSkillPaths).flatMap(({ path, resources }) => [
				path,
				...resources,
			]),
		),
	];
	const blobs = new Map<string, { sha: string; content: string }>();
	const missing: string[] = [];
	for (const path of required) {
		const relative = repoPath(path);
		const blob = await readBlobAt(repo, commit, relative, exec);
		if (blob === null) missing.push(relative);
		else blobs.set(relative, blob);
	}
	if (missing.length > 0)
		throw new MissingRoleSourcesError(repo, commit, missing, required);

	const sources = {} as Record<Role, RoleSource>;
	for (const role of Object.keys(roleSkillPaths) as Role[]) {
		const { path, resources } = roleSkillPaths[role];
		const main = blobs.get(path);
		if (main === undefined) throw new Error(`role source ${path} not found`);
		const loaded: Record<string, string> = {};
		for (const resource of resources) {
			const blob = blobs.get(resource);
			if (blob === undefined)
				throw new Error(`role resource ${resource} not found`);
			loaded[resource] = blob.content;
		}
		sources[role] = {
			path,
			sha: main.sha,
			content: main.content,
			resources: loaded,
		};
	}
	return sources;
}

function repoPath(path: string): string {
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		path.split(/[\\/]/).includes("..")
	) {
		throw new Error(`invalid role source path ${path}`);
	}
	return path;
}

function compactMissing(error: MissingRoleSourcesError): string {
	const groups = new Map<string, string[]>();
	for (const path of error.missing) {
		const parts = path.split("/");
		const name = parts.pop() ?? path;
		const dir = parts.join("/") || ".";
		groups.set(dir, [...(groups.get(dir) ?? []), name]);
	}
	const listed = [...groups]
		.map(([dir, names]) => `${dir}/{${names.join(",")}}`)
		.join("; ");
	return `missing role files at ${error.commit.slice(0, 12)}: ${listed}. Add these files; see docs/payo/usage.md.`;
}

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

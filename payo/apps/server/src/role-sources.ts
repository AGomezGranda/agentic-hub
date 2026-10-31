import { isAbsolute } from "node:path";
import type { DoctorCheck } from "@payo/contracts";
import type { RoleSource } from "@payo/factory";
import { type GitExec, resolveBaseCommit } from "@payo/git";

export const roleSkillPaths = {
	planner: { path: "skills/create-plan/SKILL.md", resources: [] },
	reviser: { path: "skills/create-plan/SKILL.md", resources: [] },
	reviewer: {
		path: "skills/review-plan/SKILL.md",
		resources: ["skills/review-plan/references/lenses.md"],
	},
	verifier: {
		path: "skills/review-plan/SKILL.md",
		resources: ["skills/review-plan/references/lenses.md"],
	},
} as const;

type Role = keyof typeof roleSkillPaths;

const MAX_DETAIL = 512;

export async function loadRoleSources(
	repo: string,
	base: string,
	exec: GitExec,
): Promise<Record<Role, RoleSource>> {
	const commit = await resolveBaseCommit(repo, base, exec);
	return loadAt(repo, commit, exec);
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
		const message = error instanceof Error ? error.message : String(error);
		return { name: "skills", ok: false, detail: clamp(message, MAX_DETAIL) };
	}
}

async function loadAt(
	repo: string,
	commit: string,
	exec: GitExec,
): Promise<Record<Role, RoleSource>> {
	const sources = {} as Record<Role, RoleSource>;
	for (const role of Object.keys(roleSkillPaths) as Role[]) {
		const { path, resources } = roleSkillPaths[role];
		const main = await readBlob(repo, commit, repoPath(path), exec);
		const loaded: Record<string, string> = {};
		for (const resource of resources) {
			const relative = repoPath(resource);
			loaded[relative] = (await readBlob(repo, commit, relative, exec)).content;
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

async function readBlob(
	repo: string,
	commit: string,
	path: string,
	exec: GitExec,
): Promise<{ sha: string; content: string }> {
	const spec = `${commit}:${path}`;
	const sha = await exec(["-C", repo, "rev-parse", spec], {});
	const content = await exec(["-C", repo, "show", spec], {});
	if (
		sha.exitCode !== 0 ||
		content.exitCode !== 0 ||
		content.stdout.trim().length === 0
	) {
		throw new Error(`role source ${path} not found at ${commit} in ${repo}`);
	}
	return { sha: sha.stdout.trim(), content: content.stdout };
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

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

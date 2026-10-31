import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitExec } from "@payo/git";
import { expect, it } from "vitest";
import { checkRoleSources, loadRoleSources } from "./role-sources.ts";

const exec = createGitExec();
const files = {
	"skills/create-plan/SKILL.md": "create plan v1\n",
	"skills/review-plan/SKILL.md": "review plan v1\n",
	"skills/review-plan/references/lenses.md": "lenses v1\n",
};

async function git(args: string[], cwd: string): Promise<string> {
	const result = await exec(args, { cwd });
	if (result.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function repo(): Promise<{ dir: string; commit: string }> {
	const dir = await mkdtemp(join(tmpdir(), "payo-roles-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "roles"], dir);
	return { dir, commit: await git(["rev-parse", "HEAD"], dir) };
}

async function blobSha(dir: string, commit: string, path: string) {
	return git(["rev-parse", `${commit}:${path}`], dir);
}

it("loads role content and blob SHAs from the base commit", async () => {
	const { dir, commit } = await repo();
	const sources = await loadRoleSources(dir, "main", exec);

	expect(sources.planner.content).toBe(files["skills/create-plan/SKILL.md"]);
	expect(sources.planner.sha).toBe(
		await blobSha(dir, commit, "skills/create-plan/SKILL.md"),
	);
	expect(sources.reviewer.content).toBe(files["skills/review-plan/SKILL.md"]);
	expect(sources.reviewer.resources).toEqual({
		"skills/review-plan/references/lenses.md":
			files["skills/review-plan/references/lenses.md"],
	});
	expect(sources.reviser).toEqual(sources.planner);
	expect(sources.verifier).toEqual(sources.reviewer);
});

it("ignores uncommitted working-tree edits", async () => {
	const { dir, commit } = await repo();
	await writeFile(join(dir, "skills/create-plan/SKILL.md"), "dirty edit\n");
	const sources = await loadRoleSources(dir, "main", exec);
	expect(sources.planner.content).toBe(files["skills/create-plan/SKILL.md"]);
	expect(sources.planner.sha).toBe(
		await blobSha(dir, commit, "skills/create-plan/SKILL.md"),
	);
});

it("loads an older base commit while HEAD is newer", async () => {
	const { dir, commit } = await repo();
	await writeFile(join(dir, "skills/create-plan/SKILL.md"), "create plan v2\n");
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "newer"], dir);
	expect(await git(["rev-parse", "HEAD"], dir)).not.toBe(commit);

	const old = await loadRoleSources(dir, commit, exec);
	expect(old.planner.content).toBe("create plan v1\n");
	const current = await loadRoleSources(dir, "main", exec);
	expect(current.planner.content).toBe("create plan v2\n");
});

it("fails with the named error when a role source is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-roles-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	await git(["commit", "--allow-empty", "-m", "empty"], dir);
	const commit = await git(["rev-parse", "HEAD"], dir);

	await expect(loadRoleSources(dir, "main", exec)).rejects.toThrow(
		`role source skills/create-plan/SKILL.md not found at ${commit} in ${dir}`,
	);
	const check = await checkRoleSources(dir, "main", exec);
	expect(check).toMatchObject({ name: "skills", ok: false });
});

it("reports four role sources at the resolved commit", async () => {
	const { dir, commit } = await repo();
	expect(await checkRoleSources(dir, "main", exec)).toEqual({
		name: "skills",
		ok: true,
		detail: `4 role sources at ${commit}`,
	});
});

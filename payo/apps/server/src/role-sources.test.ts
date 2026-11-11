import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	architectureRubricPaths,
	codeQualityRubricPaths,
	EXECUTION_PREPARER_SOURCE,
	planLensResourcePaths,
} from "@payo/factory";
import { createGitExec } from "@payo/git";
import { expect, it } from "vitest";
import {
	checkRoleSources,
	executionRoleSkillPaths,
	loadExecutionRoleSources,
	loadRoleSources,
	MissingRoleSourcesError,
} from "./role-sources.ts";

const exec = createGitExec();
const rubricPaths = [...architectureRubricPaths, ...codeQualityRubricPaths];
it("requires the architecture standard and structure resources", () => {
	expect(architectureRubricPaths).toContain(
		"skills/architecture-audit/references/standard.md",
	);
	expect(architectureRubricPaths).toContain(
		"skills/architecture-audit/references/structure.md",
	);
});
const files: Record<string, string> = {
	"skills/create-plan/SKILL.md": "create plan v1\n",
	"skills/review-plan/SKILL.md": "review plan v1\n",
	"skills/implement-plan/SKILL.md": "implement plan v1\n",
	"skills/testing-strategy/references/overview.md": "overview\n",
	"skills/testing-strategy/references/unit.md": "unit\n",
	"skills/testing-strategy/references/integration.md": "integration\n",
	"skills/testing-strategy/references/component.md": "component\n",
	"skills/testing-strategy/references/contract.md": "contract\n",
	"skills/testing-strategy/references/e2e.md": "e2e\n",
	"skills/testing-strategy/references/async.md": "async\n",
	...Object.fromEntries(
		[
			...planLensResourcePaths,
			...rubricPaths,
			...Object.values(executionRoleSkillPaths).flatMap(
				({ path, resources }) => [path, ...resources],
			),
		].map((path) => [path, `${path}\n`]),
	),
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

it("loads execution roles separately with immutable implementation rubrics", async () => {
	const { dir, commit } = await repo();
	const roles = await loadExecutionRoleSources(dir, "main", exec);
	const mainSha = await blobSha(dir, commit, "skills/implement-plan/SKILL.md");
	expect(roles.preparer).toEqual(EXECUTION_PREPARER_SOURCE);
	expect(roles.implementer.path).toBe("skills/implement-plan/SKILL.md");
	expect(roles.implementer.sha).toBe(mainSha);
	for (const role of [
		"implementer",
		"scout",
		"reviewer",
		"verifier",
	] as const) {
		const source = roles[role];
		expect(source.sha).toBe(await blobSha(dir, commit, source.path));
		for (const path of executionRoleSkillPaths[role].resources)
			expect(source.resources[path]).toBe(files[path]);
	}
});

it("does not require execution skills for planning role loading", async () => {
	const { dir } = await repo();
	for (const path of [
		executionRoleSkillPaths.implementer.path,
		...executionRoleSkillPaths.implementer.resources.filter((item) =>
			item.includes("testing-strategy"),
		),
	])
		await git(["rm", "--", path], dir);
	await git(["commit", "-m", "remove execution-only roles"], dir);
	await expect(loadRoleSources(dir, "main", exec)).resolves.toHaveProperty(
		"planner",
	);
});

it("loads role content and blob SHAs from the base commit", async () => {
	const { dir, commit } = await repo();
	const sources = await loadRoleSources(dir, "main", exec);

	expect(sources.planner.content).toBe(files["skills/create-plan/SKILL.md"]);
	expect(sources.planner.sha).toBe(
		await blobSha(dir, commit, "skills/create-plan/SKILL.md"),
	);
	expect(sources.reviewer.content).toBe(files["skills/review-plan/SKILL.md"]);
	expect(sources.reviewer.resources).toEqual(
		Object.fromEntries(
			[...planLensResourcePaths, ...rubricPaths].map((path) => [
				path,
				files[path],
			]),
		),
	);
	expect(sources.planner.resources).toEqual(
		Object.fromEntries(rubricPaths.map((path) => [path, files[path]])),
	);
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

	const error = await loadRoleSources(dir, "main", exec).catch(
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(MissingRoleSourcesError);
	expect((error as MissingRoleSourcesError).missing).toContain(
		"skills/create-plan/SKILL.md",
	);
	expect((error as Error).message).toContain(
		`missing role source files at ${commit} in ${dir}`,
	);
	const check = await checkRoleSources(dir, "main", exec);
	expect(check).toMatchObject({ name: "skills", ok: false });
});

it("names every rubric a repository with only the old skill set lacks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-roles-"));
	await git(["init", "-b", "main"], dir);
	await git(["config", "user.email", "test@example.com"], dir);
	await git(["config", "user.name", "Test"], dir);
	for (const [path, content] of Object.entries({
		"skills/create-plan/SKILL.md": "create plan v1\n",
		"skills/review-plan/SKILL.md": "review plan v1\n",
		"skills/review-plan/references/lenses.md": "lenses v1\n",
	})) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), content);
	}
	await git(["add", "-A"], dir);
	await git(["commit", "-m", "old roles"], dir);

	const check = await checkRoleSources(dir, "main", exec);
	expect(check).toMatchObject({ name: "skills", ok: false });
	for (const path of rubricPaths)
		expect(check.detail).toContain(path.split("/").at(-1));
	expect(check.detail).toContain("skills/architecture-audit/references/");
	expect(check.detail).toContain("skills/code-quality-audit/references/");
	expect(check.detail).toContain("Add these files");
	expect(check.detail.length).toBeLessThanOrEqual(512);
});

it("reports four role sources at the resolved commit", async () => {
	const { dir, commit } = await repo();
	expect(await checkRoleSources(dir, "main", exec)).toEqual({
		name: "skills",
		ok: true,
		detail: `4 role sources at ${commit}`,
	});
});

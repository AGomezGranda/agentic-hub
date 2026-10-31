import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readPlan, renderAnswers, writePlan } from "./plans.ts";

it("preserves edits and replaces the generated answers once", () => {
	const once = renderAnswers("# Edited\n", { q: "yes" });
	const twice = renderAnswers(once, { q: "no" });
	expect(twice).toContain("# Edited");
	expect(twice).toContain("no");
	expect(twice).not.toContain("yes");
	expect(() =>
		renderAnswers(`${once}\n<!-- factory answers start -->`, {}),
	).toThrow();
});
it("rejects traversal and symlinks, and reads the working copy", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-plan-"));
	await expect(writePlan(dir, "../bad", "x")).rejects.toThrow();
	await expect(readPlan(dir, "run")).rejects.toThrow();
	await writePlan(dir, "run", "edited");
	expect(await readPlan(dir, "run")).toBe("edited");
	expect(await readFile(join(dir, "runs", "run", "plan.md"), "utf8")).toBe(
		"edited",
	);
	await symlink(join(dir, "runs", "run"), join(dir, "runs", "link"));
	await expect(readPlan(dir, "link")).rejects.toThrow();
});

it("rejects answer content that would corrupt the generated section", () => {
	expect(() =>
		renderAnswers("# plan\n", { q: "<!-- factory answers end -->" }),
	).toThrow();
	expect(() => renderAnswers("<!-- factory answers end -->", {})).toThrow();
});

it("rejects symlink plan files for both reads and writes", async () => {
	const { unlink } = await import("node:fs/promises");
	const dir = await mkdtemp(join(tmpdir(), "payo-plan-"));
	await writePlan(dir, "run", "original");
	const path = join(dir, "runs", "run", "plan.md");
	const target = join(dir, "target");
	const { writeFile } = await import("node:fs/promises");
	await writeFile(target, "protected");
	await unlink(path);
	await symlink(target, path);
	await expect(readPlan(dir, "run")).rejects.toThrow();
	await expect(writePlan(dir, "run", "replacement")).rejects.toThrow();
	expect(await readFile(target, "utf8")).toBe("protected");
});

it("makes run directories and plan files owner-only, including existing paths", async () => {
	if (process.platform === "win32") return;
	const dir = await mkdtemp(join(tmpdir(), "payo-plan-"));
	const runs = join(dir, "runs");
	const runDir = join(runs, "run");
	await mkdir(runDir, { recursive: true, mode: 0o777 });
	await chmod(dir, 0o777);
	await chmod(runs, 0o777);
	await chmod(runDir, 0o777);
	await writePlan(dir, "run", "edited");

	for (const path of [dir, runs, runDir]) {
		expect((await stat(path)).mode & 0o777).toBe(0o700);
	}
	expect((await stat(join(runDir, "plan.md"))).mode & 0o777).toBe(0o600);
});

it("validates run IDs before creating any directories", async () => {
	const { validateRunId } = await import("./plans.ts");
	for (const id of ["", ".", "..", "../escape", "a/b", "a\\b"])
		expect(() => validateRunId(id)).toThrow();
	expect(() => validateRunId("run-1.2")).not.toThrow();
});

it("leaves immutable plan artifacts unchanged when the working copy is edited", async () => {
	const { createMemoryRunStore } = await import("@payo/kernel");
	const { savePlanVersion, loadPlanVersions } = await import("./artifacts.ts");
	const { startRun, openRunLog } = await import("@payo/kernel");
	const store = createMemoryRunStore();
	const log = openRunLog(
		store,
		await startRun(store, {
			runId: "r",
			repo: "r",
			baseBranch: "main",
			config: {},
		}),
	);
	const plan = {
		markdown: "# Agent plan\n",
		prStrategy: [{ id: "p", title: "PR", phases: [] }],
		openQuestions: [],
	};
	await log.write(
		await savePlanVersion(store, {
			number: 1,
			source: "agent",
			plan,
			answers: {},
		}),
	);
	const dir = await mkdtemp(join(tmpdir(), "payo-plan-"));
	await writePlan(dir, "r", plan.markdown);
	await writePlan(dir, "r", "# Human edit\n");
	const [version] = await loadPlanVersions(store, await store.read("r"));
	if (!version) throw new Error("missing plan version");
	expect(
		new TextDecoder().decode(await store.readArtifact(version.markdown.sha256)),
	).toBe(plan.markdown);
	expect(await readPlan(dir, "r")).toBe("# Human edit\n");
});

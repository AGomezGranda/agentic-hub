import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { UsageError } from "./args.ts";
import { resolveDataDir } from "./client.ts";
import { editPlan, planPath } from "./editor.ts";

async function fixture(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "payo-editor-"));
	const script = join(dir, "editor.mjs");
	await writeFile(
		script,
		[
			'import { appendFileSync } from "node:fs";',
			'appendFileSync(process.env.EDITOR_LOG, process.argv.at(-1) + "\\n");',
			"process.exit(Number(process.env.EDITOR_EXIT ?? 0));",
		].join("\n"),
	);
	return script;
}

async function plan(dir: string, runId = "run-1"): Promise<string> {
	const path = join(dir, "runs", runId, "plan.md");
	await mkdir(join(dir, "runs", runId), { recursive: true });
	await writeFile(path, "# Plan\n");
	return path;
}

it("launches the editor with the exact plan path and propagates its exit status", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-edit-data-"));
	const path = await plan(dir);
	const script = await fixture();
	const log = join(dir, "editor.log");
	const code = await editPlan({
		dataDir: dir,
		runId: "run-1",
		env: {
			EDITOR: `${process.execPath} ${script}`,
			EDITOR_LOG: log,
			EDITOR_EXIT: "7",
		},
	});
	expect(code).toBe(7);
	expect((await readFile(log, "utf8")).trim()).toBe(path);
});

it("uses the shared data-directory default", () => {
	expect(planPath(resolveDataDir({}), "run")).toBe(
		join(homedir(), ".payo", "runs", "run", "plan.md"),
	);
});

it("rejects an unsafe run id without launching the editor", async () => {
	const spawn = vi.fn();
	await expect(
		editPlan({
			dataDir: "/tmp/payo",
			runId: "../escape",
			env: { EDITOR: "true" },
			spawn: spawn as never,
		}),
	).rejects.toBeInstanceOf(UsageError);
	expect(spawn).not.toHaveBeenCalled();
});

it("fails clearly when no editor is configured or the plan is missing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "payo-edit-data-"));
	await expect(
		editPlan({ dataDir: dir, runId: "missing", env: {} }),
	).rejects.toThrow(/VISUAL or EDITOR/);
	await plan(dir, "run-2");
	await expect(
		editPlan({
			dataDir: dir,
			runId: "missing",
			env: { EDITOR: "true" },
		}),
	).rejects.toThrow(/plan not found/);
});

import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { validateRunId } from "../plans.ts";

async function ownerOnly(path: string, mode: number): Promise<void> {
	if (process.platform !== "win32") await chmod(path, mode);
}

async function pathFor(
	dataDir: string,
	runId: string,
	create: boolean,
): Promise<string> {
	validateRunId(runId);
	const runs = join(dataDir, "runs");
	const dir = join(runs, runId);
	if (create) {
		await mkdir(dataDir, { recursive: true, mode: 0o700 });
		await ownerOnly(dataDir, 0o700);
	}
	for (const path of [runs, dir]) {
		if (create) {
			await mkdir(path, { recursive: true, mode: 0o700 });
			await ownerOnly(path, 0o700);
		}
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe run directory");
	}
	const file = join(dir, "plan.md");
	try {
		const stat = await lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new Error("unsafe plan file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create)
			throw error;
	}
	return file;
}
export async function readPlan(
	dataDir: string,
	runId: string,
): Promise<string> {
	return readFile(await pathFor(dataDir, runId, false), "utf8");
}
export async function writePlan(
	dataDir: string,
	runId: string,
	markdown: string,
): Promise<void> {
	const file = await pathFor(dataDir, runId, true);
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, markdown, { flag: "wx", mode: 0o600 });
		await rename(temp, file);
	} finally {
		await unlink(temp).catch(() => {});
	}
}

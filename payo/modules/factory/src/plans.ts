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

const start = "<!-- factory answers start -->";
const end = "<!-- factory answers end -->";

async function ownerOnly(path: string, mode: number): Promise<void> {
	if (process.platform !== "win32") await chmod(path, mode);
}

export function renderAnswers(
	markdown: string,
	answers: Record<string, string>,
): string {
	const starts = markdown.split(start).length - 1;
	const ends = markdown.split(end).length - 1;
	if (
		starts !== ends ||
		starts > 1 ||
		(starts === 1 && markdown.indexOf(start) > markdown.indexOf(end))
	)
		throw new Error("ambiguous answer delimiters");
	if (
		Object.entries(answers).some(([id, answer]) =>
			[id, answer].some(
				(value) => value.includes(start) || value.includes(end),
			),
		)
	)
		throw new Error("ambiguous answer delimiters");
	const section = Object.entries(answers)
		.map(([id, answer]) => `- **${id}:** ${answer}`)
		.join("\n");
	const rendered = `${start}\n${section}\n${end}`;
	return starts
		? markdown.slice(0, markdown.indexOf(start)) +
				rendered +
				markdown.slice(markdown.indexOf(end) + end.length)
		: `${markdown}${markdown.endsWith("\n") ? "\n" : "\n\n"}${rendered}\n`;
}
export function validateRunId(runId: string): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) ||
		runId === "." ||
		runId === ".."
	)
		throw new Error("invalid runId");
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

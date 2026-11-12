import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawLogCapture } from "@payo/kernel";

export async function createRawLog(): Promise<RawLogCapture> {
	const dir = await mkdtemp(join(tmpdir(), "payo-attempt-"));
	const path = join(dir, "events.jsonl");
	return {
		path,
		read: () => readFile(path),
		dispose: () => rm(dir, { recursive: true, force: true }),
	};
}

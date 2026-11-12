import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { createRawLog } from "./raw-log.ts";

it("reads capture bytes and removes its temporary directory", async () => {
	const capture = await createRawLog();
	try {
		await writeFile(capture.path, "raw events\n");
		expect(new TextDecoder().decode(await capture.read())).toBe("raw events\n");
	} finally {
		await capture.dispose();
	}
	await expect(access(dirname(capture.path))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

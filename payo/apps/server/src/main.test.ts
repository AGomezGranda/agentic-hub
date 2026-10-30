import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Runs under plain Node, not Vitest's resolver: proves .ts workspace packages load through pnpm links.
it("starts the server under plain Node, loading workspace packages", () => {
	const main = fileURLToPath(new URL("./main.ts", import.meta.url));
	const result = spawnSync(process.execPath, [main], { encoding: "utf8" });

	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("payo server: not implemented");
});

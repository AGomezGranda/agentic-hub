import { expect, it } from "vitest";
import { createGhExec } from "./exec.ts";

it("uses the supplied startup environment and retains fixed GitHub execution settings", async () => {
	const env = { PAYO_ENV_TEST: "startup", GH_HOST: "other-host" };
	const exec = createGhExec(process.execPath, env);
	env.PAYO_ENV_TEST = "changed";
	const result = await exec(
		[
			"-e",
			"process.stdout.write(JSON.stringify({marker:process.env.PAYO_ENV_TEST,host:process.env.GH_HOST,prompt:process.env.GH_PROMPT_DISABLED,pager:process.env.GH_PAGER}))",
		],
		{ signal: new AbortController().signal, timeoutMs: 5000, maxBuffer: 4096 },
	);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		marker: "startup",
		host: "github.com",
		prompt: "1",
		pager: "cat",
	});
});

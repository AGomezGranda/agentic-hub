import { expect, it } from "vitest";
import {
	allChecksPassed,
	type CheckResult,
	type CheckStatus,
} from "./checks.ts";

it("requires at least one check and every check to pass", () => {
	const result = (status: CheckStatus): CheckResult => ({
		name: "unit",
		status,
		exitCode: status === "passed" ? 0 : null,
		stdout: "",
		stderr: "",
		truncated: false,
	});
	expect(allChecksPassed([])).toBe(false);
	expect(allChecksPassed([result("passed"), result("passed")])).toBe(true);
	for (const status of [
		"failed",
		"timed_out",
		"cancelled",
		"spawn_failed",
	] as const)
		expect(allChecksPassed([result("passed"), result(status)])).toBe(false);
});

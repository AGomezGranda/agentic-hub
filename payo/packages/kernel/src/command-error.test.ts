import { expect, it } from "vitest";
import { commandErrorDetail } from "./application/command-error.ts";

it("keeps bounded command diagnostics while removing URLs, tokens and control characters", () => {
	expect(commandErrorDetail(" authentication required\n")).toBe(
		"authentication required",
	);
	const detail = commandErrorDetail(
		"https://user:password@github.com/repo?token=secret Bearer secret ghp_secret github_pat_secret sk-secret\n\0" +
			"x".repeat(1000),
	);
	expect(detail).not.toMatch(/password|secret|[\p{Cc}]/u);
	expect(detail).toContain("[redacted]");
	expect(detail).toHaveLength(512);
	expect(commandErrorDetail("\n\0 ")).toBe("no diagnostic output");
});

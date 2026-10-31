import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	adfToText,
	checkAcli,
	createAcliTicketSource,
	parseAcliTicket,
} from "./index.ts";

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
	);
}

function execStub(result: {
	stdout?: string;
	stderr?: string;
	exitCode?: number;
}) {
	const calls: string[][] = [];
	return {
		calls,
		exec: async (args: string[]) => {
			calls.push(args);
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				exitCode: result.exitCode ?? 0,
			};
		},
	};
}

describe("parseAcliTicket", () => {
	it("flattens an ADF description and derives the browse URL", () => {
		const ticket = parseAcliTicket(fixture("ticket-adf"));

		expect(ticket.key).toBe("PAYO-123");
		expect(ticket.title).toBe("Real adapters");
		expect(ticket.description).toContain(
			"First paragraph with inline code text.",
		);
		expect(ticket.description).toContain("Line one\nLine two");
		expect(ticket.description).toContain("Item one\nItem two");
		expect(ticket.description).toContain("Thanks @alice!");
		expect(ticket.url).toBe("https://example.atlassian.net/browse/PAYO-123");
	});

	it("passes a string description through and leaves url null", () => {
		const ticket = parseAcliTicket(fixture("ticket-minimal"));

		expect(ticket.description).toBe("Plain description");
		expect(ticket.url).toBeNull();
	});

	it("rejects missing key, missing summary, and invalid keys", () => {
		expect(() => parseAcliTicket({ fields: { summary: "No key" } })).toThrow();
		expect(() =>
			parseAcliTicket({ key: "PAYO-1", fields: { summary: "" } }),
		).toThrow();
		expect(() =>
			parseAcliTicket({ key: "not-a-key", fields: { summary: "Bad key" } }),
		).toThrow();
	});

	it("rejects non-object JSON", () => {
		expect(() => parseAcliTicket("PAYO-1")).toThrow(/not an object/);
		expect(() => parseAcliTicket(null)).toThrow(/not an object/);
	});
});

describe("adfToText", () => {
	it("keeps unknown block text and ignores unknown inline nodes", () => {
		const text = adfToText({
			type: "doc",
			content: [
				{
					type: "panel",
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "inside a panel" }],
						},
					],
				},
				{ type: "rule" },
			],
		});

		expect(text).toBe("inside a panel");
	});
});

describe("createAcliTicketSource", () => {
	it("spawns acli with the exact argv and parses the ticket", async () => {
		const stub = execStub({
			stdout: JSON.stringify(fixture("ticket-minimal")),
		});
		const source = createAcliTicketSource({ exec: stub.exec });

		const ticket = await source.get("ABC-123");

		expect(stub.calls).toEqual([
			["jira", "workitem", "view", "ABC-123", "--json"],
		]);
		expect(ticket.key).toBe("PAYO-124");
	});

	it("rejects a non-Jira key before spawning", async () => {
		const stub = execStub({});
		const source = createAcliTicketSource({ exec: stub.exec });

		await expect(source.get("abc")).rejects.toThrow(/invalid Jira key/);
		expect(stub.calls).toEqual([]);
	});

	it("includes stderr in a non-zero exit error", async () => {
		const stub = execStub({ exitCode: 2, stderr: "boom" });
		const source = createAcliTicketSource({ exec: stub.exec });

		await expect(source.get("ABC-123")).rejects.toThrow(
			/acli jira workitem view ABC-123 failed \(exit 2\): boom/,
		);
	});

	it("succeeds on exit 0 even when stderr is not empty", async () => {
		const stub = execStub({
			stdout: JSON.stringify(fixture("ticket-minimal")),
			stderr: "warning: deprecation",
		});
		const source = createAcliTicketSource({ exec: stub.exec });

		await expect(source.get("ABC-123")).resolves.toMatchObject({
			key: "PAYO-124",
		});
	});
});

describe("checkAcli", () => {
	it("maps exit 0 to a passing check", async () => {
		const stub = execStub({});

		await expect(checkAcli({ exec: stub.exec })).resolves.toEqual({
			name: "acli",
			ok: true,
			detail: "ready",
		});
		expect(stub.calls).toEqual([["jira", "auth", "status"]]);
	});

	it("maps a failure to an exit code and capped detail", async () => {
		const stub = execStub({ exitCode: 1, stderr: "x".repeat(1000) });

		const check = await checkAcli({ exec: stub.exec });

		expect(check.ok).toBe(false);
		expect(check.detail).toContain("exit 1");
		expect(check.detail.length).toBe(512);
	});

	it("turns a spawn failure into a failed check", async () => {
		const check = await checkAcli({
			exec: async () => {
				throw new Error("ENOENT: acli not found");
			},
		});

		expect(check.ok).toBe(false);
		expect(check.detail).toContain("ENOENT");
	});
});

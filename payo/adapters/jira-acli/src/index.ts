import { execFile } from "node:child_process";
import type { DoctorCheck, Ticket } from "@payo/contracts";
import { Ticket as TicketSchema } from "@payo/contracts";
import type { TicketSource } from "@payo/kernel";

export type AcliExec = (
	args: string[],
	options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface AcliTicketSourceOptions {
	bin?: string;
	exec?: AcliExec;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_DETAIL = 512;
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

export function createAcliTicketSource(
	options: AcliTicketSourceOptions,
): TicketSource {
	const bin = options.bin ?? "acli";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const exec = options.exec ?? createAcliExec(bin);

	return {
		async get(key) {
			if (!JIRA_KEY.test(key)) throw new Error(`invalid Jira key: ${key}`);
			const result = await exec(["jira", "workitem", "view", key, "--json"], {
				timeoutMs,
			});
			if (result.exitCode !== 0) {
				throw new Error(
					`acli jira workitem view ${key} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
				);
			}
			let raw: unknown;
			try {
				raw = JSON.parse(result.stdout);
			} catch {
				throw new Error(`acli jira workitem view ${key} returned invalid JSON`);
			}
			return parseAcliTicket(raw);
		},
	};
}

export function parseAcliTicket(raw: unknown): Ticket {
	const value = asRecord(raw);
	if (value === null) throw new Error("acli ticket is not an object");
	const fields = asRecord(value.fields);
	if (fields === null) throw new Error("acli ticket is missing fields");
	const key = asString(value.key);
	const summary = asString(fields.summary);
	if (key === null || !JIRA_KEY.test(key)) {
		throw new Error("acli ticket has an invalid key");
	}
	if (summary === null) throw new Error("acli ticket is missing a summary");
	const description = fields.description;
	const text =
		typeof description === "string"
			? description
			: description == null
				? ""
				: adfToText(description);
	return TicketSchema.parse({
		key,
		title: summary,
		description: text,
		url: ticketUrl(asString(value.self), key),
	});
}

export function adfToText(node: unknown): string {
	return blocks([node]).trim();
}

export async function checkAcli(options: {
	bin?: string;
	exec?: AcliExec;
}): Promise<DoctorCheck> {
	const bin = options.bin ?? "acli";
	const exec = options.exec ?? createAcliExec(bin);
	try {
		const result = await exec(["jira", "auth", "status"], {
			timeoutMs: DEFAULT_TIMEOUT_MS,
		});
		if (result.exitCode === 0) {
			return { name: "acli", ok: true, detail: "ready" };
		}
		return {
			name: "acli",
			ok: false,
			detail: clamp(
				`acli jira auth status failed (exit ${result.exitCode}): ${excerpt(result.stderr || result.stdout)}`,
				MAX_DETAIL,
			),
		};
	} catch (error) {
		return {
			name: "acli",
			ok: false,
			detail: clamp(describeError(error), MAX_DETAIL),
		};
	}
}

function createAcliExec(bin: string): AcliExec {
	return (args, { timeoutMs }) =>
		new Promise((resolve, reject) => {
			execFile(
				bin,
				args,
				{ timeout: timeoutMs, shell: false },
				(error, stdout, stderr) => {
					if (error === null) {
						resolve({ stdout, stderr, exitCode: 0 });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ stdout, stderr, exitCode: error.code });
						return;
					}
					reject(error);
				},
			);
		});
}

function blocks(nodes: unknown[]): string {
	return nodes
		.map((node) => blockText(node))
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function blockText(node: unknown): string {
	const value = asRecord(node);
	if (value === null || typeof value.type !== "string") return "";
	const content = Array.isArray(value.content) ? value.content : [];
	switch (value.type) {
		case "paragraph":
		case "heading":
		case "codeBlock":
			return inline(content).trim();
		case "blockquote":
			return blocks(content);
		case "bulletList":
		case "orderedList":
			return content
				.map((item) => blockText(item).replace(/\n{3,}/g, "\n\n"))
				.filter((text) => text.length > 0)
				.join("\n")
				.trim();
		default:
			return blocks(content);
	}
}

function inline(nodes: unknown[]): string {
	return nodes.map((node) => inlineText(node)).join("");
}

function inlineText(node: unknown): string {
	const value = asRecord(node);
	if (value === null || typeof value.type !== "string") return "";
	const content = Array.isArray(value.content) ? value.content : [];
	switch (value.type) {
		case "text":
		case "code":
			return typeof value.text === "string" ? value.text : "";
		case "hardBreak":
			return "\n";
		case "mention": {
			const attrs = asRecord(value.attrs);
			return asString(attrs?.text) ?? asString(attrs?.displayName) ?? "";
		}
		case "inlineCard": {
			const attrs = asRecord(value.attrs);
			return asString(attrs?.url) ?? "";
		}
		default:
			return inline(content);
	}
}

function ticketUrl(self: string | null, key: string): string | null {
	if (self === null) return null;
	try {
		return `${new URL(self).origin}/browse/${key}`;
	} catch {
		return null;
	}
}

function clamp(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

function excerpt(value: string): string {
	const text = value.trim();
	return text.length > 0 ? text : "no output";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

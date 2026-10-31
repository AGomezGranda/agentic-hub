import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AnswerRequest,
	ApiError,
	DoctorReport,
	EventsResponse,
	type RunEvent,
	RunEventSchema,
	RunIdResponse,
	RunSummary,
	RunSummaryList,
	StartRunRequest,
	StartRunResponse,
} from "@payo/contracts";

export class ClientError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ClientError";
		this.status = status;
		this.code = code;
	}
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PAYO_DATA_DIR?.trim() || join(homedir(), ".payo");
}

export function serverUrl(env: NodeJS.ProcessEnv = process.env): string {
	if (env.NODE_ENV === "test") {
		const override = env.PAYO_TEST_SERVER_URL?.trim();
		if (override) return override.replace(/\/$/, "");
	}
	return "http://127.0.0.1:7331";
}

export async function readToken(dataDir: string): Promise<string> {
	const token = (await readFile(join(dataDir, "server-token"), "utf8")).trim();
	if (!token) throw new Error("server token is empty");
	return token;
}

interface Parser<T> {
	parse(value: unknown): T;
}

export interface StreamOptions {
	signal?: AbortSignal;
	fromSeq?: number;
	lastEventId?: number;
}

export class CliClient {
	readonly baseUrl: string;
	readonly token: string;
	readonly fetchImpl: typeof fetch;

	constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
		this.baseUrl = baseUrl;
		this.token = token;
		this.fetchImpl = fetchImpl;
	}

	async start(input: StartRunRequest): Promise<string> {
		const parsed = StartRunRequest.parse(input);
		const response = await this.request(
			"/api/v1/runs",
			"POST",
			parsed,
			StartRunResponse,
		);
		return response.runId;
	}

	async list(): Promise<RunSummary[]> {
		return (
			await this.request("/api/v1/runs", "GET", undefined, RunSummaryList)
		).runs;
	}

	async doctor(): Promise<DoctorReport> {
		return this.request("/api/v1/doctor", "GET", undefined, DoctorReport);
	}

	async summary(runId: string): Promise<RunSummary> {
		return this.request(`/api/v1/runs/${runId}`, "GET", undefined, RunSummary);
	}

	async events(runId: string): Promise<RunEvent[]> {
		return (
			await this.request(
				`/api/v1/runs/${runId}/events`,
				"GET",
				undefined,
				EventsResponse,
			)
		).events;
	}

	async answer(runId: string, input: AnswerRequest): Promise<RunSummary> {
		const body = AnswerRequest.parse(input);
		return this.request(
			`/api/v1/runs/${runId}/answer`,
			"POST",
			body,
			RunSummary,
		);
	}

	async approve(runId: string): Promise<RunSummary> {
		return this.request(
			`/api/v1/runs/${runId}/approve`,
			"POST",
			undefined,
			RunSummary,
		);
	}

	async requestChanges(runId: string): Promise<string> {
		return (
			await this.request(
				`/api/v1/runs/${runId}/request-changes`,
				"POST",
				undefined,
				RunIdResponse,
			)
		).runId;
	}

	async resume(runId: string): Promise<string> {
		return (
			await this.request(
				`/api/v1/runs/${runId}/resume`,
				"POST",
				undefined,
				RunIdResponse,
			)
		).runId;
	}

	async stream(
		runId: string,
		onEvent: (event: RunEvent) => void,
		options: StreamOptions = {},
	): Promise<void> {
		const params = new URLSearchParams();
		if (options.fromSeq !== undefined)
			params.set("fromSeq", String(options.fromSeq));
		const query = params.size ? `?${params.toString()}` : "";
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "text/event-stream",
		};
		if (options.lastEventId !== undefined)
			headers["Last-Event-ID"] = String(options.lastEventId);
		const response = await this.fetchImpl(
			`${this.baseUrl}/api/v1/runs/${runId}/events/stream${query}`,
			{ headers, signal: options.signal },
		);
		if (!response.ok) throw await errorFrom(response);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("stream has no body");
		const parser = new SseParser();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				for (const block of parser.push(
					decoder.decode(value, { stream: true }),
				)) {
					const event = RunEventSchema.parse(JSON.parse(block.data));
					onEvent(event);
					if (event.type === "run.ended") {
						await reader.cancel();
						return;
					}
				}
			}
		} catch (error) {
			if (options.signal?.aborted) return;
			throw error;
		}
	}

	private async request<T>(
		path: string,
		method: string,
		body: unknown,
		schema: Parser<T>,
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!response.ok) throw await errorFrom(response);
		const text = await response.text();
		let value: unknown;
		try {
			value = text ? JSON.parse(text) : undefined;
		} catch {
			throw new Error("server returned invalid JSON");
		}
		return schema.parse(value);
	}
}

async function errorFrom(response: Response): Promise<ClientError> {
	const text = await response.text();
	let code = "http_error";
	let message = `server returned ${response.status}`;
	try {
		const parsed = ApiError.safeParse(JSON.parse(text));
		if (parsed.success) {
			code = parsed.data.code;
			message = parsed.data.message;
		}
	} catch {
		// Keep the status-based fallback.
	}
	return new ClientError(response.status, code, message);
}

export interface SseBlock {
	id?: number;
	data: string;
}

export class SseParser {
	private buffer = "";

	push(chunk: string): SseBlock[] {
		this.buffer += chunk.replace(/\r\n/g, "\n");
		const blocks: SseBlock[] = [];
		let index = this.buffer.indexOf("\n\n");
		while (index >= 0) {
			const raw = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 2);
			let id: number | undefined;
			const data: string[] = [];
			for (const line of raw.split("\n")) {
				if (line.startsWith(":")) continue;
				if (line.startsWith("id: ")) id = Number(line.slice(4));
				if (line.startsWith("data: ")) data.push(line.slice(6));
			}
			if (data.length) blocks.push({ id, data: data.join("\n") });
			index = this.buffer.indexOf("\n\n");
		}
		return blocks;
	}
}

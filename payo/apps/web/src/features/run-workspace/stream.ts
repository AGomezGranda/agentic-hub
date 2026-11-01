import {
	ApiError as ApiErrorSchema,
	type RunEvent,
	RunEventSchema,
} from "@payo/contracts";
import { API_BASE_URL, PayoApiError } from "@web/shared/api/client.ts";

export interface SseBlock {
	id?: number;
	data: string;
}

export class SseParser {
	private buffer = "";
	private data: string[] = [];
	private id: number | undefined;

	push(chunk: string): SseBlock[] {
		this.buffer += chunk;
		const blocks: SseBlock[] = [];
		while (true) {
			const lf = this.buffer.indexOf("\n");
			const cr = this.buffer.indexOf("\r");
			const candidates = [lf, cr].filter((index) => index >= 0);
			if (candidates.length === 0) break;
			const index = Math.min(...candidates);
			if (this.buffer[index] === "\r" && index === this.buffer.length - 1)
				break;
			const line = this.buffer.slice(0, index);
			const lineEnding =
				this.buffer[index] === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
			this.buffer = this.buffer.slice(index + lineEnding);
			this.consumeLine(line, blocks);
		}
		return blocks;
	}

	private consumeLine(line: string, blocks: SseBlock[]): void {
		if (line === "") {
			if (this.data.length > 0) {
				blocks.push({
					...(this.id === undefined ? {} : { id: this.id }),
					data: this.data.join("\n"),
				});
			}
			this.data = [];
			this.id = undefined;
			return;
		}
		if (line.startsWith(":")) return;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		const value =
			separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
		if (field === "data") this.data.push(value);
		if (field === "id" && !value.includes("\0") && /^\d+$/.test(value))
			this.id = Number(value);
	}
}

export class EventLog {
	private readonly bySequence = new Map<number, RunEvent>();
	private nextSequence = 1;

	constructor(events: readonly RunEvent[] = []) {
		for (const event of events) this.bySequence.set(event.seq, event);
		this.advanceCursor();
	}

	get cursor(): number {
		return this.nextSequence - 1;
	}

	get events(): RunEvent[] {
		return [...this.bySequence.values()].sort((a, b) => a.seq - b.seq);
	}

	add(event: RunEvent): {
		added: boolean;
		events: RunEvent[];
		cursor: number;
	} {
		const added = !this.bySequence.has(event.seq);
		if (added) this.bySequence.set(event.seq, event);
		this.advanceCursor();
		return { added, events: this.events, cursor: this.cursor };
	}

	private advanceCursor(): void {
		while (this.bySequence.has(this.nextSequence)) this.nextSequence += 1;
	}
}

export type RunEventStreamResult = "closed" | "ended" | "aborted";

export interface StreamRunEventsOptions {
	runId: string;
	token: string;
	fromSeq?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	onEvent: (event: RunEvent) => void;
	onOpen?: () => void;
}

export async function streamRunEvents({
	runId,
	token,
	fromSeq,
	signal,
	fetchImpl = fetch,
	onEvent,
	onOpen,
}: StreamRunEventsOptions): Promise<RunEventStreamResult> {
	if (signal?.aborted) return "aborted";
	const url = new URL(
		`${API_BASE_URL}/runs/${encodeURIComponent(runId)}/events/stream`,
	);
	if (fromSeq !== undefined) url.searchParams.set("fromSeq", String(fromSeq));
	const response = await fetchImpl(url, {
		headers: {
			Accept: "text/event-stream",
			Authorization: `Bearer ${token}`,
		},
		signal,
	});
	if (!response.ok) throw await streamError(response);
	if (signal?.aborted) {
		await response.body?.cancel();
		return "aborted";
	}
	onOpen?.();
	const reader = response.body?.getReader();
	if (!reader) throw new Error("event stream has no response body");
	const parser = new SseParser();
	const decoder = new TextDecoder();
	const cancelReader = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancelReader, { once: true });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (signal?.aborted) return "aborted";
			if (done) {
				for (const block of parser.push(decoder.decode())) {
					const event = parseEvent(block);
					onEvent(event);
					if (event.type === "run.ended") return "ended";
				}
				return "closed";
			}
			const text = decoder.decode(value, { stream: true });
			for (const block of parser.push(text)) {
				const event = parseEvent(block);
				onEvent(event);
				if (event.type === "run.ended") {
					await reader.cancel();
					return "ended";
				}
			}
		}
	} catch (error) {
		if (signal?.aborted) return "aborted";
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancelReader);
		if (signal?.aborted) await reader.cancel().catch(() => {});
	}
}

function parseEvent(block: SseBlock): RunEvent {
	let value: unknown;
	try {
		value = JSON.parse(block.data);
	} catch {
		throw new Error("event stream returned invalid JSON");
	}
	return RunEventSchema.parse(value);
}

async function streamError(response: Response): Promise<PayoApiError> {
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	const failure = ApiErrorSchema.safeParse(data);
	return new PayoApiError(
		response.status,
		failure.success ? failure.data.code : "request_failed",
		failure.success ? failure.data.message : "The server returned an error.",
	);
}

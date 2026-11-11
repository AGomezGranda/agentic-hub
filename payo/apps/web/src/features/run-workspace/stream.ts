import {
	ApiError as ApiErrorSchema,
	type RunEvent,
	RunEventSchema,
	type SseBlock,
	SseParser,
} from "@payo/contracts";
import {
	bearerAuthorization,
	getApiBaseUrl,
	PayoApiError,
} from "@web/shared/api/client.ts";

export { SseParser } from "@payo/contracts";

export class EventLog {
	private readonly bySequence = new Map<number, RunEvent>();
	private ordered: RunEvent[] = [];
	private nextSequence = 1;

	constructor(events: readonly RunEvent[] = []) {
		this.merge(events);
	}

	get cursor(): number {
		return this.nextSequence - 1;
	}

	get events(): RunEvent[] {
		return this.ordered;
	}

	merge(events: readonly RunEvent[]): RunEvent[] {
		for (const event of events) {
			if (this.bySequence.has(event.seq)) continue;
			this.bySequence.set(event.seq, event);
			const index = this.ordered.findIndex((known) => known.seq > event.seq);
			this.ordered =
				index < 0
					? [...this.ordered, event]
					: [
							...this.ordered.slice(0, index),
							event,
							...this.ordered.slice(index),
						];
		}
		this.advanceCursor();
		return this.ordered;
	}

	add(event: RunEvent): {
		added: boolean;
		events: RunEvent[];
		cursor: number;
	} {
		const added = !this.bySequence.has(event.seq);
		const events = added ? this.merge([event]) : this.ordered;
		return { added, events, cursor: this.cursor };
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
		`${getApiBaseUrl()}/runs/${encodeURIComponent(runId)}/events/stream`,
	);
	if (fromSeq !== undefined) url.searchParams.set("fromSeq", String(fromSeq));
	const response = await fetchImpl(url, {
		headers: {
			Accept: "text/event-stream",
			Authorization: bearerAuthorization(token),
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
		await reader.cancel().catch(() => {});
	}
}

export class MalformedEventError extends Error {
	constructor() {
		super("event stream returned an event the console could not read");
		this.name = "MalformedEventError";
	}
}

function parseEvent(block: SseBlock): RunEvent {
	let value: unknown;
	try {
		value = JSON.parse(block.data);
	} catch {
		throw new MalformedEventError();
	}
	const event = RunEventSchema.safeParse(value);
	if (!event.success) throw new MalformedEventError();
	return event.data;
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

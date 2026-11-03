import type { RunEvent } from "@payo/contracts";
import { PayoApiError, setServerPort } from "@web/shared/api/client.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
	EventLog,
	MalformedEventError,
	type RunEventStreamResult,
	SseParser,
	streamRunEvents,
} from "./stream.ts";

const RUN_ID = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const STEP_ID = "7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const timestamp = "2026-10-30T00:00:00.000Z";

function stepEvent(seq: number, name = `step ${seq}`): RunEvent {
	return {
		type: "step.started",
		stepId: STEP_ID,
		name,
		seq,
		at: timestamp,
	};
}

function sse(value: unknown): string {
	const event = value as { seq: number };
	return `id: ${event.seq}\ndata: ${JSON.stringify(value)}\n\n`;
}

afterEach(() => {
	vi.unstubAllGlobals();
	sessionStorage.clear();
});

it("parses split SSE blocks, multiline data, CRLF and heartbeat comments", () => {
	const parser = new SseParser();
	expect(parser.push(": heartbeat\r")).toEqual([]);
	expect(parser.push("\n id: ignored\r\nid: 2\r\ndata: first\r\n")).toEqual([]);
	expect(parser.push("data: second\r\n\r\n")).toEqual([
		{ id: 2, data: "first\nsecond" },
	]);
});

it("orders and deduplicates replay while advancing only through a contiguous cursor", () => {
	const log = new EventLog([stepEvent(1), stepEvent(3)]);
	expect(log.cursor).toBe(1);
	expect(log.add(stepEvent(3, "duplicate"))).toEqual({
		added: false,
		events: [stepEvent(1), stepEvent(3)],
		cursor: 1,
	});
	expect(log.add(stepEvent(2))).toEqual({
		added: true,
		events: [stepEvent(1), stepEvent(2), stepEvent(3)],
		cursor: 3,
	});
	expect(log.add(stepEvent(2, "replay")).added).toBe(false);
});

it("streams authenticated events across UTF-8 chunk boundaries from the cursor", async () => {
	const event = stepEvent(4, "Plan café ☕");
	const bytes = new TextEncoder().encode(sse(event));
	const encodedPrefix = new TextEncoder().encode(
		sse(event).slice(0, sse(event).indexOf("é")),
	).byteLength;
	const splitAt = encodedPrefix + 1;
	const chunks = [
		bytes.slice(0, splitAt),
		bytes.slice(splitAt, splitAt + 1),
		bytes.slice(splitAt + 1),
	];
	let requestUrl = "";
	let requestHeaders: HeadersInit | undefined;
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			requestUrl = String(input);
			requestHeaders = init?.headers;
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(chunk);
						controller.close();
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
	) as typeof fetch;
	const seen: string[] = [];

	const result = await streamRunEvents({
		runId: RUN_ID,
		token: "secret",
		fromSeq: 4,
		fetchImpl,
		onEvent: (eventValue) =>
			seen.push(eventValue.type === "step.started" ? eventValue.name : ""),
	});

	expect(result).toBe("closed");
	expect(requestUrl).toContain(`/runs/${RUN_ID}/events/stream?fromSeq=4`);
	expect(new Headers(requestHeaders).get("Authorization")).toBe(
		"Bearer secret",
	);
	expect(seen).toEqual(["Plan café ☕"]);
});

it("stops after run.ended and reports unauthorized stream responses", async () => {
	const ended = {
		type: "run.ended",
		outcome: "approved",
		seq: 5,
		at: timestamp,
	};
	const fetchImpl = vi.fn(
		async () =>
			new Response(`${sse(ended)}${sse(stepEvent(6))}`, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
	) as unknown as typeof fetch;
	const seen: number[] = [];
	const result: RunEventStreamResult = await streamRunEvents({
		runId: RUN_ID,
		token: "secret",
		fetchImpl,
		onEvent: (event) => seen.push(event.seq),
	});
	expect(result).toBe("ended");
	expect(seen).toEqual([5]);

	await expect(
		streamRunEvents({
			runId: RUN_ID,
			token: "secret",
			fetchImpl: (async () =>
				new Response("{}", { status: 401 })) as typeof fetch,
			onEvent: () => {},
		}),
	).rejects.toMatchObject({ status: 401 });
	await expect(
		streamRunEvents({
			runId: RUN_ID,
			token: "secret",
			fetchImpl: (async () =>
				new Response("{}", { status: 401 })) as typeof fetch,
			onEvent: () => {},
		}),
	).rejects.toBeInstanceOf(PayoApiError);
});

it("rejects malformed events instead of retrying them forever", async () => {
	const fetchImpl = (async () =>
		new Response('data: {"type":"unknown"}\n\n', {
			headers: { "Content-Type": "text/event-stream" },
		})) as typeof fetch;
	await expect(
		streamRunEvents({
			runId: RUN_ID,
			token: "secret",
			fetchImpl,
			onEvent: () => {},
		}),
	).rejects.toBeInstanceOf(MalformedEventError);
});

it("cancels a pending stream when its signal is aborted", async () => {
	let cancelled = false;
	const fetchImpl = (async () =>
		new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		)) as typeof fetch;
	const controller = new AbortController();
	const pending = streamRunEvents({
		runId: RUN_ID,
		token: "secret",
		signal: controller.signal,
		fetchImpl,
		onEvent: () => {},
	});
	controller.abort();
	await expect(pending).resolves.toBe("aborted");
	expect(cancelled).toBe(true);
});

it("streams from the selected loopback port", async () => {
	setServerPort(8123);
	let requestUrl = "";
	const fetchImpl = (async (input: RequestInfo | URL) => {
		requestUrl = String(input);
		return new Response("", {
			headers: { "Content-Type": "text/event-stream" },
		});
	}) as typeof fetch;

	await streamRunEvents({
		runId: RUN_ID,
		token: "secret",
		fetchImpl,
		onEvent: () => {},
	});

	expect(requestUrl).toBe(
		`http://127.0.0.1:8123/api/v1/runs/${RUN_ID}/events/stream`,
	);
});

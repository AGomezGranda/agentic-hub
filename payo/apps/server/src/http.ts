import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
	AnswerRequest,
	type ApiError,
	DoctorReport,
	EventsResponse,
	RunId,
	RunIdResponse,
	RunSummary,
	RunSummaryList,
	StartRunRequest,
	StartRunResponse,
} from "@payo/contracts";
import { CommandError } from "@payo/factory";
import {
	corsHeaders,
	isAuthorized,
	isHostAllowed,
	isOriginAllowed,
} from "./auth.ts";
import type { Composition } from "./composition.ts";
import { ApiFailure, notFound } from "./errors.ts";

const JSON_LIMIT = 64 * 1024;

export interface HandlerOptions {
	token: string;
	webOrigins: readonly string[];
	getPort(): number;
	getServices(): Composition | null;
}

export function createHandler(
	options: HandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
	return (req, res) => {
		void handle(req, res, options).catch((error) => {
			respondFailure(res, error);
		});
	};
}

async function handle(
	req: IncomingMessage,
	res: ServerResponse,
	options: HandlerOptions,
): Promise<void> {
	const port = options.getPort();
	const origin = header(req, "origin");
	const cors = corsHeaders(origin, port, options.webOrigins);

	if (!isHostAllowed(header(req, "host"), port))
		throw new ApiFailure(403, "forbidden", "unexpected Host header");
	if (!isOriginAllowed(origin, port, options.webOrigins))
		throw new ApiFailure(403, "forbidden", "origin not allowed");

	if (req.method === "OPTIONS") {
		if (origin === undefined)
			throw new ApiFailure(403, "forbidden", "preflight requires an Origin");
		res.writeHead(204, cors);
		res.end();
		return;
	}

	if (!isAuthorized(header(req, "authorization"), options.token))
		throw new ApiFailure(401, "unauthorized", "invalid bearer token");

	const services = options.getServices();
	if (!services)
		throw new ApiFailure(503, "starting", "server is still starting");

	const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments[0] !== "api" || segments[1] !== "v1")
		throw notFound("unknown route");

	if (segments[2] === "doctor") {
		if (segments.length !== 3) throw notFound("unknown route");
		if (req.method !== "GET")
			throw new ApiFailure(405, "method_not_allowed", "method not allowed");
		json(res, 200, DoctorReport.parse(await services.doctor()), cors);
		return;
	}

	if (segments[2] !== "runs") throw notFound("unknown route");

	if (segments.length === 3) {
		if (req.method === "GET") {
			const summaries = await services.listRuns();
			json(res, 200, RunSummaryList.parse({ runs: summaries }), cors);
			return;
		}
		if (req.method === "POST") {
			const input = StartRunRequest.safeParse(await readJson(req));
			if (!input.success)
				throw new ApiFailure(400, "invalid_request", "invalid start request");
			const repo = input.data.repo ?? services.config.repo;
			const baseBranch = input.data.baseBranch ?? services.config.baseBranch;
			if (!isAbsolute(repo))
				throw new ApiFailure(400, "invalid_request", "repo must be absolute");
			const runId = await services.start({
				ticketKey: input.data.ticketKey,
				repo,
				baseBranch,
			});
			json(res, 202, StartRunResponse.parse({ runId }), cors);
			return;
		}
		throw new ApiFailure(405, "method_not_allowed", "method not allowed");
	}

	const runId = segments[3];
	if (!runId || !RunId.safeParse(runId).success)
		throw new ApiFailure(400, "invalid_request", "invalid run id");
	if (!services.hasRun(runId)) throw notFound(`run ${runId} not found`);

	if (segments.length === 4 && req.method === "GET") {
		json(res, 200, RunSummary.parse(await services.summary(runId)), cors);
		return;
	}

	if (segments.length === 5 && segments[4] === "events") {
		if (req.method !== "GET")
			throw new ApiFailure(405, "method_not_allowed", "method not allowed");
		const fromSeq = parseFromSeq(url.searchParams.get("fromSeq"));
		const events = await services.readEvents(runId, fromSeq);
		json(res, 200, EventsResponse.parse({ events }), cors);
		return;
	}

	if (
		segments.length === 6 &&
		segments[4] === "events" &&
		segments[5] === "stream"
	) {
		if (req.method !== "GET")
			throw new ApiFailure(405, "method_not_allowed", "method not allowed");
		const fromSeq = parseFromSeq(url.searchParams.get("fromSeq"));
		await stream(req, res, services, runId, fromSeq, cors);
		return;
	}

	if (
		segments.length === 5 &&
		["answer", "approve", "request-changes", "resume"].includes(
			segments[4] ?? "",
		)
	) {
		if (req.method !== "POST")
			throw new ApiFailure(405, "method_not_allowed", "method not allowed");
		const command = segments[4];
		if (command === "answer") {
			const input = AnswerRequest.safeParse(await readJson(req));
			if (!input.success)
				throw new ApiFailure(400, "invalid_request", "invalid answer request");
			json(
				res,
				200,
				RunSummary.parse(await services.answer(runId, input.data)),
				cors,
			);
			return;
		}
		if (command === "approve") {
			json(res, 200, RunSummary.parse(await services.approve(runId)), cors);
			return;
		}
		if (command === "request-changes") {
			await services.requestChanges(runId);
			json(res, 202, RunIdResponse.parse({ runId }), cors);
			return;
		}
		if (command === "resume") {
			await services.resume(runId);
			json(res, 202, RunIdResponse.parse({ runId }), cors);
			return;
		}
	}

	throw notFound("unknown route");
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function parseFromSeq(value: string | null): number | undefined {
	if (value === null) return undefined;
	if (!/^\d+$/.test(value) || Number(value) < 1)
		throw new ApiFailure(400, "invalid_request", "fromSeq must be positive");
	return Number(value);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const declared = Number(header(req, "content-length") ?? 0);
	if (declared > JSON_LIMIT)
		throw new ApiFailure(413, "payload_too_large", "request body too large");
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > JSON_LIMIT)
			throw new ApiFailure(413, "payload_too_large", "request body too large");
		chunks.push(buffer);
	}
	if (total === 0)
		throw new ApiFailure(400, "invalid_request", "request body required");
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ApiFailure(400, "invalid_request", "invalid JSON body");
	}
}

function json(
	res: ServerResponse,
	status: number,
	body: unknown,
	cors: Record<string, string>,
): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text),
		...cors,
	});
	res.end(text);
}

function respondFailure(res: ServerResponse, error: unknown): void {
	if (res.headersSent) {
		res.end();
		return;
	}
	if (error instanceof ApiFailure || error instanceof CommandError) {
		const body: ApiError = { code: error.code, message: error.message };
		json(res, error.status, body, {});
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	console.error(`payo: request failed: ${message}`);
	json(res, 500, { code: "internal", message: "internal server error" }, {});
}

async function stream(
	req: IncomingMessage,
	res: ServerResponse,
	services: Composition,
	runId: string,
	fromSeq: number | undefined,
	cors: Record<string, string>,
): Promise<void> {
	if (!services.hasRun(runId)) throw notFound(`run ${runId} not found`);
	let cursor = fromSeq;
	if (cursor === undefined) {
		const last = Number(header(req, "last-event-id"));
		cursor = Number.isInteger(last) && last > 0 ? last + 1 : 1;
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		...cors,
	});
	res.flushHeaders();

	let closed = false;
	let pollTimer: NodeJS.Timeout | undefined;
	const heartbeat = setInterval(() => {
		if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
	}, 15_000);

	const stop = () => {
		if (closed) return;
		closed = true;
		if (pollTimer) clearTimeout(pollTimer);
		clearInterval(heartbeat);
	};
	res.on("close", stop);

	const poll = async (): Promise<void> => {
		if (closed) return;
		try {
			const events = await services.readEvents(runId, cursor);
			for (const event of events) {
				if (closed || res.writableEnded) return;
				res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
				cursor = event.seq + 1;
				if (event.type === "run.ended") {
					stop();
					res.end();
					return;
				}
			}
			if (!services.isActive(runId)) {
				stop();
				res.end();
				return;
			}
			pollTimer = setTimeout(() => void poll(), 250);
		} catch {
			stop();
			res.end();
		}
	};

	await poll();
}

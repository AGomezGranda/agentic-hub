import type { RunEvent, RunSummary } from "@payo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRun } from "@web/features/runs/api.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { getRunEvents } from "./api.ts";
import { EventLog, MalformedEventError, streamRunEvents } from "./stream.ts";

type ConnectionState =
	| "loading"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "unauthorized"
	| "failed"
	| "ended";

const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const SUMMARY_REFRESH_MS = 120;

export function useRunActivity(token: string, runId: string) {
	const queryClient = useQueryClient();
	const summaryKey = useMemo(
		() => ["run", token, runId] as const,
		[runId, token],
	);
	const run = useQuery({
		queryKey: summaryKey,
		queryFn: ({ signal }) => getRun(token, runId, signal),
	});
	const history = useQuery({
		queryKey: ["events", token, runId],
		queryFn: ({ signal }) => getRunEvents(token, runId, signal),
		staleTime: Number.POSITIVE_INFINITY,
		retry: 2,
	});
	const [connection, setConnection] = useState<ConnectionState>("loading");
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [events, setEvents] = useState<RunEvent[]>([]);
	const logKey = `${token}:${runId}`;
	const logRef = useRef<{ key: string; log: EventLog } | null>(null);
	const hasRunSummary = run.data !== undefined;
	const isRunEnded = run.data?.status === "ended";

	useEffect(() => {
		if (!hasRunSummary || !history.data) return;
		const current = logRef.current;
		const entry =
			current?.key === logKey ? current : { key: logKey, log: new EventLog() };
		logRef.current = entry;
		const log = entry.log;
		setEvents(log.merge(history.data));
		if (isRunEnded) {
			setConnection("ended");
			return;
		}

		const controller = new AbortController();
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let summaryTimer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		let failures = 0;
		setConnectionError(null);

		const refreshSummary = async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: summaryKey, exact: true }),
				queryClient.invalidateQueries({
					queryKey: ["review", token, runId],
					exact: true,
				}),
				queryClient.invalidateQueries({
					queryKey: ["plan-versions", token, runId],
					exact: true,
				}),
				queryClient.invalidateQueries({
					queryKey: ["runs", token],
					exact: true,
				}),
			]);
			return queryClient.getQueryData<RunSummary>(summaryKey);
		};

		const scheduleSummaryRefresh = () => {
			if (summaryTimer) clearTimeout(summaryTimer);
			summaryTimer = setTimeout(() => {
				summaryTimer = undefined;
				void refreshSummary();
			}, SUMMARY_REFRESH_MS);
		};

		const waitBeforeRetry = (duration: number) =>
			new Promise<void>((resolve) => {
				let completed = false;
				const finish = () => {
					if (completed) return;
					completed = true;
					if (retryTimer) clearTimeout(retryTimer);
					retryTimer = undefined;
					controller.signal.removeEventListener("abort", finish);
					resolve();
				};
				if (controller.signal.aborted) {
					finish();
					return;
				}
				retryTimer = setTimeout(finish, duration);
				controller.signal.addEventListener("abort", finish, { once: true });
			});

		const connect = async () => {
			while (!stopped && !controller.signal.aborted) {
				setConnection(failures === 0 ? "connecting" : "reconnecting");
				try {
					const result = await streamRunEvents({
						runId,
						token,
						fromSeq: log.cursor + 1,
						signal: controller.signal,
						onOpen: () => {
							setConnection("connected");
							setConnectionError(null);
						},
						onEvent: (event) => {
							const update = log.add(event);
							if (!update.added) return;
							setEvents(update.events);
							if (event.type === "run.ended") {
								if (summaryTimer) clearTimeout(summaryTimer);
								setConnection("ended");
								void refreshSummary();
							} else if (
								event.type === "step.started" ||
								event.type === "step.finished" ||
								event.type === "gate.raised" ||
								event.type === "gate.resolved"
							) {
								scheduleSummaryRefresh();
							}
						},
					});
					if (result === "aborted" || controller.signal.aborted) return;
					if (result === "ended") {
						if (summaryTimer) clearTimeout(summaryTimer);
						setConnection("ended");
						void refreshSummary();
						return;
					}
					setConnectionError(
						"Live stream closed; checking the run before reconnecting.",
					);
				} catch (error) {
					if (controller.signal.aborted) return;
					if (error instanceof MalformedEventError) {
						setConnection("failed");
						setConnectionError(
							"Live stream sent an event the console could not read. Reload the page to try again.",
						);
						return;
					}
					if (
						error instanceof Error &&
						"status" in error &&
						error.status === 401
					) {
						setConnection("unauthorized");
						setConnectionError(
							"The server rejected this token. Reconnect with `payo token`.",
						);
						return;
					}
					setConnectionError(
						"Live stream disconnected; retrying automatically.",
					);
				}
				failures += 1;
				setConnection("reconnecting");
				const latest = await refreshSummary().catch(() => undefined);
				if (latest?.status === "ended") {
					setConnection("ended");
					return;
				}
				const delay = Math.min(
					RECONNECT_INITIAL_MS * 2 ** Math.min(failures - 1, 8),
					RECONNECT_MAX_MS,
				);
				await waitBeforeRetry(delay);
			}
		};

		void connect();
		return () => {
			stopped = true;
			controller.abort();
			if (retryTimer) clearTimeout(retryTimer);
			if (summaryTimer) clearTimeout(summaryTimer);
		};
	}, [
		hasRunSummary,
		history.data,
		isRunEnded,
		logKey,
		queryClient,
		runId,
		summaryKey,
		token,
	]);

	return { run, history, connection, connectionError, events };
}

import type { RunEvent } from "@payo/contracts";
import { useState } from "react";
import { activityLabel, agentEventDetail } from "./swarmState.ts";

type AttemptEvent = Extract<
	RunEvent,
	{ type: "attempt.started" | "attempt.event" | "attempt.finished" }
>;

interface AttemptGroup {
	attemptId: string;
	events: AttemptEvent[];
}

type TimelineItem =
	| { seq: number; type: "event"; event: RunEvent }
	| { seq: number; type: "attempt"; attempt: AttemptGroup };

export function ActivityTimeline({ events }: { events: RunEvent[] }) {
	const [filter, setFilter] = useState("all");
	const items = timelineItems(events).filter(
		(item) => filter === "all" || item.type === "attempt",
	);
	return (
		<section
			id="run-activity"
			aria-labelledby="activity-heading"
			className="border-b border-[var(--line)] pb-6"
		>
			<div className="mb-5 flex flex-wrap items-end justify-between gap-3">
				<div>
					<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
						RUN HISTORY
					</p>
					<h2 id="activity-heading" className="mt-1 text-lg font-semibold">
						Activity
					</h2>
				</div>
				<label className="text-xs text-[var(--muted)]">
					Activity filter
					<select
						className="ml-2 min-h-9 border border-[var(--line)] bg-[var(--surface)] px-2 text-[var(--ink)]"
						value={filter}
						onChange={(event) => setFilter(event.currentTarget.value)}
					>
						<option value="all">All events</option>
						<option value="attempts">Agent attempts</option>
					</select>
				</label>
			</div>
			{items.length === 0 ? (
				<p className="rounded-sm bg-[var(--surface-raised)] px-3 py-4 text-sm text-[var(--muted)]">
					{filter === "all"
						? "No activity recorded yet."
						: "No agent attempts recorded yet."}
				</p>
			) : (
				<ol className="space-y-3">
					{items.map((item) =>
						item.type === "attempt" ? (
							<li key={`attempt-${item.attempt.attemptId}`}>
								<AttemptDetails attempt={item.attempt} />
							</li>
						) : (
							<li
								key={`event-${item.event.seq}`}
								className="flex gap-3 rounded-sm border border-[var(--line)] px-3 py-3"
							>
								<span
									aria-hidden="true"
									className="mt-1.5 size-2 shrink-0 rounded-sm bg-[var(--muted)]"
								/>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium text-[var(--ink)]">
										{eventLabel(item.event)}
									</p>
									{eventDetail(item.event) ? (
										<p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--muted)]">
											{eventDetail(item.event)}
										</p>
									) : null}
									<EventTime at={item.event.at} />
								</div>
							</li>
						),
					)}
				</ol>
			)}
		</section>
	);
}

function timelineItems(events: RunEvent[]): TimelineItem[] {
	const attempts = new Map<string, AttemptGroup>();
	const items: TimelineItem[] = [];
	for (const event of events) {
		if (
			event.type === "attempt.started" ||
			event.type === "attempt.event" ||
			event.type === "attempt.finished"
		) {
			const attemptId = event.attemptId;
			const group = attempts.get(attemptId) ?? { attemptId, events: [] };
			group.events.push(event as AttemptEvent);
			attempts.set(attemptId, group);
		} else {
			items.push({ seq: event.seq, type: "event", event });
		}
	}
	for (const attempt of attempts.values()) {
		const first = attempt.events.reduce(
			(minimum, event) => Math.min(minimum, event.seq),
			Number.POSITIVE_INFINITY,
		);
		items.push({ seq: first, type: "attempt", attempt });
	}
	return items.sort((a, b) => a.seq - b.seq);
}

function AttemptDetails({ attempt }: { attempt: AttemptGroup }) {
	const started = attempt.events.find(
		(event) => event.type === "attempt.started",
	);
	const finished = attempt.events.find(
		(event) => event.type === "attempt.finished",
	);
	const title =
		started?.type === "attempt.started" ? started.role : "Agent attempt";
	const outcome =
		finished?.type === "attempt.finished" ? ` · ${finished.outcome}` : "";
	return (
		<details className="rounded-sm border border-[var(--line)] bg-[var(--surface)] px-3 py-3">
			<summary className="cursor-pointer list-inside text-sm font-semibold">
				Attempt: {title}
				{outcome}
			</summary>
			<div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3 text-sm">
				{started?.type === "attempt.started" ? (
					<p className="text-[var(--muted)]">
						Runner {started.runner}
						{started.model ? ` · ${started.model}` : ""}
						{` · ${started.inputArtifacts.length} input artifact(s)`}
					</p>
				) : null}
				{attempt.events.map((event) => (
					<div key={event.seq}>
						<AttemptEventText event={event} />
						<EventTime at={event.at} />
					</div>
				))}
			</div>
		</details>
	);
}

function AttemptEventText({ event }: { event: AttemptEvent }) {
	if (event.type === "attempt.event") {
		const text = agentEventDetail(event.event);
		return (
			<div>
				<p className="font-medium">{activityLabel(event.event)}</p>
				{text !== null ? (
					<pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm text-[var(--muted)]">
						{text}
					</pre>
				) : null}
			</div>
		);
	}
	if (event.type === "attempt.finished")
		return (
			<p className="font-medium">
				Attempt {event.outcome}
				{event.error ? ` · ${event.error}` : ""}
			</p>
		);
	return <p className="font-medium">Attempt started</p>;
}

function eventLabel(event: RunEvent): string {
	switch (event.type) {
		case "run.created":
			return "Run created";
		case "run.ended":
			return `Run ended · ${event.outcome}`;
		case "step.started":
			return `Started · ${event.name}`;
		case "step.finished":
			return `Step ${event.outcome}`;
		case "gate.raised":
			return `Gate raised · ${event.kind}`;
		case "gate.resolved":
			return `Gate resolved · ${event.command}`;
		case "artifact.recorded":
			return "Artifact recorded";
		default:
			return "Run activity";
	}
}

function eventDetail(event: RunEvent): string | null {
	if (event.type === "gate.raised") return event.reason;
	if (event.type === "gate.resolved") return event.note;
	if (event.type === "step.finished") return `Step ID: ${event.stepId}`;
	return null;
}

function EventTime({ at }: { at: string }) {
	const parsed = new Date(at);
	return (
		<time className="mt-1 block text-[11px] text-[var(--muted)]" dateTime={at}>
			{Number.isNaN(parsed.valueOf()) ? at : parsed.toLocaleString()}
		</time>
	);
}

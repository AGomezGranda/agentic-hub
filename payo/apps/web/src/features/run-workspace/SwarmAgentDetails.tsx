import { Markdown } from "@web/shared/ui/Markdown.tsx";
import { useEffect, useRef } from "react";
import {
	activityLabel,
	agentEventDetail,
	type SwarmAttempt,
} from "./swarmState.ts";

export function SwarmAgentDetails({
	attempt,
	onClose,
	onOpenRun,
}: {
	attempt: SwarmAttempt;
	onClose: () => void;
	onOpenRun: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		return () => element?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			aria-labelledby="swarm-details-title"
			onCancel={onClose}
			className="m-auto max-h-[85vh] w-[min(48rem,calc(100%-2rem))] overflow-y-auto border border-[var(--line)] bg-[var(--surface)] p-6 text-[var(--ink)] shadow-2xl backdrop:bg-black/70"
		>
			<div className="flex justify-between gap-3">
				<div>
					<h2 id="swarm-details-title" className="text-xl font-semibold">
						{attempt.role} details
					</h2>
					<p className="mt-1 text-sm text-[var(--muted)]">
						{attempt.model ?? "Model unknown"} · {attempt.status}
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-[var(--accent)] underline"
				>
					Close details
				</button>
			</div>
			<ol className="mt-6 space-y-4">
				{attempt.events.map((event) => {
					const label =
						event.type === "attempt.event"
							? activityLabel(event.event)
							: event.type === "attempt.finished"
								? `Attempt ${event.outcome}`
								: "Attempt started";
					const detail =
						event.type === "attempt.finished"
							? event.error
							: event.type === "attempt.event"
								? agentEventDetail(event.event)
								: undefined;
					return (
						<li
							key={event.seq}
							className="border border-[var(--line)] bg-[var(--canvas)] p-4 text-sm"
						>
							<div className="flex flex-wrap items-baseline justify-between gap-2">
								<p className="font-medium">{label}</p>
								<time
									dateTime={event.at}
									className="text-xs text-[var(--muted)]"
								>
									{event.at}
								</time>
							</div>
							{detail && (
								<div className="mt-3">
									<Detail text={detail} />
								</div>
							)}
						</li>
					);
				})}
			</ol>
			<button
				type="button"
				onClick={onOpenRun}
				className="mt-4 text-sm text-[var(--accent)] underline"
			>
				Open run workspace
			</button>
		</dialog>
	);
}

function Detail({ text }: { text: string }) {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return <Markdown>{text}</Markdown>;
	}
	if (!value || typeof value !== "object") return <Markdown>{text}</Markdown>;
	const record = value as Record<string, unknown>;
	const plan = record.plan;
	const markdown =
		typeof record.markdown === "string"
			? record.markdown
			: plan &&
					typeof plan === "object" &&
					"markdown" in plan &&
					typeof plan.markdown === "string"
				? plan.markdown
				: null;
	return (
		<>
			{markdown !== null && <Markdown>{markdown}</Markdown>}
			<details
				className={markdown !== null ? "mt-4" : ""}
				open={markdown === null || undefined}
			>
				<summary className="cursor-pointer text-[var(--accent)]">
					Structured data
				</summary>
				<pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border border-[var(--line)] bg-[var(--surface)] p-3 text-xs">
					{JSON.stringify(value, null, 2)}
				</pre>
			</details>
		</>
	);
}

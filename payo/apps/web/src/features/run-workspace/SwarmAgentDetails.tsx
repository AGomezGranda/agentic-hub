import { activityLabel, type SwarmAttempt } from "./swarmState.ts";

export function SwarmAgentDetails({
	attempt,
	onClose,
	onOpenRun,
}: {
	attempt: SwarmAttempt;
	onClose: () => void;
	onOpenRun: () => void;
}) {
	return (
		<aside
			aria-label={`Details for ${attempt.role}`}
			className="mt-4 border border-[var(--line)] bg-[var(--surface-raised)] p-4"
		>
			<div className="flex justify-between gap-3">
				<h4 className="font-semibold">{attempt.role} details</h4>
				<button
					type="button"
					onClick={onClose}
					className="text-[var(--accent)] underline"
				>
					Close details
				</button>
			</div>
			<ol className="mt-3 space-y-3">
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
								? event.event.type === "message" ||
									event.event.type === "result"
									? event.event.text
									: event.event.type === "error"
										? event.event.message
										: undefined
								: undefined;
					return (
						<li key={event.seq} className="text-sm">
							<p className="font-medium">{label}</p>
							{detail && (
								<pre className="whitespace-pre-wrap break-words font-sans">
									{detail}
								</pre>
							)}
							<time dateTime={event.at} className="text-xs text-[var(--muted)]">
								{event.at}
							</time>
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
		</aside>
	);
}

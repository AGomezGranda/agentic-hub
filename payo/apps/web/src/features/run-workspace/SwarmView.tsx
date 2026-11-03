import type { RunEvent } from "@payo/contracts";
import { useState } from "react";
import { SwarmAgentDetails } from "./SwarmAgentDetails.tsx";
import { projectSwarm } from "./swarmState.ts";

export function SwarmView({
	events,
	onOpenWorkspace,
}: {
	events: RunEvent[];
	onOpenWorkspace: () => void;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const steps = projectSwarm(events);
	const selectedAttempt = steps
		.flatMap((step) => step.attempts)
		.find((attempt) => attempt.id === selected);
	const columns: (typeof steps)[] = [];
	for (const step of steps) {
		const previous = columns.at(-1);
		if (
			step.name.startsWith("review:") &&
			previous?.[0]?.name.startsWith("review:")
		)
			previous.push(step);
		else columns.push([step]);
	}
	return (
		<section aria-labelledby="swarm-heading" className="space-y-5">
			<div>
				<h2 id="swarm-heading" className="text-xl font-semibold">
					Swarm
				</h2>
				<p className="mt-1 text-sm text-[var(--muted)]">
					Agents and their recorded activity for this run. Activity can be
					delayed while agents run.
				</p>
			</div>
			{steps.length === 0 ? (
				<p className="rounded-sm border border-[var(--line)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
					No agent activity recorded yet.
				</p>
			) : (
				<div className="flex items-start gap-4 overflow-x-auto pb-4">
					{columns.map((column, index) => (
						<section
							key={column[0]?.id}
							className="w-72 shrink-0 border border-[var(--line)] bg-[var(--surface)] p-4"
						>
							<p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
								Step {index + 1}
							</p>
							{column[0]?.name.startsWith("review:") && (
								<h3 className="mt-1 font-semibold">Review swarm</h3>
							)}
							{column.map((step) => (
								<div key={step.id}>
									<h3 className="mt-1 break-words font-semibold">
										{step.name}
									</h3>
									<p className="text-xs text-[var(--muted)]">{step.status}</p>
									{step.attempts.length === 0 ? (
										<p className="mt-2 text-sm text-[var(--muted)]">
											No agent attempt yet
										</p>
									) : (
										<div className="mt-3 grid gap-3">
											{step.attempts.map((attempt) => (
												<article
													key={attempt.id}
													className="min-w-0 border border-[var(--line)] bg-[var(--canvas)] p-4 text-sm"
												>
													<button
														type="button"
														className="font-semibold text-[var(--accent)] underline focus-visible:outline-2 focus-visible:outline-offset-4"
														onClick={() => setSelected(attempt.id)}
													>
														{attempt.role}
													</button>
													<p className="mt-1 break-words">
														{attempt.model ?? "Model unknown"} ·{" "}
														{attempt.status}
													</p>
													<p className="mt-1">{attempt.activity}</p>
													<p className="mt-1 text-xs text-[var(--muted)]">
														{elapsed(attempt.startedAt, attempt.finishedAt)}
													</p>
												</article>
											))}
										</div>
									)}
								</div>
							))}
						</section>
					))}
				</div>
			)}
			{selectedAttempt && (
				<SwarmAgentDetails
					attempt={selectedAttempt}
					onClose={() => setSelected(null)}
					onOpenRun={onOpenWorkspace}
				/>
			)}
		</section>
	);
}

function elapsed(start: string, end?: string): string {
	const seconds = Math.floor(
		((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000,
	);
	return Number.isFinite(seconds)
		? `${Math.max(0, seconds)}s elapsed`
		: "Elapsed time unavailable";
}

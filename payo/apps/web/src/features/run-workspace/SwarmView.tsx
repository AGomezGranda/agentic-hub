import { projectSwarm, type RunEvent } from "@payo/contracts";
import { useRef, useState } from "react";
import { SwarmAgentDetails } from "./SwarmAgentDetails.tsx";
import { attemptActivity } from "./swarmState.ts";

export function SwarmView({
	events,
	onOpenWorkspace,
}: {
	events: RunEvent[];
	onOpenWorkspace: () => void;
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const flow = useRef<HTMLDivElement>(null);
	const steps = projectSwarm(events);
	const selectedAttempt = steps
		.flatMap((step) => step.attempts)
		.find((attempt) => attempt.id === selected);
	const columns: (typeof steps)[] = [];
	for (const step of steps) {
		const previous = columns.at(-1);
		const group = reviewGroup(step.name);
		if (group && previous?.[0] && group === reviewGroup(previous[0].name))
			previous.push(step);
		else columns.push([step]);
	}
	function goToStart() {
		const element = flow.current;
		if (!element) return;
		element.scrollTo({
			left: 0,
			behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}
	function goToEnd() {
		const element = flow.current;
		if (!element) return;
		element.scrollTo({
			left: element.scrollWidth,
			behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}
	return (
		<section aria-labelledby="swarm-heading" className="space-y-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 id="swarm-heading" className="text-xl font-semibold">
						Swarm
					</h2>
					<p className="mt-1 text-sm text-[var(--muted)]">
						Agents and their recorded activity for this run. Activity can be
						delayed while agents run.
					</p>
				</div>
				{steps.length > 0 && (
					<div className="flex shrink-0 gap-2">
						<button
							type="button"
							onClick={goToStart}
							title="Scroll to the first step"
							aria-label="Go to start of swarm"
							className="inline-flex h-8 shrink-0 items-center gap-2 border border-[var(--line)] bg-[var(--canvas)] px-2.5 text-[10px] font-bold tracking-[0.14em] text-[var(--muted)] uppercase transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							<svg
								aria-hidden="true"
								viewBox="0 0 16 16"
								className="size-4"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="square"
							>
								<path d="M3 3v10M14 8H6M9 5 6 8l3 3" />
							</svg>
							Start
						</button>
						<button
							type="button"
							onClick={goToEnd}
							title="Scroll to the latest step"
							aria-label="Go to end of swarm"
							className="inline-flex h-8 shrink-0 items-center gap-2 border border-[var(--line)] bg-[var(--canvas)] px-2.5 text-[10px] font-bold tracking-[0.14em] text-[var(--muted)] uppercase transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
						>
							<svg
								aria-hidden="true"
								viewBox="0 0 16 16"
								className="size-4"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="square"
							>
								<path d="M2 8h8M7 5l3 3-3 3M13 3v10" />
							</svg>
							End
						</button>
					</div>
				)}
			</div>
			{steps.length === 0 ? (
				<p className="rounded-sm border border-[var(--line)] bg-[var(--surface)] p-4 text-sm text-[var(--muted)]">
					No agent activity recorded yet.
				</p>
			) : (
				<div
					className="swarm-flow flex items-start gap-4 overflow-x-auto pb-4"
					ref={flow}
				>
					{columns.map((column, index) => (
						<section
							key={column[0]?.id}
							className="swarm-column w-72 shrink-0 border border-[var(--line)] bg-[var(--surface)] p-4"
						>
							<p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
								Step {index + 1}
							</p>
							{column[0] && reviewGroup(column[0].name) && (
								<h3 className="mt-1 font-semibold">
									{reviewGroup(column[0].name) === "implementation-review:"
										? "Implementation review swarm"
										: "Review swarm"}
								</h3>
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
													<p className="mt-1">{attemptActivity(attempt)}</p>
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

function reviewGroup(name: string): string | undefined {
	return name.match(/^(?:implementation-)?review:/)?.[0];
}

function elapsed(start: string, end?: string): string {
	const seconds = Math.floor(
		((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000,
	);
	return Number.isFinite(seconds)
		? `${Math.max(0, seconds)}s elapsed`
		: "Elapsed time unavailable";
}

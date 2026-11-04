import type { ExecutionSummary, OpenGateSummary } from "@payo/contracts";
import { resumeRun } from "@web/features/plan-review/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";

export function ExecutionView({
	execution,
	gate,
	token,
	onRefresh,
	onSelectRun,
}: {
	execution: ExecutionSummary;
	gate: OpenGateSummary | null;
	token: string;
	onRefresh: () => Promise<void>;
	onSelectRun: (runId: string) => void;
}) {
	const { review } = execution;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const resume = async () => {
		setPending(true);
		setError(null);
		try {
			await resumeRun(token, execution.runId);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Could not resume execution.",
			);
		} finally {
			await onRefresh();
			setPending(false);
		}
	};
	const gateAction = gate && (
		<div>
			<h3 className="font-semibold">Execution gate</h3>
			<p className="break-words">{gate.reason}</p>
			<Button
				type="button"
				disabled={
					pending ||
					execution.status !== "active" ||
					!gate.allowedCommands.includes("resume")
				}
				onClick={() => void resume()}
			>
				Resume
			</Button>
			{error && <p role="alert">{error}</p>}
		</div>
	);
	const phases = execution.phases ?? [];
	const final = execution.scope === "final";
	const activePhase =
		!final && execution.stage !== "Prepare"
			? phases[execution.phaseIndex]
			: undefined;
	const stageLabel = gate
		? "Awaiting input"
		: execution.status === "ended"
			? execution.outcome
			: execution.stage;
	return (
		<section className="min-w-0 space-y-5 text-sm">
			<h2 className="text-xl font-semibold">Execution · {execution.prId}</h2>
			<a
				className="break-all underline"
				href={`/runs/${execution.sourceRunId}`}
				onClick={(event) => {
					if (
						event.button !== 0 ||
						event.metaKey ||
						event.ctrlKey ||
						event.shiftKey ||
						event.altKey
					)
						return;
					event.preventDefault();
					onSelectRun(execution.sourceRunId);
				}}
			>
				Open source run
			</a>

			{phases.length > 0 && (
				<section aria-label="Implementation progress">
					<h3 className="font-semibold">Implementation progress</h3>
					<ol className="mt-2 divide-y divide-[var(--line)] rounded-sm border border-[var(--line)]">
						{phases.map((phase) => {
							const receipt = execution.completedPhases.find(
								(item) => item.id === phase.id,
							);
							const active = activePhase?.id === phase.id;
							return (
								<li
									key={phase.id}
									className="px-4 py-3"
									aria-current={active ? "step" : undefined}
								>
									<div className="flex flex-wrap justify-between gap-2">
										<span className="font-semibold">{phase.title}</span>
										<span>
											{receipt
												? "Completed"
												: active
													? stageLabel
													: execution.status === "ended"
														? "Not completed"
														: "Upcoming"}
										</span>
									</div>
									{receipt && (
										<code className="break-all">{receipt.resultCommit}</code>
									)}
									{active && gateAction}
								</li>
							);
						})}
						<li className="px-4 py-3" aria-current={final ? "step" : undefined}>
							<div className="flex flex-wrap justify-between gap-2">
								<span className="font-semibold">Final PR review</span>
								<span>
									{final
										? stageLabel
										: execution.status === "ended"
											? "Not started"
											: "Upcoming"}
								</span>
							</div>
							{final && gateAction}
						</li>
					</ol>
				</section>
			)}
			{!activePhase && !(final && phases.length) && gateAction}

			<div>
				<h3 className="font-semibold">
					{execution.status === "ended" && execution.outcome === "reviewed"
						? "Reviewed result"
						: "Local workspace"}
				</h3>
				<p>
					Branch:{" "}
					<span className="select-text break-all">
						{execution.branch ?? "Unavailable"}
					</span>
				</p>
				<p>
					Worktree:{" "}
					<span className="select-text break-all">
						{execution.worktree ?? "Unavailable"}
					</span>
				</p>
				{execution.status === "ended" && execution.outcome === "reviewed" && (
					<p>
						Result commit:{" "}
						<span className="select-text break-all">
							{execution.resultCommit ?? "Unavailable"}
						</span>
					</p>
				)}
			</div>
			<div>
				<h3 className="font-semibold">Current progress</h3>
				<p>Stage: {execution.stage}</p>
				<p>
					{execution.scope === "final"
						? "Final scope"
						: execution.phaseIndex < execution.phaseCount
							? `Phase ${execution.phaseIndex + 1} of ${execution.phaseCount}`
							: "Phase unavailable"}
				</p>
				{execution.statusDetail && (
					<p className="break-words">{execution.statusDetail}</p>
				)}
				<p>
					Current checkpoint:{" "}
					{review
						? `Round ${review.round} · ${review.unresolved} unresolved`
						: "round and unresolved count unavailable"}
				</p>
			</div>
			{!phases.length && (
				<div>
					<h3 className="font-semibold">Completed phases</h3>
					{execution.completedPhases.length ? (
						<ul>
							{execution.completedPhases.map((phase) => (
								<li key={phase.id}>
									<span>{phase.title}</span> ·{" "}
									<span className="select-text break-all">
										{phase.resultCommit}
									</span>
								</li>
							))}
						</ul>
					) : (
						<p>No completed phases</p>
					)}
				</div>
			)}
			<div>
				<h3 className="font-semibold">Latest checks</h3>
				<p>Latest reports may relate to earlier progress.</p>
				{execution.checks.length ? (
					<ul>
						{execution.checks.map((check) => (
							<li key={check.name}>
								{check.name} · {check.status}
							</li>
						))}
					</ul>
				) : (
					<p>No check results available</p>
				)}
			</div>
			<div>
				<h3 className="font-semibold">Latest review</h3>
				{review ? (
					<>
						<p>{review.findings} findings</p>
						{review.uncheckedLenses.length > 0 && (
							<>
								<p>Unchecked lenses</p>
								<ul>
									{review.uncheckedLenses.map((lens) => (
										<li key={lens}>{lens}</li>
									))}
								</ul>
							</>
						)}
					</>
				) : (
					<p>No review evidence available</p>
				)}
			</div>
			{execution.artifactIssues.length > 0 && (
				<div role="status">
					<h3 className="font-semibold">Artifact issues</h3>
					<ul>
						{execution.artifactIssues.map((issue) => (
							<li className="break-all" key={issue}>
								{issue}
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

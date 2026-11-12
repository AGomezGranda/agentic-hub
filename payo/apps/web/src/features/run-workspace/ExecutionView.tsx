import type { ExecutionSummary, OpenGateSummary } from "@payo/contracts";
import { resumeRun } from "@web/features/plan-review/api.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { type ReactNode, useState } from "react";
import { ExecutionNamingForm } from "./ExecutionNamingForm.tsx";
import { ExecutionPlanIssues } from "./ExecutionPlanIssues.tsx";
import { ExecutionProgress } from "./ExecutionProgress.tsx";
import { ExecutionReview, ExecutionReviewContext } from "./ExecutionReview.tsx";
import { PublishPrForm } from "./PublishPrForm.tsx";

export function ExecutionView({
	execution,
	view = "implementation",
	gate,
	token,
	onRefresh,
	onSelectRun,
	activity,
}: {
	execution: ExecutionSummary;
	view?: "implementation" | "review";
	gate: OpenGateSummary | null;
	token: string;
	onRefresh: () => Promise<void>;
	onSelectRun: (runId: string) => void;
	activity?: ReactNode;
}) {
	const { review } = execution;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const retryPreparation =
		execution.pausedOperation === "Prepare" ||
		execution.statusDetail === "manifest-invalid";
	const resume = async () => {
		setPending(true);
		setError(null);
		try {
			await resumeRun(token, execution.runId);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Could not resume PR work.",
			);
		} finally {
			try {
				await onRefresh();
			} finally {
				setPending(false);
			}
		}
	};
	const planConflict = !!execution.planIssues?.length;
	const final = execution.scope === "final";
	const phases = execution.phases ?? [];
	const passedChecks = execution.checks.filter(
		(check) => check.status === "passed",
	).length;
	const orderedChecks = [...execution.checks].sort(
		(left, right) =>
			Number(left.status === "passed") - Number(right.status === "passed"),
	);
	const checksPanel = (
		<div className="workspace-panel">
			<div className="execution-section-title">
				<h3>Latest checks</h3>
				{execution.checks.length > 0 && (
					<span>
						{passedChecks} / {execution.checks.length} passed
					</span>
				)}
			</div>
			{execution.checks.length > 0 && (
				<p className="text-xs text-[var(--muted)]">
					{view === "review"
						? review?.details?.checksAreLatest
							? "Latest checks are the checks referenced by this review."
							: "Latest execution checks; association with this review is not established."
						: "From the most recent check run."}
				</p>
			)}
			{execution.checks.length ? (
				<ul className="execution-checks">
					{orderedChecks.map((check) => (
						<li key={check.name}>
							<span>{check.name}</span>
							<span
								className={
									check.status === "passed"
										? "text-[var(--status-good)]"
										: "text-[var(--danger)]"
								}
							>
								{check.status}
							</span>
							{check.output && (
								<details className="w-full">
									<summary>Failure output for {check.name}</summary>
									<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
										{check.output}
									</pre>
								</details>
							)}
						</li>
					))}
				</ul>
			) : (
				<p>No check results available</p>
			)}
		</div>
	);
	const retry = gate && (
		<div className="execution-retry">
			{retryPreparation &&
				execution.naming &&
				!execution.worktree &&
				execution.status === "active" && (
					<ExecutionNamingForm
						token={token}
						runId={execution.runId}
						initialSlug={execution.naming.slug}
						onRefresh={onRefresh}
					/>
				)}

			{view === "implementation" &&
				review?.blockers?.map((finding) => (
					<div key={finding.id}>
						<h4 className="font-semibold">{finding.title}</h4>
						{finding.path && (
							<code>
								{finding.path}
								{finding.line && `:${finding.line}`}
							</code>
						)}
						<p>{finding.evidence}</p>
						<p>Suggested fix: {finding.suggestedFix}</p>
					</div>
				))}
			<p>
				{retryPreparation
					? "Preparation stopped before implementation started. Retry preparation checks the workspace and prepares the approved plan again."
					: planConflict
						? "Retry all reported issues using the approved plan and retained edits, without adding answers. Editing the worktree yourself is optional."
						: `Resume continues this run from ${execution.scope === "final" ? "final validation" : `phase ${execution.phaseIndex + 1}`} using the approved plan and retained edits. Completed phases are preserved.`}
			</p>
			<Button
				type="button"
				disabled={
					pending ||
					execution.status !== "active" ||
					!gate.allowedCommands.includes("resume")
				}
				onClick={() => void resume()}
			>
				{pending
					? "Checking workspace…"
					: retryPreparation
						? "Retry preparation"
						: planConflict
							? "Retry on approved plan"
							: "Resume"}
			</Button>
			{pending && (
				<p role="status">Checking the retained workspace before continuing…</p>
			)}
			{error && (
				<div role="alert">
					<p className="font-semibold">Execution could not resume</p>
					<p className="break-words">{error}</p>
				</div>
			)}
		</div>
	);
	return (
		<section className="workspace-view min-w-0 space-y-4 text-sm">
			<header className="workspace-summary">
				<div>
					<p className="workspace-label">
						{final
							? "Final scope"
							: execution.phaseIndex < execution.phaseCount
								? `Phase ${execution.phaseIndex + 1} of ${execution.phaseCount}`
								: "Phase unavailable"}
					</p>
					<h2>
						{gate
							? execution.pausedOperation
								? `Paused during ${execution.pausedOperation}`
								: "Awaiting input"
							: execution.status === "ended"
								? execution.outcome === "reviewed"
									? "Implementation reviewed"
									: `Execution ${execution.outcome ?? "ended"}`
								: execution.stage}
					</h2>
					{!gate && execution.statusDetail && (
						<p className="text-[var(--muted)]">
							{execution.statusDetail.replaceAll("-", " ")}
						</p>
					)}
				</div>
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
					Back to approved plan
				</a>
			</header>
			<div className="workspace-layout">
				<div className="workspace-main">
					{gate && (
						<section className="execution-alert">
							{planConflict ? (
								<ExecutionPlanIssues
									key={gate.gateId}
									execution={execution}
									gate={gate}
									token={token}
									onSelectRun={onSelectRun}
									onRefresh={onRefresh}
								>
									{retry}
								</ExecutionPlanIssues>
							) : (
								<>
									<h3>Needs attention</h3>
									<p className="whitespace-pre-wrap break-words">
										{gate.reason}
									</p>

									{retry}
								</>
							)}
						</section>
					)}

					{view === "implementation" && phases.length > 0 && (
						<ExecutionProgress execution={execution} />
					)}
					{view === "implementation" &&
						!phases.length &&
						execution.completedPhases.length > 0 && (
							<div className="workspace-panel">
								<h3 className="font-semibold">Completed phases</h3>
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
							</div>
						)}

					{view === "review" && <ExecutionReview review={review} />}
					{view === "review" &&
						execution.status === "ended" &&
						execution.outcome === "reviewed" && (
							<PublishPrForm
								key={execution.runId}
								token={token}
								runId={execution.runId}
								onSelectRun={onSelectRun}
							/>
						)}

					{execution.artifactIssues.length > 0 && (
						<div role="status" className="execution-alert">
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
				</div>
				<aside className="workspace-rail" aria-label="Execution context">
					{checksPanel}
					<div className="workspace-panel execution-worktree">
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
						{execution.status === "ended" &&
							execution.outcome === "reviewed" && (
								<p>
									Result commit:{" "}
									<span className="select-text break-all">
										{execution.resultCommit ?? "Unavailable"}
									</span>
								</p>
							)}
					</div>
					{view === "review" && review && (
						<ExecutionReviewContext review={review} />
					)}
				</aside>
				{view === "implementation" && activity && (
					<div className="execution-swarm console-panel">{activity}</div>
				)}
			</div>
		</section>
	);
}

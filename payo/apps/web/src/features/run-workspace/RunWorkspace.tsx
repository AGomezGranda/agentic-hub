import { PlanReview } from "@web/features/plan-review/PlanReview.tsx";
import { Button } from "@web/shared/ui/Button.tsx";
import { type ReactNode, useState } from "react";
import { ActivityTimeline } from "./ActivityTimeline.tsx";
import { CostPanel } from "./CostPanel.tsx";
import { ExecutionView } from "./ExecutionView.tsx";
import { PublicationView } from "./PublicationView.tsx";
import { StageStrip } from "./StageStrip.tsx";
import { SwarmView } from "./SwarmView.tsx";
import { useRunActivity } from "./useRunActivity.ts";
import { WorkspaceActions } from "./WorkspaceActions.tsx";

export function RunWorkspace({
	token,
	runId,
	onDisconnect,
	onSelectRun,
}: {
	token: string;
	runId: string;
	onDisconnect: () => void;
	onSelectRun: (runId: string) => void;
}) {
	const [view, setView] = useState<
		| "swarm"
		| "decision"
		| "activity"
		| "execution"
		| "code-review"
		| "publication"
		| null
	>(null);
	const { run, history, connection, connectionError, events } = useRunActivity(
		token,
		runId,
	);

	if (run.isPending) return <WorkspaceMessage>Loading run…</WorkspaceMessage>;
	if (run.error && !run.data)
		return (
			<WorkspaceMessage type="alert">
				Could not load this run: {run.error.message}
			</WorkspaceMessage>
		);
	if (!run.data) return <WorkspaceMessage>Run not found.</WorkspaceMessage>;

	const execution = run.data.execution;
	const publication = run.data.publication;
	const approved =
		run.data.status === "ended" && run.data.outcome === "approved";
	const selectedView =
		view ??
		(publication
			? "publication"
			: execution
				? execution.scope === "final"
					? "code-review"
					: "execution"
				: approved
					? "decision"
					: "swarm");
	const item = run.data.workItem;
	const statusLabel =
		connection === "loading"
			? "Loading activity"
			: connection === "connecting"
				? "Connecting…"
				: connection === "connected"
					? "Live"
					: connection === "reconnecting"
						? "Reconnecting…"
						: connection === "unauthorized"
							? "Unauthorized"
							: connection === "failed"
								? "Stream error"
								: "Ended";
	const isConnectionAlert =
		connection === "unauthorized" || connection === "failed";

	return (
		<div className="min-w-0 space-y-5">
			{run.error && (
				<p role="alert">Could not refresh this run: {run.error.message}</p>
			)}
			<section className="border-b border-[var(--line)] pb-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<p className="mb-2 text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
							{publication
								? "PUBLICATION WORKSPACE"
								: execution
									? `PR WORKSPACE · ${execution.prId}`
									: "PLAN WORKSPACE"}
						</p>
						<h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">
							{item?.title ?? "Work item unresolved"}
						</h1>
						<p className="mt-2 text-sm text-[var(--muted)]">
							{item?.key ?? (item?.source === "prompt" ? "Prompt" : runId)}
							<span aria-hidden="true"> · </span>
							{run.data.repo}
							<span aria-hidden="true"> · </span>
							Base {run.data.baseBranch}
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span
							aria-live="polite"
							className={`rounded-sm px-3 py-1.5 text-xs font-semibold ${connection === "connected" ? "bg-[var(--success-surface)] text-[var(--status-good)]" : isConnectionAlert ? "bg-[var(--danger-surface)] text-[var(--danger)]" : "bg-[var(--surface-raised)] text-[var(--muted)]"}`}
						>
							{statusLabel}
						</span>
						<span className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-xs font-semibold capitalize text-[var(--muted)]">
							{run.data.status === "active"
								? execution?.stage === "Escalated"
									? "Paused · Needs attention"
									: "Active"
								: run.data.outcome
									? `Ended · ${run.data.outcome}`
									: "Ended"}
						</span>
						<Button
							className="inline-flex"
							size="small"
							type="button"
							variant="quiet"
							onClick={onDisconnect}
						>
							Change token
						</Button>
					</div>
				</div>
				<WorkspaceActions
					key={runId}
					token={token}
					runId={runId}
					path={execution?.worktree ?? run.data.repo}
				/>
				{connectionError ? (
					<p
						className={`mt-4 rounded-sm px-3 py-2.5 text-sm ${isConnectionAlert ? "border border-[var(--danger-border)] bg-[var(--danger-surface)] text-[var(--danger)]" : "bg-[var(--surface-raised)] text-[var(--muted)]"}`}
						role={isConnectionAlert ? "alert" : "status"}
					>
						{connectionError}
					</p>
				) : null}
				{!execution && !publication && (
					<div className="mt-5">
						<StageStrip stage={run.data.stage} />
					</div>
				)}
				{run.data.openGates.length > 0 &&
					(!execution ||
						selectedView === "activity" ||
						!run.data.openGates.some(
							(gate) => gate.kind === "execution-escalation",
						)) && (
						<div className="mt-3 rounded-sm border border-[var(--warning-border)] bg-[var(--warning-surface)] px-4 py-3 text-sm text-[var(--status-warn)]">
							<span className="font-semibold">
								Needs attention:{" "}
								{run.data.openGates.map((gate) => gate.kind).join(", ")}
							</span>{" "}
							<button
								type="button"
								className="font-semibold underline"
								onClick={() =>
									setView(
										publication
											? "publication"
											: execution
												? execution.scope === "final"
													? "code-review"
													: "execution"
												: "decision",
									)
								}
							>
								{publication
									? "Open publication"
									: execution
										? "Open PR workspace"
										: "Review plan"}
							</button>
						</div>
					)}
			</section>
			<CostPanel key={runId} token={token} runId={runId} />
			<nav
				aria-label="Run views"
				className="flex flex-wrap gap-1 border-b border-[var(--line)]"
			>
				{(
					(publication
						? [
								["publication", "Publication"],
								["activity", "Activity view"],
							]
						: execution
							? [
									["execution", "Implementation"],
									["code-review", "Code review"],
									["activity", "Activity view"],
								]
							: [
									["swarm", "Swarm view"],
									["decision", "Plan"],
									["activity", "Activity view"],
								]) as readonly (readonly [
						(
							| "swarm"
							| "decision"
							| "activity"
							| "execution"
							| "code-review"
							| "publication"
						),
						string,
					])[]
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={selectedView === value}
						onClick={() => setView(value)}
						className={`min-h-11 border-b-2 px-4 text-sm font-semibold ${selectedView === value ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)]"}`}
					>
						{label}
					</button>
				))}
			</nav>
			{selectedView === "publication" && publication ? (
				<PublicationView
					token={token}
					runId={runId}
					publication={publication}
					canResume={run.data.openGates.some((g) =>
						g.allowedCommands.includes("resume"),
					)}
					onRefresh={() => run.refetch()}
				/>
			) : (selectedView === "execution" || selectedView === "code-review") &&
				execution ? (
				<ExecutionView
					activity={
						history.isPending ? (
							<WorkspaceMessage>Loading agent activity…</WorkspaceMessage>
						) : history.error ? (
							<HistoryError
								error={history.error}
								onRetry={() => void history.refetch()}
							/>
						) : (
							<SwarmView
								events={events}
								onOpenWorkspace={() => setView("activity")}
							/>
						)
					}
					view={selectedView === "code-review" ? "review" : "implementation"}
					execution={execution}
					gate={
						run.data.openGates.find(
							(gate) => gate.kind === "execution-escalation",
						) ?? null
					}
					token={token}
					onRefresh={async () => {
						await run.refetch();
					}}
					onSelectRun={onSelectRun}
				/>
			) : selectedView === "swarm" ? (
				history.isPending ? (
					<WorkspaceMessage>Loading activity…</WorkspaceMessage>
				) : history.error ? (
					<HistoryError
						error={history.error}
						onRetry={() => void history.refetch()}
					/>
				) : (
					<SwarmView
						events={events}
						onOpenWorkspace={() => setView("decision")}
					/>
				)
			) : (
				<>
					{!execution && !publication && (
						<div hidden={selectedView === "activity"}>
							<PlanReview
								token={token}
								runId={runId}
								onSelectRun={onSelectRun}
								onViewActivity={() => setView("activity")}
							/>
						</div>
					)}
					<div hidden={selectedView !== "activity"}>
						{history.isPending ? (
							<WorkspaceMessage>Loading activity…</WorkspaceMessage>
						) : history.error ? (
							<HistoryError
								error={history.error}
								onRetry={() => void history.refetch()}
							/>
						) : (
							<ActivityTimeline events={events} />
						)}
					</div>
				</>
			)}
		</div>
	);
}

function HistoryError({
	error,
	onRetry,
}: {
	error: Error;
	onRetry: () => void;
}) {
	return (
		<div
			className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-4 py-3 text-sm text-[var(--danger)]"
			role="alert"
		>
			<p>Could not load run activity: {error.message}</p>
			<Button
				className="mt-3 inline-flex"
				size="small"
				type="button"
				variant="quiet"
				onClick={onRetry}
			>
				Retry
			</Button>
		</div>
	);
}

function WorkspaceMessage({
	children,
	type = "status",
}: {
	children: ReactNode;
	type?: "status" | "alert";
}) {
	return (
		<p
			className={`rounded-sm border px-4 py-3 text-sm ${type === "alert" ? "border-[var(--danger-border)] bg-[var(--danger-surface)] text-[var(--danger)]" : "border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]"}`}
			role={type}
		>
			{children}
		</p>
	);
}

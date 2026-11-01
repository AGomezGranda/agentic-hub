import { PlanReview } from "@web/features/plan-review/PlanReview.tsx";
import { Button } from "@web/shared/ui/Button.tsx";
import { type ReactNode, useState } from "react";
import { ActivityTimeline } from "./ActivityTimeline.tsx";
import { StageStrip } from "./StageStrip.tsx";
import { SwarmView } from "./SwarmView.tsx";
import { useRunActivity } from "./useRunActivity.ts";

export function RunWorkspace({
	token,
	runId,
	onDisconnect,
}: {
	token: string;
	runId: string;
	onDisconnect: () => void;
}) {
	const [view, setView] = useState<"swarm" | "split" | "decision" | "activity">(
		"swarm",
	);
	const { run, history, connection, connectionError, events } = useRunActivity(
		token,
		runId,
	);

	if (run.isPending) return <WorkspaceMessage>Loading run…</WorkspaceMessage>;
	if (run.error)
		return (
			<WorkspaceMessage type="alert">
				Could not load this run: {run.error.message}
			</WorkspaceMessage>
		);
	if (!run.data) return <WorkspaceMessage>Run not found.</WorkspaceMessage>;

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
							: "Ended";

	return (
		<div className="min-w-0 space-y-5">
			<section className="border-b border-[var(--line)] pb-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0">
						<p className="mb-2 text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
							RUN WORKSPACE
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
					<div className="flex items-center gap-2">
						<span
							aria-live="polite"
							className={`rounded-sm px-3 py-1.5 text-xs font-semibold ${connection === "connected" ? "bg-[#edf5f0] text-[var(--status-good)]" : connection === "unauthorized" ? "bg-[#fff1eb] text-[#8d421f]" : "bg-[#f1f4f1] text-[var(--muted)]"}`}
						>
							{statusLabel}
						</span>
						<span className="rounded-sm border border-[var(--line)] px-3 py-1.5 text-xs font-semibold capitalize text-[var(--muted)]">
							{run.data.status === "active"
								? "Active"
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
				{connectionError ? (
					<p
						className={`mt-4 rounded-sm px-3 py-2.5 text-sm ${connection === "unauthorized" ? "border border-[#f1c6b3] bg-[#fff5ef] text-[#8d421f]" : "bg-[#f6f8f6] text-[var(--muted)]"}`}
						role={connection === "unauthorized" ? "alert" : "status"}
					>
						{connectionError}
					</p>
				) : null}
				<div className="mt-5">
					<StageStrip stage={run.data.stage} />
				</div>
				{run.data.openGates.length > 0 && (
					<div className="mt-3 rounded-sm border border-[var(--warning-border)] bg-[var(--warning-surface)] px-4 py-3 text-sm text-[var(--status-warn)]">
						<span className="font-semibold">
							Needs attention:{" "}
							{run.data.openGates.map((gate) => gate.kind).join(", ")}
						</span>{" "}
						<button
							type="button"
							className="font-semibold underline"
							onClick={() => setView("decision")}
						>
							Review decision
						</button>
					</div>
				)}
			</section>
			<nav
				aria-label="Run views"
				className="flex flex-wrap gap-1 border-b border-[var(--line)]"
			>
				{(
					[
						["swarm", "Swarm view"],
						["split", "Split view"],
						["decision", "Decision view"],
						["activity", "Activity view"],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						type="button"
						aria-pressed={view === value}
						onClick={() => setView(value)}
						className={`min-h-11 border-b-2 px-4 text-sm font-semibold ${view === value ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)]"}`}
					>
						{label}
					</button>
				))}
			</nav>
			{view === "swarm" ? (
				history.isPending ? (
					<WorkspaceMessage>Loading activity…</WorkspaceMessage>
				) : history.error ? (
					<WorkspaceMessage type="alert">
						Could not load run activity: {history.error.message}
					</WorkspaceMessage>
				) : (
					<SwarmView events={events} onOpenWorkspace={() => setView("split")} />
				)
			) : (
				<div
					className={
						view === "split"
							? "grid items-start gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
							: ""
					}
				>
					<div hidden={view === "activity"}>
						<PlanReview
							token={token}
							runId={runId}
							onViewActivity={() => setView("split")}
						/>
					</div>
					<div hidden={view === "decision"}>
						{history.isPending ? (
							<WorkspaceMessage>Loading activity…</WorkspaceMessage>
						) : history.error ? (
							<WorkspaceMessage type="alert">
								Could not load run activity: {history.error.message}
							</WorkspaceMessage>
						) : (
							<ActivityTimeline events={events} />
						)}
					</div>
				</div>
			)}
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
			className={`rounded-sm border px-4 py-3 text-sm ${type === "alert" ? "border-[#f1c6b3] bg-[#fff5ef] text-[#8d421f]" : "border-[var(--line)] bg-white text-[var(--muted)]"}`}
			role={type}
		>
			{children}
		</p>
	);
}

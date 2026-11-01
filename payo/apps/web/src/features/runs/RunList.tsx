import type { RunSummary } from "@payo/contracts";

export interface RunListProps {
	runs: RunSummary[];
	isPending: boolean;
	selectedRunId?: string;
	onSelect: (runId: string) => void;
}

export function RunList({
	runs,
	isPending,
	selectedRunId,
	onSelect,
}: RunListProps) {
	const groups: Array<[string, RunSummary[]]> = [
		["Needs you", runs.filter((run) => run.openGates.length > 0)],
		[
			"Active",
			runs.filter(
				(run) => run.status === "active" && run.openGates.length === 0,
			),
		],
		["Ended", runs.filter((run) => run.status === "ended")],
	];
	return (
		<section className="p-5">
			<div className="mb-4 flex items-center justify-between gap-3">
				<div>
					<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
						YOUR WORK
					</p>
					<h2 className="mt-1 text-base font-semibold">Recent runs</h2>
				</div>
				<span className="rounded-sm bg-[#f1f4f1] px-2.5 py-1 text-xs font-semibold text-[var(--muted)]">
					{runs.length} loaded runs
				</span>
			</div>
			{selectedRunId ? (
				<label className="mb-4 block sm:hidden">
					<span className="mb-2 block text-xs font-semibold">Select run</span>
					<select
						aria-label="Select run"
						className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-white px-3 text-sm"
						value={selectedRunId}
						onChange={(event) => onSelect(event.currentTarget.value)}
					>
						{runs.some((run) => run.runId === selectedRunId) ? null : (
							<option value={selectedRunId}>Current run</option>
						)}
						{runs.map((run) => (
							<option key={run.runId} value={run.runId}>
								{run.workItem?.title ?? run.runId} · {run.repo}
							</option>
						))}
					</select>
				</label>
			) : null}
			{isPending ? (
				<p className="rounded-sm bg-[#f6f8f6] px-3 py-4 text-sm text-[var(--muted)]">
					Loading runs…
				</p>
			) : (
				<div className="space-y-4">
					{runs.length === 0 ? (
						<p className="text-sm text-[var(--muted)]">No runs yet</p>
					) : null}
					{groups.map(([label, items]) => (
						<section key={label} aria-label={label}>
							<h3 className="mb-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[var(--muted)]">
								{label} · {items.length}
							</h3>
							<ul className="space-y-2">
								{items.map((run) => (
									<RunRow
										key={run.runId}
										run={run}
										selected={run.runId === selectedRunId}
										onSelect={onSelect}
									/>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
		</section>
	);
}

function RunRow({
	run,
	selected,
	onSelect,
}: {
	run: RunSummary;
	selected: boolean;
	onSelect: (runId: string) => void;
}) {
	const item = run.workItem;
	const subtitle =
		item?.key ?? (item?.source === "prompt" ? "Prompt" : run.runId);
	return (
		<li>
			<a
				aria-current={selected ? "page" : undefined}
				className={`run-row block border-l-2 px-3 py-3 no-underline transition-colors ${selected ? "border-[var(--accent)] bg-[#f1f8f4]" : "border-transparent hover:bg-[#f6f8f6]"}`}
				href={`/runs/${run.runId}`}
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
					onSelect(run.runId);
				}}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<p className="truncate text-sm font-semibold text-[var(--ink)]">
							{item?.title ?? "Work item unresolved"}
						</p>
						<p className="mt-1 truncate text-xs text-[var(--muted)]">
							{subtitle} · {run.repo}
						</p>
					</div>
					<span className="shrink-0 rounded-sm bg-[#f1f4f1] px-2 py-1 text-[10px] font-semibold text-[var(--muted)]">
						{run.stage ?? "Stage pending"}
					</span>
				</div>
				<p className="mt-2 text-[11px] text-[var(--muted)]">
					Base: {run.baseBranch}
				</p>
			</a>
		</li>
	);
}

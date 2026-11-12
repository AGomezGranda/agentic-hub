import type { RunSummary } from "@payo/contracts";
import { useState } from "react";

export interface RunListProps {
	runs: RunSummary[];
	isPending: boolean;
	errorMessage?: string;
	selectedRunId?: string;
	onSelect: (runId: string) => void;
}

type Grouping = "status" | "repository";
type WorkItem = { id: string; runs: [RunSummary, ...RunSummary[]] };
type RunGroup = { label: string; items: WorkItem[] };

function workStatus(item: WorkItem) {
	return item.runs.some((run) => run.openGates.length > 0)
		? "Needs you"
		: item.runs.some((run) => run.status === "active")
			? "Active"
			: "Ended";
}

function repositoryName(repo: string) {
	const segments = repo.split(/[\\/]/).filter(Boolean);
	return segments[segments.length - 1] ?? repo;
}

export function RunList({
	runs,
	isPending,
	errorMessage,
	selectedRunId,
	onSelect,
}: RunListProps) {
	const [grouping, setGrouping] = useState<Grouping>("status");
	const families = new Map<string, WorkItem>();
	for (const run of runs) {
		const id =
			run.publication?.sourceRunId ?? run.execution?.sourceRunId ?? run.runId;
		const family = families.get(id);
		if (!family) {
			families.set(id, { id, runs: [run] });
			continue;
		}
		if (run.execution || run.publication) family.runs.push(run);
		else family.runs.unshift(run);
		families.set(id, family);
	}
	const items = Array.from(families.values());
	const needsYouRuns = items.filter((item) => workStatus(item) === "Needs you");
	const activeRuns = items.filter((item) => workStatus(item) === "Active");
	let groups: RunGroup[];

	if (grouping === "status") {
		groups = [
			{ label: "Needs you", items: needsYouRuns },
			{ label: "Active", items: activeRuns },
			{
				label: "Ended",
				items: items.filter((item) => workStatus(item) === "Ended"),
			},
		];
	} else {
		const repositoryItems = new Map<string, WorkItem[]>();
		for (const item of items) {
			const repo = item.runs[0].repo;
			const groupItems = repositoryItems.get(repo) ?? [];
			groupItems.push(item);
			repositoryItems.set(repo, groupItems);
		}
		groups = Array.from(repositoryItems.entries())
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([repo, items]) => ({ label: repo, items }));
	}

	return (
		<section className="min-w-0 p-5">
			<div className="mb-4 flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
						YOUR WORK
					</p>
					<h2 className="mt-1 text-base font-semibold">Work items</h2>
				</div>
				<span className="shrink-0 rounded-sm bg-[var(--surface-raised)] px-2.5 py-1 text-xs font-semibold text-[var(--muted)]">
					{items.length} loaded work items
				</span>
			</div>
			<section
				aria-label="Loaded work summary"
				className="mb-4 grid grid-cols-2 gap-2"
			>
				<div className="rounded-sm border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
					<p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
						Needs you
					</p>
					<p className="mt-1 text-lg font-semibold leading-none text-[var(--ink)]">
						{needsYouRuns.length}
					</p>
				</div>
				<div className="rounded-sm border border-[var(--line)] bg-[var(--surface)] px-3 py-2">
					<p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
						Active
					</p>
					<p className="mt-1 text-lg font-semibold leading-none text-[var(--ink)]">
						{activeRuns.length}
					</p>
				</div>
			</section>
			<fieldset className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				<legend className="mb-2 text-xs font-semibold text-[var(--muted)]">
					Group work by
				</legend>
				{(["status", "repository"] as const).map((mode) => (
					<label
						key={mode}
						className={`inline-flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 font-semibold focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)] ${grouping === mode ? "bg-[var(--surface-raised)] text-[var(--accent)]" : "text-[var(--muted)] hover:bg-[var(--surface-raised)]"}`}
					>
						<input
							className="size-4 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
							type="radio"
							name="run-grouping"
							value={mode}
							checked={grouping === mode}
							onChange={() => setGrouping(mode)}
						/>
						{mode === "status" ? "Status" : "Repository"}
					</label>
				))}
			</fieldset>
			{selectedRunId ? (
				<label className="mb-4 block sm:hidden">
					<span className="mb-2 block text-xs font-semibold">Select run</span>
					<select
						aria-label="Select run"
						className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
						value={selectedRunId}
						onChange={(event) => onSelect(event.currentTarget.value)}
					>
						{runs.some((run) => run.runId === selectedRunId) ? null : (
							<option value={selectedRunId}>Current run</option>
						)}
						{items.map((item) => (
							<optgroup
								key={item.id}
								label={item.runs[0].workItem?.title ?? item.id}
							>
								{item.runs.map((run) => (
									<option key={run.runId} value={run.runId}>
										{run.publication
											? "Publication"
											: run.execution
												? `PR workspace ${run.execution.prId}`
												: "Plan"}{" "}
										· {run.repo}
									</option>
								))}
							</optgroup>
						))}
					</select>
				</label>
			) : null}
			{isPending ? (
				<p className="rounded-sm bg-[var(--surface-raised)] px-3 py-4 text-sm text-[var(--muted)]">
					Loading runs…
				</p>
			) : (
				<div className="min-w-0 space-y-4">
					{errorMessage ? (
						<p className="text-sm text-[var(--danger)]">{errorMessage}</p>
					) : runs.length === 0 ? (
						<p className="text-sm text-[var(--muted)]">No runs yet</p>
					) : null}
					{groups.map(({ label, items: groupItems }) => (
						<section key={label} aria-label={label} className="min-w-0">
							<h3
								className={`mb-2 text-[10px] font-bold text-[var(--muted)] ${grouping === "status" ? "uppercase tracking-[0.13em]" : "break-all tracking-normal"}`}
							>
								{grouping === "status" ? (
									<>
										{label} · {groupItems.length}
									</>
								) : (
									<>
										<span className="block text-sm font-semibold leading-5 text-[var(--ink)]">
											{repositoryName(label)}
										</span>
										<span className="mt-0.5 block break-all text-[10px] font-normal tracking-normal text-[var(--muted)]">
											{label}
										</span>
										<span className="mt-1 block font-semibold">
											{groupItems.length}{" "}
											{groupItems.length === 1 ? "work item" : "work items"}
										</span>
									</>
								)}
							</h3>
							<ul className="min-w-0 space-y-2">
								{groupItems.map((item) => {
									const first = item.runs[0];
									if (item.runs.length === 1 && !first.execution)
										return (
											<RunRow
												key={item.id}
												run={first}
												selected={first.runId === selectedRunId}
												showRepository={grouping === "status"}
												onSelect={onSelect}
											/>
										);
									return (
										<li
											key={item.id}
											className="min-w-0 rounded-sm border border-[var(--line)] p-3"
										>
											<p className="text-sm font-semibold">
												{first.workItem?.title ?? "Work item unresolved"}
											</p>
											<p className="mt-1 text-xs text-[var(--muted)]">
												{workStatus(item)}
												{grouping === "status" ? ` · ${first.repo}` : ""}
											</p>
											{(first.execution || first.publication) && (
												<p className="mt-2 text-xs text-[var(--muted)]">
													Source plan is not in the loaded results.
												</p>
											)}
											<ul className="mt-2 border-l border-[var(--line)] pl-2">
												{item.runs.map((run) => (
													<RunRow
														key={run.runId}
														run={run}
														selected={run.runId === selectedRunId}
														showRepository={false}
														nested
														onSelect={onSelect}
													/>
												))}
											</ul>
										</li>
									);
								})}
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
	showRepository,
	nested = false,
	onSelect,
}: {
	run: RunSummary;
	selected: boolean;
	showRepository: boolean;
	nested?: boolean;
	onSelect: (runId: string) => void;
}) {
	const item = run.workItem;
	const title = nested
		? run.publication
			? "Publication"
			: run.execution
				? `PR workspace ${run.execution.prId}`
				: "Plan"
		: (item?.title ?? "Work item unresolved");
	const subtitle =
		item?.key ?? (item?.source === "prompt" ? "Prompt" : run.runId);
	const openGateCount = run.openGates.length;
	const status =
		openGateCount > 0
			? "Needs you"
			: run.status === "active"
				? "Active"
				: "Ended";
	const statusStyle =
		status === "Needs you"
			? "bg-[var(--warning-surface)] text-[var(--status-warn)]"
			: status === "Active"
				? "bg-[var(--surface-raised)] text-[var(--status-good)]"
				: "bg-[var(--surface-raised)] text-[var(--status-done)]";

	return (
		<li className="min-w-0">
			<a
				aria-current={selected ? "page" : undefined}
				className={`run-row block min-w-0 border-l-2 px-3 py-3 no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${selected ? "border-[var(--accent)] bg-[var(--accent-surface)]" : "border-transparent hover:bg-[var(--surface-raised)]"}`}
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
				<div className="min-w-0">
					<p
						title={title}
						className="truncate text-sm font-semibold text-[var(--ink)]"
					>
						{title}
					</p>
					<p className="mt-1 min-w-0 truncate text-xs text-[var(--muted)]">
						{subtitle}
						{run.execution && !nested
							? ` · PR workspace ${run.execution.prId}`
							: ""}
						{showRepository ? (
							<>
								{" · "}
								<span className="truncate" title={run.repo}>
									{run.repo}
								</span>
							</>
						) : null}
					</p>
				</div>
				<div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
					<span
						className={`inline-flex max-w-full items-center gap-1.5 rounded-sm px-2 py-1 text-[10px] font-semibold ${statusStyle}`}
					>
						<span
							aria-hidden="true"
							className={`size-1.5 shrink-0 rounded-full ${status === "Needs you" ? "bg-[var(--status-warn)]" : status === "Active" ? "bg-[var(--status-good)]" : "bg-[var(--status-done)]"}`}
						/>
						<span className="truncate">
							{status}
							{openGateCount > 0
								? ` · ${openGateCount} open ${openGateCount === 1 ? "gate" : "gates"}`
								: ""}
						</span>
					</span>
					<span
						title={run.execution?.stage ?? run.stage ?? "Stage pending"}
						className="max-w-full truncate rounded-sm bg-[var(--surface-raised)] px-2 py-1 text-[10px] font-semibold text-[var(--muted)]"
					>
						{run.execution?.stage ?? run.stage ?? "Stage pending"}
					</span>
				</div>
				<p className="mt-2 break-all text-[11px] text-[var(--muted)]">
					Base: {run.baseBranch}
				</p>
			</a>
		</li>
	);
}

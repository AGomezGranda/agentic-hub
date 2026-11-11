import { lineDiff, type PlanVersionDetail } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";
import { Markdown } from "@web/shared/ui/Markdown.tsx";
import { useState } from "react";

export function PlanHistory({
	versions,
	loading,
	error,
	onRetry,
	onBack,
	canRestore,
	busy,
	onRestore,
}: {
	versions: PlanVersionDetail[];
	loading: boolean;
	error: boolean;
	onRetry: () => void;
	onBack: () => void;
	canRestore: boolean;
	busy: boolean;
	onRestore: (version: number) => void;
}) {
	const [selected, setSelected] = useState<number>();
	const [baseline, setBaseline] = useState<number>();
	const [compare, setCompare] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const ordered = [...versions].sort((a, b) => b.number - a.number);
	const target = ordered.find((v) => v.number === selected) ?? ordered[0];
	const before =
		ordered.find((v) => v.number === baseline && v.number !== target?.number) ??
		ordered.find((v) => v.number < (target?.number ?? 0)) ??
		ordered.find((v) => v.number !== target?.number);
	function selectVersion(version: number) {
		setSelected(version);
		setBaseline(undefined);
		setConfirm(false);
	}
	return (
		<section aria-label="Plan version history" className="space-y-4">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<p className="console-eyebrow">PLAN ARCHIVE</p>
					<h2 className="text-xl font-semibold">History</h2>
					<p className="text-sm text-[var(--muted)]">
						Saved snapshots. The working plan may contain newer edits.
					</p>
				</div>
				<Button variant="secondary" onClick={onBack}>
					Back to review
				</Button>
			</header>
			{loading ? (
				<p role="status">Loading plan history…</p>
			) : error ? (
				<div role="alert">
					Could not load plan history.{" "}
					<Button variant="secondary" onClick={onRetry}>
						Retry history
					</Button>
				</div>
			) : !target ? (
				<p className="border border-[var(--line)] p-6 text-[var(--muted)]">
					No saved versions yet.
				</p>
			) : (
				<div className="grid border border-[var(--line)] bg-[var(--surface)] md:grid-cols-[14rem_minmax(0,1fr)]">
					<aside
						aria-label="Saved versions"
						className="border-b border-[var(--line)] p-3 md:border-r md:border-b-0"
					>
						<p className="console-eyebrow mb-3">VERSIONS · {versions.length}</p>
						<ul className="space-y-2">
							{ordered.map((v) => (
								<li
									key={v.number}
									className={
										v.number === target.number
											? "border-l-2 border-[var(--accent)] bg-[var(--accent-surface)] p-2"
											: "border-l-2 border-transparent p-2"
									}
								>
									<Button
										className="w-full justify-start"
										variant="quiet"
										aria-pressed={v.number === target.number}
										onClick={() => selectVersion(v.number)}
									>
										Version {v.number} · {v.source}
									</Button>
								</li>
							))}
						</ul>
					</aside>
					<div className="min-w-0">
						<header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] p-4">
							<div>
								<p className="console-eyebrow">
									SAVED SNAPSHOT · {target.source}
								</p>
								<h3 className="font-semibold">Version {target.number}</h3>
							</div>
							<div className="flex gap-2">
								<Button
									size="small"
									variant={compare ? "quiet" : "primary"}
									aria-pressed={!compare}
									onClick={() => setCompare(false)}
								>
									Read
								</Button>
								<Button
									size="small"
									variant={compare ? "primary" : "quiet"}
									aria-pressed={compare}
									disabled={versions.length < 2}
									onClick={() => setCompare(true)}
								>
									Compare
								</Button>
							</div>
						</header>
						{compare ? (
							<>
								<div className="grid grid-cols-1 items-end gap-3 border-b border-[var(--line)] bg-[var(--canvas)] p-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
									<label className="grid min-w-0 gap-2 text-xs text-[var(--muted)]">
										From
										<select
											className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)]"
											value={before?.number ?? ""}
											onChange={(event) =>
												setBaseline(Number(event.target.value))
											}
										>
											{ordered
												.filter((v) => v.number !== target.number)
												.map((v) => (
													<option key={v.number} value={v.number}>
														Version {v.number} · {v.source}
													</option>
												))}
										</select>
									</label>
									<span
										aria-hidden="true"
										className="hidden pb-3 text-[var(--muted)] sm:block"
									>
										→
									</span>
									<label className="grid min-w-0 gap-2 text-xs text-[var(--muted)]">
										To
										<select
											className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--surface)] px-3 text-sm text-[var(--ink)]"
											value={target.number}
											onChange={(event) =>
												selectVersion(Number(event.target.value))
											}
										>
											{ordered.map((v) => (
												<option key={v.number} value={v.number}>
													Version {v.number} · {v.source}
												</option>
											))}
										</select>
									</label>
								</div>
								{before ? (
									<PlanComparison before={before} after={target} />
								) : null}
							</>
						) : (
							<div className="p-4 sm:p-6">
								<Markdown>{target.markdown}</Markdown>
							</div>
						)}
						{canRestore ? (
							<footer className="space-y-3 border-t border-[var(--line)] p-4">
								{confirm ? (
									<>
										<p className="text-sm">
											Restoring creates a new version and runs review again.
										</p>
										<div className="flex gap-2">
											<Button
												disabled={busy}
												onClick={() => onRestore(target.number)}
											>
												Confirm restore
											</Button>
											<Button
												variant="quiet"
												disabled={busy}
												onClick={() => setConfirm(false)}
											>
												Cancel restore
											</Button>
										</div>
									</>
								) : (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() => setConfirm(true)}
									>
										Restore this version
									</Button>
								)}
							</footer>
						) : null}
					</div>
				</div>
			)}
		</section>
	);
}

function PlanComparison({
	before,
	after,
}: {
	before: PlanVersionDetail;
	after: PlanVersionDetail;
}) {
	const diff = lineDiff(before.markdown, after.markdown);
	const lines = before.markdown.split("\n");
	const prefix = lines.slice(0, diff.prefixLines).join("\n");
	const suffix = lines.slice(diff.prefixLines + diff.removed.length).join("\n");
	const changed = diff.removed.length > 0 || diff.added.length > 0;
	return (
		<div className="space-y-3 p-4">
			{!changed ? (
				<p>No changes between these versions.</p>
			) : (
				<>
					<p className="text-xs text-[var(--muted)]">
						Changed blocks include any unchanged lines between edits.
					</p>
					{prefix ? (
						<pre className="whitespace-pre-wrap break-words text-xs text-[var(--muted)]">
							{prefix}
						</pre>
					) : null}
					<div className="grid gap-px bg-[var(--line)] md:grid-cols-2">
						<div className="min-w-0 bg-[var(--danger-surface)] p-3">
							<h5 className="mb-3 text-xs font-semibold">
								− Before · v{before.number}
							</h5>
							<pre className="whitespace-pre-wrap break-words text-xs">
								{diff.removed.map((l) => `− ${l}`).join("\n") ||
									"No removed lines"}
							</pre>
						</div>
						<div className="min-w-0 bg-[var(--success-surface)] p-3">
							<h5 className="mb-3 text-xs font-semibold">
								+ After · v{after.number}
							</h5>
							<pre className="whitespace-pre-wrap break-words text-xs">
								{diff.added.map((l) => `+ ${l}`).join("\n") || "No added lines"}
							</pre>
						</div>
					</div>
					{suffix ? (
						<pre className="whitespace-pre-wrap break-words text-xs text-[var(--muted)]">
							{suffix}
						</pre>
					) : null}
				</>
			)}
		</div>
	);
}

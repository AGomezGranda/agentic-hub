import type { ExecutionSummary, Finding } from "@payo/contracts";

type Review = NonNullable<ExecutionSummary["review"]>;

export function ExecutionReview({ review }: { review: Review | null }) {
	const details = review?.details;
	const findings = details?.findings ?? review?.blockers ?? [];
	const verdicts = details?.verdicts ?? [];
	const ordered = [...findings].sort(
		(a, b) =>
			Number(
				verdicts.some(
					(v) => v.sourceIds.includes(b.id) && v.classification === "BLOCKER",
				),
			) -
				Number(
					verdicts.some(
						(v) => v.sourceIds.includes(a.id) && v.classification === "BLOCKER",
					),
				) || a.severity.localeCompare(b.severity),
	);
	return (
		<section className="execution-panel" aria-label="Latest review">
			<p className="execution-label">Code review</p>
			<h3>Findings and verification</h3>
			{!review ? (
				<p>No review evidence available</p>
			) : (
				<>
					<p>
						{details?.round != null
							? `Round ${details.round}`
							: "Review round unavailable"}{" "}
						· {review.findings} findings
					</p>
					<p className="text-[var(--muted)]">
						Current execution: {review.unresolved} unresolved. Review evidence
						describes a saved snapshot and may precede the current work.
					</p>
					{details?.discarded && (
						<p
							role="status"
							className="mt-4 border border-[var(--warning-border)] bg-[var(--warning-surface)] p-3 text-[var(--status-warn)]"
						>
							Evidence discarded: the workspace changed during review. These
							findings cannot establish approval.
						</p>
					)}
					{ordered.length ? (
						<ul className="mt-5 space-y-3">
							{ordered.map((finding) => {
								const matching = verdicts.filter((v) =>
									v.sourceIds.includes(finding.id),
								);
								const dismissed =
									matching.length > 0 &&
									matching.every((v) => v.classification !== "BLOCKER");
								return (
									<li
										key={finding.id}
										className="border border-[var(--line)] p-4"
									>
										{dismissed ? (
											<details>
												<summary className="cursor-pointer text-[var(--accent)]">
													{finding.severity} · {finding.title} ·{" "}
													{matching.map((v) => v.classification).join(", ")}
												</summary>
												<FindingEvidence finding={finding} />
											</details>
										) : (
											<>
												<div className="flex flex-wrap items-baseline gap-2">
													<span className="execution-label text-[var(--danger)]">
														{finding.severity}
													</span>
													<h4 className="font-semibold">{finding.title}</h4>
													<span className="text-xs text-[var(--muted)]">
														{matching.some(
															(v) => v.classification === "BLOCKER",
														)
															? "Verified blocker"
															: "Verification unavailable"}
													</span>
												</div>
												<FindingEvidence finding={finding} />
											</>
										)}
										{matching.length > 0 && (
											<details className="mt-3">
												<summary className="cursor-pointer text-[var(--accent)]">
													Verifier reasoning
												</summary>
												<ul className="mt-3 space-y-3">
													{matching.map((verdict) => (
														<li key={verdict.sourceIds.join(",")}>
															<p className="execution-label">
																{verdict.classification}
															</p>
															<p className="mt-1 whitespace-pre-wrap">
																{verdict.reason}
															</p>
															{verdict.counterEvidence && (
																<p className="mt-2 whitespace-pre-wrap text-[var(--muted)]">
																	Counter-evidence: {verdict.counterEvidence}
																</p>
															)}
														</li>
													))}
												</ul>
											</details>
										)}
									</li>
								);
							})}
						</ul>
					) : (
						<p>
							{review.findings
								? "Finding details are unavailable for this saved review."
								: "No findings recorded. Coverage and evidence validity still determine whether review is complete."}
						</p>
					)}
				</>
			)}
		</section>
	);
}

function FindingEvidence({ finding }: { finding: Finding }) {
	return (
		<>
			{finding.path && (
				<code className="mt-2 block break-all text-xs text-[var(--muted)]">
					{finding.path}
					{finding.line ? `:${finding.line}` : ""}
				</code>
			)}
			<dl className="mt-3 space-y-3">
				{[
					["Evidence", finding.evidence],
					["Consequence", finding.consequence],
					["Suggested fix", finding.suggestedFix],
				].map(([label, text]) => (
					<div key={label}>
						<dt className="font-semibold">{label}</dt>
						<dd className="mt-1 whitespace-pre-wrap text-[var(--muted)]">
							{text}
						</dd>
					</div>
				))}
			</dl>
		</>
	);
}

export function ExecutionReviewContext({ review }: { review: Review }) {
	const details = review.details;
	return (
		<>
			<section className="execution-panel" aria-label="Review coverage">
				<h3>Review coverage</h3>
				{review.uncheckedLenses.length > 0 && (
					<div className="mt-3 border border-[var(--warning-border)] bg-[var(--warning-surface)] p-3 text-[var(--status-warn)]">
						<p>Unchecked lenses</p>
						<ul className="mt-2 space-y-1">
							{review.uncheckedLenses.map((lens) => (
								<li key={lens}>{lens}</li>
							))}
						</ul>
					</div>
				)}
				<ul className="mt-3 space-y-3">
					{review.lenses.map((lens) => {
						const checked =
							details?.coverage.find((item) => item.lens === lens)?.checked ??
							[];
						return (
							<li key={lens} className="border-t border-[var(--line)] pt-3">
								<p className="font-semibold">{lens}</p>
								<p className="text-xs text-[var(--muted)]">
									{review.uncheckedLenses.includes(lens)
										? "Incomplete"
										: "Report recorded"}
								</p>
								{checked.length > 0 && (
									<details className="mt-2">
										<summary className="cursor-pointer text-[var(--accent)]">
											Recorded checks ({checked.length})
										</summary>
										<ul className="mt-2 list-inside list-disc space-y-1 text-[var(--muted)]">
											{checked.map((check) => (
												<li key={check}>{check}</li>
											))}
										</ul>
									</details>
								)}
							</li>
						);
					})}
				</ul>
				{!review.lenses.length && <p>No lens reports available.</p>}
			</section>
			<section
				className="execution-panel execution-worktree"
				aria-label="Review context"
			>
				<h3>Review context</h3>
				<p>
					Reviewed scope:{" "}
					<span>
						{details?.scope === "final"
							? "Final PR review"
							: details?.scope === "phase"
								? details.phaseIndex != null
									? `Phase ${details.phaseIndex + 1}`
									: "Phase review"
								: "Unavailable"}
					</span>
				</p>
				<p>
					Starting commit: <span>{details?.startCommit ?? "Unavailable"}</span>
				</p>
				<p>
					Evidence:{" "}
					<span>
						{details?.discarded
							? "Discarded"
							: details
								? "Saved snapshot; current workspace not verified"
								: "Provenance unavailable"}
					</span>
				</p>
				{details?.fingerprint && (
					<details className="mt-3">
						<summary className="cursor-pointer text-[var(--accent)]">
							Snapshot fingerprint
						</summary>
						<code className="mt-2 block break-all text-xs">
							{details.fingerprint}
						</code>
					</details>
				)}
			</section>
		</>
	);
}

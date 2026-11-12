import type { ExecutionSummary } from "@payo/contracts";

export function ExecutionProgress({
	execution,
}: {
	execution: ExecutionSummary;
}) {
	const phases = execution.phases ?? [];
	const final = execution.scope === "final";
	const running = execution.status === "active";
	return (
		<section className="workspace-panel" aria-label="Implementation progress">
			<div className="execution-section-title">
				<h3>Implementation progress</h3>
				<span>
					{execution.completedPhases.length} / {phases.length}
				</span>
			</div>
			<ol className="execution-nodes">
				{phases.map((phase, index) => {
					const receipt = execution.completedPhases.find(
						(item) => item.id === phase.id,
					);
					const active =
						running &&
						!final &&
						execution.stage !== "Prepare" &&
						execution.pausedOperation !== "Prepare" &&
						execution.phaseIndex === index;
					const state = receipt ? "complete" : active ? "active" : "pending";
					return (
						<li
							key={phase.id}
							className="execution-node"
							data-state={state}
							aria-current={active ? "step" : undefined}
						>
							<div className="execution-node-top">
								<span className="workspace-label">Phase {index + 1}</span>
								<span aria-hidden="true" className="execution-node-dot" />
							</div>
							<h4>{phase.title}</h4>
							<p className="execution-node-status">
								{receipt
									? "Completed"
									: active
										? execution.stage === "Escalated"
											? "Awaiting input"
											: execution.stage
										: running
											? "Upcoming"
											: "Not completed"}
							</p>
							{receipt ? (
								<div className="execution-node-receipt">
									<span className="workspace-label">Commit</span>
									<code>{receipt.resultCommit}</code>
								</div>
							) : null}
						</li>
					);
				})}
				<li
					className="execution-node"
					data-state={
						execution.outcome === "reviewed"
							? "complete"
							: final && running
								? "active"
								: "pending"
					}
					aria-current={final && running ? "step" : undefined}
				>
					<div className="execution-node-top">
						<span className="workspace-label">Final checkpoint</span>
						<span aria-hidden="true" className="execution-node-dot" />
					</div>
					<h4>Final PR review</h4>
					<p className="execution-node-status">
						{final
							? running
								? execution.stage
								: (execution.outcome ?? "Ended")
							: running
								? "Upcoming"
								: "Not started"}
					</p>
				</li>
			</ol>
		</section>
	);
}

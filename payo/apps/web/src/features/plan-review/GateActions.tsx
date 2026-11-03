import type { OpenQuestion, RunSummary } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useState } from "react";

export type GateCommand = "approve" | "requestChanges" | "resume";

export function GateActions({
	run,
	questions,
	answers,
	decisionAvailable,
	busy,
	onCommand,
}: {
	run: RunSummary;
	questions: readonly OpenQuestion[];
	answers: Record<string, string>;
	decisionAvailable: boolean;
	busy: boolean;
	onCommand: (command: GateCommand) => void;
}) {
	const approval = run.openGates.find((gate) => gate.kind === "approval");
	const escalation = run.openGates.find(
		(gate) => gate.kind === "factory-escalation",
	);
	const [confirmingGate, setConfirmingGate] = useState<string | null>(null);
	const confirming =
		approval !== undefined && confirmingGate === approval.gateId;
	if (!approval && !escalation) return null;

	const unanswered = questions.filter(
		(question) => !answers[question.id]?.trim(),
	);
	const canApprove = approval?.allowedCommands.includes("approve") ?? false;
	const canRequestChanges =
		approval?.allowedCommands.includes("requestChanges") ?? false;
	const canResume = escalation?.allowedCommands.includes("resume") ?? false;

	return (
		<section
			aria-label="Gate actions"
			className="border-b border-[var(--line)] pb-6"
		>
			<div>
				<p className="text-[10px] font-bold tracking-[0.14em] text-[var(--muted)]">
					{escalation ? "NEEDS ATTENTION" : "YOUR DECISION"}
				</p>
				<h2 className="mt-1 text-lg font-semibold">
					{escalation ? "Run escalated" : "Plan approval"}
				</h2>
				{escalation?.reason ? (
					<p className="mt-2 text-sm text-[var(--muted)]">
						{escalation.reason}
					</p>
				) : null}
			</div>

			{approval && unanswered.length > 0 ? (
				<p className="mt-4 rounded-sm border border-[var(--warning-border)] bg-[var(--warning-surface)] px-3 py-2.5 text-sm text-[var(--status-warn)]">
					Answer every open question before approving. {unanswered.length}{" "}
					unanswered.
				</p>
			) : null}
			{approval && !decisionAvailable ? (
				<p className="mt-3 text-sm text-[var(--danger)]">
					Refresh the plan and review before making a decision.
				</p>
			) : null}

			<div className="mt-5 flex flex-wrap gap-2">
				{canApprove && confirming ? (
					<>
						<Button
							disabled={busy || !decisionAvailable || unanswered.length > 0}
							onClick={() => onCommand("approve")}
							type="button"
						>
							{busy ? "Working…" : "Confirm approve and end the run"}
						</Button>
						<Button
							disabled={busy}
							onClick={() => setConfirmingGate(null)}
							type="button"
							variant="secondary"
						>
							Cancel
						</Button>
					</>
				) : null}
				{canApprove && !confirming ? (
					<Button
						disabled={busy || !decisionAvailable || unanswered.length > 0}
						onClick={() => setConfirmingGate(approval?.gateId ?? null)}
						type="button"
					>
						Approve and end the run
					</Button>
				) : null}
				{canRequestChanges ? (
					<Button
						disabled={busy || !decisionAvailable}
						onClick={() => onCommand("requestChanges")}
						type="button"
						variant="secondary"
					>
						Request changes
					</Button>
				) : null}
				{canResume ? (
					<Button
						disabled={busy}
						onClick={() => onCommand("resume")}
						type="button"
					>
						Resume run
					</Button>
				) : null}
			</div>
			{canRequestChanges ? (
				<p className="mt-3 text-xs text-[var(--muted)]">
					Request changes saves your editor changes and answers, then reruns
					review. Use Revise plan to give the agent new instructions.
				</p>
			) : null}
			{approval ? (
				<p className="mt-4 text-xs leading-5 text-[var(--muted)]">
					Approval ends this run and removes its worktree. The server uses the
					plan file as it exists when the command runs.
				</p>
			) : null}
		</section>
	);
}

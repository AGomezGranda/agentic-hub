import type { OpenQuestion, RunSummary } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";

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
				<p className="mt-4 rounded-sm border border-[#ead9ad] bg-[#fff9e9] px-3 py-2.5 text-sm text-[#765b1d]">
					Answer every open question before approving. {unanswered.length}{" "}
					unanswered.
				</p>
			) : null}
			{approval && !decisionAvailable ? (
				<p className="mt-3 text-sm text-[#8d421f]">
					Refresh the plan and review before making a decision.
				</p>
			) : null}

			<div className="mt-5 flex flex-wrap gap-2">
				{canApprove ? (
					<Button
						disabled={busy || !decisionAvailable || unanswered.length > 0}
						onClick={() => onCommand("approve")}
						type="button"
					>
						{busy ? "Working…" : "Approve and end the run"}
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
			{approval ? (
				<p className="mt-4 text-xs leading-5 text-[var(--muted)]">
					Approval ends this run and removes its worktree. The server uses the
					plan file as it exists when the command runs.
				</p>
			) : null}
		</section>
	);
}

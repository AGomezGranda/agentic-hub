import type { WorkItemRequest } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";
import { type FormEvent, type ReactNode, useState } from "react";
import type { NewRunInput } from "./api.ts";

export function NewRunForm({
	isPending,
	error,
	onStart,
}: {
	isPending: boolean;
	error: unknown;
	onStart: (input: NewRunInput) => void;
}) {
	const [source, setSource] = useState<"jira" | "prompt">("jira");
	const [jiraKey, setJiraKey] = useState("");
	const [prompt, setPrompt] = useState("");
	const [repo, setRepo] = useState("");
	const [baseBranch, setBaseBranch] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setLocalError(null);
		let workItemRequest: WorkItemRequest;
		if (source === "jira") {
			const key = jiraKey.trim();
			if (!key) {
				setLocalError("Enter a Jira key to start a run.");
				return;
			}
			workItemRequest = { source: "jira", key };
		} else {
			if (!prompt.trim()) {
				setLocalError("Describe the work to start a prompt run.");
				return;
			}
			workItemRequest = { source: "prompt", text: prompt };
		}
		onStart({
			workItemRequest,
			...(repo.trim() ? { repo: repo.trim() } : {}),
			...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
		});
	}

	const errorMessage =
		localError ?? (error instanceof Error ? error.message : null);
	return (
		<form className="space-y-5" onSubmit={submit}>
			<fieldset className="inline-flex rounded-sm bg-[#f1f5f2] p-1">
				<legend className="sr-only">Work-item type</legend>
				{(["jira", "prompt"] as const).map((choice) => (
					<Button
						key={choice}
						aria-pressed={source === choice}
						className={source === choice ? "shadow-sm" : ""}
						size="small"
						type="button"
						variant={source === choice ? "secondary" : "quiet"}
						onClick={() => {
							setSource(choice);
							setLocalError(null);
						}}
					>
						{choice === "jira" ? "Jira issue" : "Prompt"}
					</Button>
				))}
			</fieldset>

			{source === "jira" ? (
				<Field label="Jira key" htmlFor="jira-key" hint="For example, ABC-123">
					<input
						className={inputClass}
						id="jira-key"
						name="ticketKey"
						onChange={(event) => setJiraKey(event.currentTarget.value)}
						placeholder="ABC-123"
						required
						value={jiraKey}
					/>
				</Field>
			) : (
				<Field
					label="Prompt"
					htmlFor="work-prompt"
					hint="Describe the outcome you want."
				>
					<textarea
						className={`${inputClass} min-h-32 resize-y py-3`}
						id="work-prompt"
						name="prompt"
						onChange={(event) => setPrompt(event.currentTarget.value)}
						placeholder="What should Payo work on?"
						required
						value={prompt}
					/>
				</Field>
			)}

			<div className="grid gap-4 sm:grid-cols-2">
				<Field
					label="Repository override (optional)"
					htmlFor="repo-path"
					hint="Absolute path on this machine."
				>
					<input
						className={inputClass}
						id="repo-path"
						name="repo"
						onChange={(event) => setRepo(event.currentTarget.value)}
						placeholder="/path/to/repository"
						value={repo}
					/>
				</Field>
				<Field
					label="Base branch override (optional)"
					htmlFor="base-branch"
					hint="Defaults to the server setting."
				>
					<input
						className={inputClass}
						id="base-branch"
						name="baseBranch"
						onChange={(event) => setBaseBranch(event.currentTarget.value)}
						placeholder="main"
						value={baseBranch}
					/>
				</Field>
			</div>

			{errorMessage ? (
				<p
					role="alert"
					className="rounded-sm border border-[#f1c6b3] bg-[#fff5ef] px-3 py-2.5 text-sm text-[#8d421f]"
				>
					{errorMessage}
				</p>
			) : null}

			<div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-5">
				<p className="text-xs text-[var(--muted)]">
					The server validates repository and branch settings.
				</p>
				<Button type="submit" disabled={isPending}>
					{isPending ? "Starting…" : "Start run"}
				</Button>
			</div>
		</form>
	);
}

const inputClass =
	"min-h-11 w-full rounded-sm border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-[#a0ada8] focus:border-[var(--accent)] focus:ring-2 focus:ring-[#176b5720]";

function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint: string;
	children: ReactNode;
}) {
	return (
		<div className="space-y-2">
			<label htmlFor={htmlFor} className="block text-sm font-semibold">
				{label}
			</label>
			{children}
			<p className="text-xs text-[var(--muted)]">{hint}</p>
		</div>
	);
}

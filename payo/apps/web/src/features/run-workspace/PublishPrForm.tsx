import type { PublicationPreview } from "@payo/contracts";
import { Button } from "@web/shared/ui/Button.tsx";
import { useId, useRef, useState } from "react";
import { previewPublication, publishRun } from "./api.ts";

export function PublishPrForm({
	token,
	runId,
	onSelectRun,
}: {
	token: string;
	runId: string;
	onSelectRun: (id: string) => void;
}) {
	const [preview, setPreview] = useState<PublicationPreview | null>(null);
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [pending, setPending] = useState<"preview" | "publish" | null>(null);
	const editorId = useId();
	const previewButton = useRef<HTMLButtonElement>(null);
	const [error, setError] = useState<string | null>(null);
	async function act(publish: boolean) {
		setPending(publish ? "publish" : "preview");
		setError(null);
		try {
			if (publish && preview?.previewHash) {
				const child = await publishRun(token, runId, {
					previewHash: preview.previewHash,
					title,
					body,
				});
				onSelectRun(child.runId);
			} else {
				const result = await previewPublication(token, runId);
				setPreview(result);
				setTitle(result.title ?? "");
				setBody(result.body ?? "");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(null);
		}
	}
	return (
		<section aria-label="GitHub handoff" className="pr-handoff">
			<p className="workspace-label">NEXT ACTION · GITHUB</p>
			<div className="execution-section-title mt-2">
				<h3>Create a draft pull request</h3>
				<Button
					type="button"
					variant={preview ? "secondary" : "primary"}
					disabled={pending !== null}
					aria-expanded={preview !== null}
					aria-controls={editorId}
					ref={previewButton}
					onClick={() => void act(false)}
				>
					{preview ? "Refresh preview" : "Review draft PR →"}
				</Button>
			</div>
			<p className="mt-2 text-[var(--muted)]">
				Pushes the reviewed commit and opens a draft PR on GitHub.
			</p>
			{pending && (
				<p role="status" className="mt-3 text-[var(--muted)]">
					{pending === "preview" ? "Checking draft PR…" : "Creating draft PR…"}
				</p>
			)}
			{error && (
				<p role="alert" className="mt-3 break-words text-[var(--danger)]">
					{error}
				</p>
			)}
			<div id={editorId} hidden={!preview}>
				{preview && (
					<div className="mt-4 space-y-4 border-t border-[var(--line)] pt-4">
						<h3>Draft PR preview</h3>
						{preview.errors.length > 0 && (
							<ul role="alert" className="space-y-2 text-[var(--danger)]">
								{preview.errors.map((message) => (
									<li key={message}>{message}</li>
								))}
							</ul>
						)}
						{preview.target && (
							<p className="break-words">
								{preview.target.host}/{preview.target.owner}/
								{preview.target.name}
								<span className="block text-[var(--muted)]">
									{preview.target.baseBranch} ← {preview.branch}
								</span>
							</p>
						)}
						{preview.eligible && preview.previewHash && (
							<>
								<label className="block text-[var(--muted)]">
									PR title
									<input
										className="mt-2 block w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 text-[var(--ink)]"
										value={title}
										disabled={pending !== null}
										onChange={(e) => setTitle(e.target.value)}
									/>
								</label>
								<details>
									<summary className="text-[var(--muted)]">
										Edit description
									</summary>
									<label className="mt-3 block text-[var(--muted)]">
										PR body
										<textarea
											className="mt-2 block min-h-40 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] p-3 text-[var(--ink)]"
											value={body}
											disabled={pending !== null}
											onChange={(e) => setBody(e.target.value)}
										/>
									</label>
								</details>
							</>
						)}
						<details>
							<summary className="text-[var(--muted)]">
								Inspect included commits · {preview.commits.length}
							</summary>
							<div className="mt-3 space-y-2 text-[var(--muted)]">
								<p className="break-all">
									Base commit: {preview.baseCommit ?? "Unavailable"}
								</p>
								<p className="break-all">
									Reviewed commit: {preview.reviewedCommit ?? "Unavailable"}
								</p>
								<ul className="space-y-2">
									{preview.commits.map((commit) => (
										<li className="break-words" key={commit.sha}>
											<span className="break-all">{commit.sha}</span> ·{" "}
											{commit.subject}
										</li>
									))}
								</ul>
							</div>
						</details>
						<p className="text-xs text-[var(--muted)]">
							The base can advance after this preview; normal PR review and CI
							still apply.
						</p>
						<div className="flex flex-wrap justify-end gap-2">
							<Button
								type="button"
								variant="quiet"
								disabled={pending !== null}
								onClick={() => {
									setPreview(null);
									setError(null);
									previewButton.current?.focus();
								}}
							>
								Cancel
							</Button>
							{preview.eligible && preview.previewHash && (
								<Button
									type="button"
									disabled={pending !== null || !title.trim()}
									onClick={() => void act(true)}
								>
									Create draft PR
								</Button>
							)}
						</div>
					</div>
				)}
			</div>
		</section>
	);
}

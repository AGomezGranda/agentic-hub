import { useState } from "react";
import { pickDirectory } from "../api/pickDirectory.ts";
import { Button } from "./Button.tsx";

export function BrowseButton({
	token,
	onPick,
}: {
	token: string;
	onPick: (path: string) => void;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function browse() {
		setPending(true);
		setError(null);
		try {
			const path = await pickDirectory(token);
			if (path) onPick(path);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not open dialog",
			);
		} finally {
			setPending(false);
		}
	}

	return (
		<>
			<Button
				type="button"
				variant="secondary"
				disabled={pending}
				onClick={() => void browse()}
			>
				{pending ? "Choosing…" : "Browse…"}
			</Button>
			{error ? (
				<p role="alert" className="basis-full text-xs text-[var(--danger)]">
					{error}
				</p>
			) : null}
		</>
	);
}

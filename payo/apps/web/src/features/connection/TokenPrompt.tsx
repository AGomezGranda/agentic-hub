import { Button } from "@web/shared/ui/Button.tsx";
import type { FormEvent } from "react";

export function TokenPrompt({
	value,
	onChange,
	onSubmit,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	return (
		<section className="max-w-xl border-t border-[var(--line)] py-5">
			<div className="mb-5 flex size-11 items-center justify-center rounded-sm bg-[var(--surface-raised)] text-[var(--accent)]">
				<span aria-hidden="true" className="text-xl">
					⌑
				</span>
			</div>
			<h2 className="text-xl font-semibold tracking-tight">Connect to Payo</h2>
			<p className="mt-2 text-sm leading-6 text-[var(--muted)]">
				Paste the local bearer token shown by <code>payo token</code>. It is
				kept in memory and sent only to your local server.
			</p>
			<form className="mt-6 space-y-4" onSubmit={onSubmit}>
				<div className="space-y-2">
					<label htmlFor="server-token" className="text-sm font-semibold">
						Server token
					</label>
					<input
						autoComplete="off"
						className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]"
						id="server-token"
						name="token"
						onChange={(event) => onChange(event.currentTarget.value)}
						placeholder="Paste token"
						required
						type="password"
						value={value}
					/>
				</div>
				<Button type="submit">Connect</Button>
			</form>
		</section>
	);
}

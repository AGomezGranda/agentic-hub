import { Button } from "@web/shared/ui/Button.tsx";
import type { FormEvent } from "react";

export function TokenPrompt({
	value,
	port,
	error,
	onChange,
	onPortChange,
	onSubmit,
}: {
	value: string;
	port: string;
	error: string | null;
	onChange: (value: string) => void;
	onPortChange: (value: string) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
	return (
		<section className="console-panel max-w-xl">
			<div className="mb-5 flex size-11 items-center justify-center rounded-sm bg-[var(--surface-raised)] text-[var(--accent)]">
				<span aria-hidden="true" className="font-mono text-xl">
					⌑
				</span>
			</div>
			<h2 className="text-xl font-semibold tracking-tight">Connect to Payo</h2>
			<p className="mt-2 text-sm leading-6 text-[var(--muted)]">
				Paste the local bearer token shown by <code>payo token</code>. It is
				kept in memory and sent only to your local server.
			</p>
			<form className="mt-6 space-y-4" noValidate onSubmit={onSubmit}>
				<div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
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
					<div className="space-y-2">
						<label htmlFor="server-port" className="text-sm font-semibold">
							Server port
						</label>
						<input
							aria-describedby="server-port-hint"
							className="min-h-11 w-full rounded-sm border border-[var(--line)] bg-[var(--canvas)] px-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]"
							id="server-port"
							inputMode="numeric"
							max={65535}
							min={1}
							name="port"
							onChange={(event) => onPortChange(event.currentTarget.value)}
							required
							type="number"
							value={port}
						/>
					</div>
				</div>
				<p id="server-port-hint" className="text-xs text-[var(--muted)]">
					Loopback only, fixed host <code>127.0.0.1</code>. The port is kept for
					this browser session. After changing <code>[server].port</code>,
					restart Payo and reconnect here at the new port.
				</p>
				{error ? (
					<p
						role="alert"
						className="rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-3 py-2.5 text-sm text-[var(--danger)]"
					>
						{error}
					</p>
				) : null}
				<Button type="submit">Connect</Button>
			</form>
		</section>
	);
}

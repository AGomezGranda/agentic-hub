import {
	QueryClient,
	QueryClientProvider,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { getDoctor } from "@web/features/connection/api.ts";
import { DoctorCard } from "@web/features/connection/DoctorCard.tsx";
import { connectionMessage } from "@web/features/connection/messages.ts";
import { TokenPrompt } from "@web/features/connection/TokenPrompt.tsx";
import { RunWorkspace } from "@web/features/run-workspace/RunWorkspace.tsx";
import { getRuns, type NewRunInput, startRun } from "@web/features/runs/api.ts";
import { NewRunForm } from "@web/features/runs/NewRunForm.tsx";
import { RunList } from "@web/features/runs/RunList.tsx";
import { SettingsPage } from "@web/features/settings/SettingsPage.tsx";
import {
	bearerAuthorization,
	getServerPort,
	PayoApiError,
	setServerPort,
} from "@web/shared/api/client.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { type FormEvent, useCallback, useState } from "react";
import { useRunNavigation } from "./navigation.ts";

export default function App() {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, staleTime: 5_000 },
				},
			}),
	);
	return (
		<QueryClientProvider client={queryClient}>
			<PayoConsole />
		</QueryClientProvider>
	);
}

function PayoConsole() {
	const [token, setToken] = useState<string | null>(null);
	const [tokenDraft, setTokenDraft] = useState("");
	const [serverPort, setServerPortState] = useState(() => getServerPort());
	const [portDraft, setPortDraft] = useState(() => String(getServerPort()));
	const [connectError, setConnectError] = useState<string | null>(null);
	const [settingsDirty, setSettingsDirty] = useState(false);
	const clearSettingsDirty = useCallback(() => setSettingsDirty(false), []);
	const {
		page,
		selectedRunId,
		invalidRunRoute,
		navigateHome,
		navigateServer,
		navigateSettings,
		navigateNewRun,
		navigateToRun,
	} = useRunNavigation({
		isDirty: settingsDirty,
		onDiscard: clearSettingsDirty,
	});
	const queryClient = useQueryClient();

	function disconnect() {
		queryClient.removeQueries();
		setToken(null);
		setTokenDraft("");
		setConnectError(null);
		clearSettingsDirty();
	}

	const doctor = useQuery({
		queryKey: ["doctor", token, serverPort],
		queryFn: () => getDoctor(token as string),
		enabled: token !== null,
	});
	const runs = useQuery({
		queryKey: ["runs", token, serverPort],
		queryFn: () => getRuns(token as string),
		enabled: token !== null,
		refetchInterval: (query) =>
			token !== null &&
			!(
				query.state.error instanceof PayoApiError &&
				query.state.error.status === 401
			)
				? 5_000
				: false,
	});
	const start = useMutation({
		mutationFn: (input: NewRunInput) => startRun(token as string, input),
		onSuccess: ({ runId }) => {
			navigateToRun(runId);
			void queryClient.invalidateQueries({ queryKey: ["runs", token] });
		},
	});

	function connect(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = tokenDraft.trim();
		if (!value) return;
		const port = Number(portDraft);
		try {
			bearerAuthorization(value);
			setServerPort(port);
		} catch (error) {
			setConnectError(
				error instanceof Error
					? error.message
					: "Enter a port between 1 and 65535.",
			);
			return;
		}
		setConnectError(null);
		setServerPortState(port);
		setToken(value);
		setTokenDraft("");
	}

	const connectionError = doctor.error ?? runs.error;
	return (
		<div className="flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink)]">
			<header className="console-header border-b border-[var(--line)] bg-[var(--surface)]">
				<div className="flex items-center justify-between px-5 py-4 sm:px-8">
					<a
						href="/"
						aria-label="Payo home"
						className="flex items-center gap-3 rounded-sm no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
						onClick={(event) => {
							if (
								event.button !== 0 ||
								event.metaKey ||
								event.ctrlKey ||
								event.shiftKey ||
								event.altKey
							)
								return;
							event.preventDefault();
							navigateHome();
						}}
					>
						<span className="grid size-9 place-items-center rounded-sm bg-[var(--accent)] text-sm font-black text-[var(--accent-ink)]">
							P
						</span>
						<span className="text-[15px] font-bold tracking-[0.18em]">
							PAYO
						</span>
						<span className="hidden rounded-sm border border-[var(--line)] px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-[var(--muted)] sm:inline-flex">
							LOCAL / RUN CONTROL
						</span>
					</a>
					<span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
						<span className="size-2 rounded-sm bg-[var(--status-good)]" />
						127.0.0.1:{serverPort} only
					</span>
				</div>
			</header>

			<div className="flex-1 lg:flex">
				{token !== null ? (
					<aside
						aria-label="Your work"
						className="min-w-0 border-b border-[var(--line)] bg-[var(--surface)] lg:w-80 lg:shrink-0 lg:border-r lg:border-b-0"
					>
						<nav
							aria-label="Main navigation"
							className="space-y-1 border-b border-[var(--line)] p-4 text-sm font-semibold sm:p-5"
						>
							{(
								[
									[
										"/runs/new",
										"New run",
										navigateNewRun,
										page === "new-run" && !selectedRunId && !invalidRunRoute,
									],
									[
										"/server",
										"Server status",
										navigateServer,
										page === "server",
									],
									[
										"/settings",
										"Settings",
										navigateSettings,
										page === "settings",
									],
								] as const
							).map(([href, label, navigate, current]) => (
								<a
									key={href}
									href={href}
									aria-current={current ? "page" : undefined}
									className={`console-nav-link flex items-center gap-3 rounded-sm px-3 py-3 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${current ? "text-[var(--accent)]" : "text-[var(--ink)] hover:bg-[var(--surface-raised)]"}`}
									onClick={(event) => {
										if (
											event.button !== 0 ||
											event.metaKey ||
											event.ctrlKey ||
											event.shiftKey ||
											event.altKey
										)
											return;
										event.preventDefault();
										navigate();
									}}
								>
									<span
										aria-hidden="true"
										className="font-mono text-xs text-[var(--muted)]"
									>
										{href === "/runs/new"
											? "+"
											: href === "/settings"
												? "~"
												: "//"}
									</span>
									{label}
								</a>
							))}
						</nav>
						<RunList
							runs={runs.data ?? []}
							isPending={runs.isPending}
							errorMessage={
								runs.error
									? connectionMessage(runs.error, serverPort)
									: undefined
							}
							selectedRunId={selectedRunId ?? undefined}
							onSelect={navigateToRun}
						/>
					</aside>
				) : null}
				<main className="console-main min-w-0 flex-1 px-5 py-8 sm:px-8 sm:py-10">
					{token !== null && (selectedRunId || invalidRunRoute) ? null : (
						<div className="console-intro mb-8 max-w-3xl">
							<p className="console-eyebrow mb-3 text-[11px] font-bold tracking-[0.16em] text-[var(--accent)]">
								RUN CONTROL / LOCAL
							</p>
							<h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
								{token === null
									? "Connect to your workspace."
									: page === "server"
										? "Server status"
										: page === "settings"
											? "Settings"
											: "New run"}
							</h1>
							<p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)] sm:text-base">
								{token === null
									? "Connect to your local Payo server. Your token stays in this browser session only."
									: page === "server"
										? "Connection and readiness of your local server."
										: page === "settings"
											? "Edit the shared Payo config file. Restart Payo to apply saved changes."
											: "Choose a Jira issue or describe the work directly."}
							</p>
						</div>
					)}

					{token === null ? (
						<TokenPrompt
							value={tokenDraft}
							port={portDraft}
							error={connectError}
							onChange={setTokenDraft}
							onPortChange={setPortDraft}
							onSubmit={connect}
						/>
					) : selectedRunId ? (
						<RunWorkspace
							key={selectedRunId}
							token={token}
							runId={selectedRunId}
							onDisconnect={disconnect}
							onSelectRun={navigateToRun}
						/>
					) : invalidRunRoute ? (
						<div
							role="alert"
							className="rounded-sm border border-[var(--warning-border)] bg-[var(--warning-surface)] px-4 py-3 text-sm text-[var(--status-warn)]"
						>
							This run URL is invalid. Return to the run list and select a run.
						</div>
					) : (
						<div>
							{connectionError ? (
								<div
									role="alert"
									className="mb-5 rounded-sm border border-[var(--danger-border)] bg-[var(--danger-surface)] px-4 py-3 text-sm text-[var(--danger)]"
								>
									{connectionMessage(connectionError, serverPort)}
								</div>
							) : null}
							{page === "settings" ? (
								<SettingsPage token={token} onDirtyChange={setSettingsDirty} />
							) : page === "server" ? (
								<div className="max-w-3xl">
									<DoctorCard
										doctor={doctor.data}
										isPending={doctor.isPending}
										port={serverPort}
									/>
									<Button
										variant="secondary"
										type="button"
										onClick={disconnect}
									>
										Change token
									</Button>
								</div>
							) : (
								<section className="console-panel max-w-3xl">
									<div className="mb-6 flex items-center justify-between border-b border-[var(--line)] pb-4">
										<h2 className="console-eyebrow text-xs font-semibold uppercase tracking-widest">
											Run configuration
										</h2>
										<span className="font-mono text-[10px] text-[var(--muted)]">
											01 / INPUT
										</span>
									</div>
									<NewRunForm
										token={token}
										isPending={start.isPending}
										error={start.error}
										onStart={(input) => start.mutate(input)}
									/>
								</section>
							)}
						</div>
					)}
				</main>
			</div>
			<footer className="console-footer flex flex-wrap justify-between gap-2 border-t border-[var(--line)] bg-[var(--surface)] px-5 py-3 text-[var(--muted)] sm:px-8">
				<span>PAYO / LOCAL OPERATIONS</span>
				<span>
					{token === null ? "SESSION LOCKED" : "SESSION TOKEN SET"} · LOOPBACK
					ONLY
				</span>
			</footer>
		</div>
	);
}

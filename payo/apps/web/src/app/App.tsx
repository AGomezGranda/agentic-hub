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
import { PayoApiError } from "@web/shared/api/client.ts";
import { Button } from "@web/shared/ui/Button.tsx";
import { type FormEvent, useState } from "react";
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
	const {
		page,
		selectedRunId,
		invalidRunRoute,
		navigateHome,
		navigateServer,
		navigateNewRun,
		navigateToRun,
	} = useRunNavigation();
	const queryClient = useQueryClient();

	function disconnect() {
		queryClient.removeQueries();
		setToken(null);
		setTokenDraft("");
	}

	const doctor = useQuery({
		queryKey: ["doctor", token],
		queryFn: () => getDoctor(token as string),
		enabled: token !== null,
	});
	const runs = useQuery({
		queryKey: ["runs", token],
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
		if (value) {
			setToken(value);
			setTokenDraft("");
		}
	}

	const connectionError = doctor.error ?? runs.error;
	return (
		<div className="flex min-h-screen flex-col bg-[var(--canvas)] text-[var(--ink)]">
			<header className="border-b border-[var(--line)] bg-[var(--surface)]">
				<div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
					<a
						href="/"
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
						<span className="text-[15px] font-bold tracking-tight">Payo</span>
						<span className="hidden rounded-sm border border-[var(--line)] px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-[var(--muted)] sm:inline-flex">
							LOCAL RUN CONSOLE
						</span>
					</a>
					<span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
						<span className="size-2 rounded-sm bg-[var(--status-good)]" />
						127.0.0.1 only
					</span>
				</div>
			</header>

			<div className="flex-1 lg:flex">
				{token !== null ? (
					<aside
						aria-label="Your work"
						className="border-b border-[var(--line)] bg-[var(--surface)] lg:w-72 lg:shrink-0 lg:border-r lg:border-b-0"
					>
						<nav
							aria-label="Main navigation"
							className="space-y-1 border-b border-[var(--line)] p-5 text-sm font-semibold"
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
								] as const
							).map(([href, label, navigate, current]) => (
								<a
									key={href}
									href={href}
									aria-current={current ? "page" : undefined}
									className={`block rounded-sm px-3 py-2 no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${current ? "bg-[var(--surface-raised)] text-[var(--accent)]" : "text-[var(--ink)] hover:bg-[#f6f8f6]"}`}
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
									{label}
								</a>
							))}
						</nav>
						<RunList
							runs={runs.data ?? []}
							isPending={runs.isPending}
							selectedRunId={selectedRunId ?? undefined}
							onSelect={navigateToRun}
						/>
					</aside>
				) : null}
				<main className="min-w-0 flex-1 px-5 py-8 sm:px-8 sm:py-10">
					{token !== null && (selectedRunId || invalidRunRoute) ? null : (
						<div className="mb-8 max-w-3xl">
							<p className="mb-3 text-[11px] font-bold tracking-[0.16em] text-[var(--accent)]">
								RUN CONTROL / LOCAL
							</p>
							<h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
								{token === null
									? "Connect to your workspace."
									: page === "server"
										? "Server status"
										: "New run"}
							</h1>
							<p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)] sm:text-base">
								{token === null
									? "Connect to your local Payo server. Your token stays in this browser session only."
									: page === "server"
										? "Connection and readiness of your local server."
										: "Choose a Jira issue or describe the work directly."}
							</p>
						</div>
					)}

					{token === null ? (
						<TokenPrompt
							value={tokenDraft}
							onChange={setTokenDraft}
							onSubmit={connect}
						/>
					) : selectedRunId ? (
						<RunWorkspace
							key={selectedRunId}
							token={token}
							runId={selectedRunId}
							onDisconnect={disconnect}
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
									className="mb-5 rounded-sm border border-[#f1c6b3] bg-[#fff5ef] px-4 py-3 text-sm text-[#8d421f]"
								>
									{connectionMessage(connectionError)}
								</div>
							) : null}
							{page === "server" ? (
								<div className="max-w-3xl">
									<DoctorCard
										doctor={doctor.data}
										isPending={doctor.isPending}
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
								<section className="max-w-3xl border-t border-[var(--line)] py-5">
									<NewRunForm
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
		</div>
	);
}

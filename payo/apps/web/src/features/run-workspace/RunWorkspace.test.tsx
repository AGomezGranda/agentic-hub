// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ExecutionView } from "./ExecutionView.tsx";
import { RunWorkspace } from "./RunWorkspace.tsx";

const RUN_ID = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const STEP_ID = "7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const GATE_ID = "8f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const TOKEN = "test-token";
const BASE_URL = "http://127.0.0.1:7331/api/v1";
const timestamp = "2026-10-30T00:00:00.000Z";

function summary(stage = "Plan", openGates: unknown[] = [], runId = RUN_ID) {
	return {
		runId,
		repo: "/work/repo",
		baseBranch: "main",
		status: "active",
		outcome: null,
		stage,
		workItem: { source: "jira", title: "Repair the widget", key: "ABC-123" },
		startedAt: timestamp,
		updatedAt: timestamp,
		openGates,
	};
}

function review() {
	return {
		plan: { available: false, reason: "not_available" },
		answers: {},
		review: { available: false, reason: "not_available" },
	};
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function wrap(
	child: ReactNode,
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	}),
) {
	return <QueryClientProvider client={client}>{child}</QueryClientProvider>;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("opens an approved run on its implementation view", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/review")) return json(200, review());
			if (url.endsWith("/plan-versions")) return json(200, { versions: [] });
			if (url.endsWith("/events")) return json(200, { events: [] });
			if (url === `${BASE_URL}/runs/${RUN_ID}`)
				return json(200, {
					...summary(),
					status: "ended",
					outcome: "approved",
				});
			throw new Error(`unexpected request ${url}`);
		}),
	);
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	expect(await screen.findByText(/PR choices are unavailable/)).toBeVisible();
	expect(
		screen.getByRole("button", { name: "Implementation" }),
	).toHaveAttribute("aria-pressed", "true");
});

it("coalesces a burst of stream events into one summary refresh at the latest gate", async () => {
	let summaryRequests = 0;
	const gate = {
		gateId: GATE_ID,
		stepId: STEP_ID,
		kind: "approval",
		allowedCommands: ["approve"],
		reason: "Review the plan",
	};
	const burst = [
		{
			type: "step.started",
			stepId: STEP_ID,
			name: "approval",
			seq: 1,
			at: timestamp,
		},
		{
			type: "step.finished",
			stepId: STEP_ID,
			outcome: "succeeded",
			seq: 2,
			at: timestamp,
		},
		{
			type: "gate.raised",
			gateId: GATE_ID,
			stepId: STEP_ID,
			kind: "approval",
			allowedCommands: ["approve"],
			reason: "Review the plan",
			seq: 3,
			at: timestamp,
		},
	];
	const streamBody = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(
					burst
						.map(
							(event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
				),
			);
		},
	});
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/review")) return json(200, review());
		if (url === `${BASE_URL}/runs/${RUN_ID}`) {
			summaryRequests += 1;
			return json(
				200,
				summary(
					summaryRequests > 1 ? "Approval" : "Plan",
					summaryRequests > 1 ? [gate] : [],
				),
			);
		}
		if (url === `${BASE_URL}/runs/${RUN_ID}/events`)
			return json(200, { events: [] });
		if (url.includes(`/runs/${RUN_ID}/events/stream`))
			return new Response(streamBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		throw new Error(`unexpected request ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});

	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
			queryClient,
		),
	);

	expect(await screen.findByText("Approval")).toBeInTheDocument();
	await waitFor(() => expect(summaryRequests).toBe(2));
	await new Promise((resolve) => setTimeout(resolve, 180));
	expect(summaryRequests).toBe(2);
	expect(queryClient.getQueryData(["run", TOKEN, RUN_ID])).toMatchObject({
		stage: "Approval",
		openGates: [gate],
	});
	await userEvent
		.setup()
		.click(screen.getByRole("button", { name: "Activity view" }));
	expect(screen.getByText("Gate raised · approval")).toBeInTheDocument();
});

it("keeps streamed events after the run ends", async () => {
	const historyEvent = {
		type: "step.started",
		stepId: STEP_ID,
		name: "planning",
		seq: 1,
		at: timestamp,
	};
	const streamEvent = { ...historyEvent, name: "approval", seq: 2 };
	const ended = {
		type: "run.ended",
		outcome: "approved",
		seq: 3,
		at: timestamp,
	};
	let summaryRequests = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/review")) return json(200, review());
			if (url === `${BASE_URL}/runs/${RUN_ID}/events`)
				return json(200, { events: [historyEvent] });
			if (url === `${BASE_URL}/runs/${RUN_ID}`) {
				summaryRequests += 1;
				return json(
					200,
					summaryRequests > 1
						? { ...summary(), status: "ended", outcome: "approved" }
						: summary(),
				);
			}
			if (url.includes(`/runs/${RUN_ID}/events/stream`))
				return new Response(
					[streamEvent, ended]
						.map(
							(event) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			throw new Error(`unexpected request ${url}`);
		}),
	);
	const user = userEvent.setup();
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);

	expect(await screen.findByText("Ended · approved")).toBeInTheDocument();
	await user.click(screen.getByRole("button", { name: "Activity view" }));
	expect(screen.getByText("Started · planning")).toBeInTheDocument();
	expect(screen.getByText("Started · approval")).toBeInTheDocument();
});

it("does not refresh the summary for attempt events", async () => {
	let summaryRequests = 0;
	const attemptStarted = {
		type: "attempt.started",
		attemptId: "af1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e",
		stepId: STEP_ID,
		role: "reviewer",
		runner: "fake",
		model: null,
		roleSpecSha: null,
		inputArtifacts: [],
		seq: 1,
		at: timestamp,
	};
	const message = {
		type: "attempt.event",
		attemptId: attemptStarted.attemptId,
		event: { type: "message", text: "Looking at the plan" },
		seq: 2,
		at: timestamp,
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/review")) return json(200, review());
			if (url === `${BASE_URL}/runs/${RUN_ID}/events`)
				return json(200, { events: [] });
			if (url === `${BASE_URL}/runs/${RUN_ID}`) {
				summaryRequests += 1;
				return json(200, summary());
			}
			if (url.includes(`/runs/${RUN_ID}/events/stream`))
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									[attemptStarted, message]
										.map(
											(event) =>
												`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
										)
										.join(""),
								),
							);
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			throw new Error(`unexpected request ${url}`);
		}),
	);
	const user = userEvent.setup();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
			queryClient,
		),
	);

	await user.click(
		await screen.findByRole("button", { name: "Activity view" }),
	);
	expect(await screen.findByText("Agent message")).toBeInTheDocument();
	await new Promise((resolve) => setTimeout(resolve, 180));
	expect(summaryRequests).toBe(1);
});

it("reconnects after a dropped stream and resumes from the next sequence", async () => {
	let streamRequests = 0;
	const streamUrls: string[] = [];
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/review")) return json(200, review());
		if (url === `${BASE_URL}/runs/${RUN_ID}`) return json(200, summary());
		if (url === `${BASE_URL}/runs/${RUN_ID}/events`)
			return json(200, { events: [] });
		if (url.includes(`/runs/${RUN_ID}/events/stream`)) {
			streamUrls.push(url);
			streamRequests += 1;
			if (streamRequests === 1) {
				const event = {
					type: "step.started",
					stepId: STEP_ID,
					name: "planning",
					seq: 1,
					at: timestamp,
				};
				let sent = false;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							if (sent) {
								controller.error(new TypeError("server disconnected"));
								return;
							}
							sent = true;
							controller.enqueue(
								new TextEncoder().encode(
									`id: 1\ndata: ${JSON.stringify(event)}\n\n`,
								),
							);
						},
					}),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response(new ReadableStream({ start() {} }), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}
		throw new Error(`unexpected request ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);

	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);

	expect(
		await screen.findByText("Live", {}, { timeout: 2_000 }),
	).toBeInTheDocument();
	await waitFor(() => expect(streamRequests).toBe(2));
	expect(
		screen.queryByText(/disconnected; retrying automatically/i),
	).toBeNull();
	expect(streamUrls).toEqual([
		`${BASE_URL}/runs/${RUN_ID}/events/stream?fromSeq=1`,
		`${BASE_URL}/runs/${RUN_ID}/events/stream?fromSeq=2`,
	]);
});

it("surfaces unauthorized streams and cancels the previous run stream on selection change", async () => {
	const OTHER_RUN_ID = "9f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
	let firstStreamCancelled = false;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const runId = url.includes(OTHER_RUN_ID) ? OTHER_RUN_ID : RUN_ID;
		if (url.endsWith("/review")) return json(200, review());
		if (url === `${BASE_URL}/runs/${runId}`)
			return json(200, summary("Plan", [], runId));
		if (url === `${BASE_URL}/runs/${runId}/events`)
			return json(200, { events: [] });
		if (url.includes(`/runs/${RUN_ID}/events/stream`))
			return new Response(
				new ReadableStream({
					cancel() {
						firstStreamCancelled = true;
					},
				}),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		if (url.includes(`/runs/${OTHER_RUN_ID}/events/stream`))
			return json(401, { code: "unauthorized", message: "invalid token" });
		throw new Error(`unexpected request ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);

	const view = render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	await screen.findByText("Live");
	view.rerender(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={OTHER_RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);

	expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent(
		/server rejected this token/i,
	);
	await waitFor(() => expect(firstStreamCancelled).toBe(true));
});

it("loads ended-run history without opening a live stream", async () => {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/review")) return json(200, review());
		if (url.endsWith("/events")) return json(200, { events: [] });
		if (url === `${BASE_URL}/runs/${RUN_ID}`)
			return json(200, { ...summary(), status: "ended", outcome: "approved" });
		throw new Error(`unexpected request ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	expect(await screen.findByText("Ended")).toBeInTheDocument();
	expect(screen.getByText("Ended · approved")).toBeInTheDocument();
	expect(
		fetchMock.mock.calls.some(([url]) =>
			String(url).includes("/events/stream"),
		),
	).toBe(false);
});

it("switches between implementation and activity views", async () => {
	const user = userEvent.setup();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/review")) return json(200, review());
			if (url.endsWith("/events")) return json(200, { events: [] });
			if (url === `${BASE_URL}/runs/${RUN_ID}`)
				return json(200, {
					...summary(),
					status: "ended",
					outcome: "approved",
				});
			throw new Error(`unexpected request ${url}`);
		}),
	);
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	await screen.findByText("Ended · approved");
	await user.click(screen.getByRole("button", { name: "Implementation" }));
	expect(screen.getByText("Activity", { selector: "h2" })).not.toBeVisible();
	expect(await screen.findByRole("heading", { name: "Plan" })).toBeVisible();
	await user.click(screen.getByRole("link", { name: "View activity" }));
	expect(screen.getByRole("button", { name: "Activity view" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(screen.getByRole("heading", { name: "Activity" })).toBeVisible();
	expect(screen.getByText("Plan", { selector: "h2" })).not.toBeVisible();
	await user.click(screen.getByRole("button", { name: "Implementation" }));
	expect(screen.getByRole("heading", { name: "Plan" })).toBeVisible();
	expect(screen.getByText("Activity", { selector: "h2" })).not.toBeVisible();
});

it("shows execution progress, follows its source, and refreshes checkpoints without requesting review", async () => {
	const source = "9f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
	const execution = {
		runId: RUN_ID,
		sourceRunId: source,
		prId: "PR-1",
		phaseCount: 0,
		completedPhases: [],
		resultCommit: null,
		artifactIssues: ["Review artifact unavailable"],
		status: "active",
		outcome: null,
		stage: "Prepare",
		phaseIndex: 0,
		scope: "phase",
		branch: null,
		worktree: null,
		statusDetail: "Preparing",
		escalationReason: null,
		checks: [],
		review: null,
	};
	const checkpoint = (seq: number) => ({
		type: "artifact.recorded",
		attemptId: null,
		artifact: {
			kind: "factory-execution-checkpoint-v1",
			sha256: "a".repeat(64),
			size: 1,
			mediaType: "application/json",
		},
		seq,
		at: timestamp,
	});
	let requests = 0;
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `${BASE_URL}/runs/${RUN_ID}`) {
			requests++;
			return json(200, {
				...summary(),
				execution:
					requests === 1
						? execution
						: {
								...execution,
								stage: "Finalize",
								phaseCount: 2,
								phaseIndex: 1,
								scope: "final",
								completedPhases: [
									{ id: "one", title: "First phase", resultCommit: "abc123" },
								],
								checks: [{ name: "tests", status: "passed" }],
								review: {
									lenses: [],
									uncheckedLenses: ["security"],
									findings: 3,
									unresolved: 1,
									round: 2,
								},
							},
			});
		}
		if (url.endsWith("/events")) return json(200, { events: [] });
		if (url.includes("/events/stream"))
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						setTimeout(
							() =>
								controller.enqueue(
									new TextEncoder().encode(
										[checkpoint(1), checkpoint(2)]
											.map(
												(event) =>
													`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
											)
											.join(""),
									),
								),
							250,
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		throw new Error(`unexpected request ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	const select = vi.fn();
	const user = userEvent.setup();
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={select}
			/>,
		),
	);
	expect(await screen.findByText("No check results available")).toBeVisible();
	expect(screen.getByText("No review evidence available")).toBeVisible();
	expect(screen.getByText("Review artifact unavailable")).toBeVisible();
	expect(screen.queryByText(/Phase 1 of/)).toBeNull();
	await user.click(screen.getByRole("link", { name: /source run/i }));
	expect(select).toHaveBeenCalledWith(source);
	await user.click(screen.getByRole("button", { name: "Activity view" }));
	await user.click(screen.getByRole("button", { name: "Execution view" }));
	expect(await screen.findByText("Final scope")).toBeVisible();
	expect(screen.getByText("First phase")).toBeVisible();
	expect(screen.getByText("abc123")).toBeVisible();
	expect(screen.getByText(/3 findings/)).toBeVisible();
	expect(screen.getByText(/Round 2/)).toBeVisible();
	expect(screen.getByText("security")).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 180));
	expect(requests).toBe(2);
	expect(
		fetchMock.mock.calls.some(([url]) => String(url).endsWith("/review")),
	).toBe(false);
});

it("updates execution progress when activity history is unavailable", async () => {
	let requests = 0;
	const execution = {
		runId: RUN_ID,
		sourceRunId: RUN_ID,
		prId: "PR-1",
		phaseCount: 0,
		completedPhases: [],
		resultCommit: null,
		artifactIssues: [],
		status: "active",
		outcome: null,
		stage: "Prepare",
		phaseIndex: 0,
		scope: "phase",
		branch: null,
		worktree: null,
		statusDetail: null,
		escalationReason: null,
		checks: [],
		review: null,
	};
	const event = {
		type: "artifact.recorded",
		attemptId: null,
		seq: 1,
		at: timestamp,
		artifact: {
			kind: "factory-execution-checkpoint-v1",
			sha256: "a".repeat(64),
			size: 1,
			mediaType: "application/json",
		},
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `${BASE_URL}/runs/${RUN_ID}`) {
				requests++;
				return json(200, {
					...summary(),
					execution: {
						...execution,
						statusDetail: requests > 1 ? "Updated progress" : null,
					},
				});
			}
			if (url.endsWith("/events"))
				return json(503, {
					code: "unavailable",
					message: "History unavailable",
				});
			if (url.includes("/events/stream"))
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									`id: 1\ndata: ${JSON.stringify(event)}\n\n`,
								),
							);
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			throw new Error(`unexpected request ${url}`);
		}),
	);
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	expect(await screen.findByText("Updated progress")).toBeVisible();
	expect(screen.getByText("Live")).toBeVisible();
});

it("shows source phase titles, the active phase, and final review", () => {
	const execution = {
		runId: RUN_ID,
		sourceRunId: RUN_ID,
		prId: "PR-1",
		phaseCount: 2,
		phases: [
			{ id: "phase-1", title: "Phase 3 — Prepare" },
			{ id: "phase-2", title: "Phase 4 — Check" },
		],
		completedPhases: [],
		resultCommit: null,
		artifactIssues: [],
		status: "active" as const,
		outcome: null,
		stage: "Implement" as const,
		phaseIndex: 1,
		scope: "phase" as const,
		branch: null,
		worktree: null,
		statusDetail: null,
		escalationReason: null,
		checks: [],
		review: null,
	};
	const view = render(
		<ExecutionView
			execution={execution}
			gate={null}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByText("Phase 4 — Check").closest("li")).toHaveAttribute(
		"aria-current",
		"step",
	);
	expect(screen.getByText("Final PR review")).toBeVisible();
	view.rerender(
		<ExecutionView
			execution={{ ...execution, phaseIndex: 2 }}
			gate={null}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByText("Phase unavailable")).toBeVisible();
});

it("resumes an execution gate, refreshes after rejection and success", async () => {
	const gate = {
		gateId: GATE_ID,
		stepId: STEP_ID,
		kind: "execution-escalation",
		allowedCommands: ["resume"],
		reason: "Interrupted during phase two",
	};
	const execution = {
		runId: RUN_ID,
		sourceRunId: RUN_ID,
		prId: "PR-1",
		phaseCount: 2,
		completedPhases: [],
		resultCommit: null,
		artifactIssues: [],
		status: "active",
		outcome: null,
		stage: "Escalated",
		phaseIndex: 1,
		scope: "phase",
		branch: "feature/test",
		worktree: "/work/tree",
		statusDetail: null,
		escalationReason: gate.reason,
		checks: [],
		review: null,
	};
	let attempts = 0;
	let summaryRequests = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/resume")) {
				attempts++;
				return attempts === 1
					? json(409, { code: "conflict", message: "Still blocked" })
					: json(200, { runId: RUN_ID });
			}
			if (url === `${BASE_URL}/runs/${RUN_ID}`) {
				summaryRequests++;
				if (summaryRequests === 2)
					return json(503, { code: "unavailable", message: "Refresh failed" });
				return json(200, {
					...summary("Escalated", attempts < 2 ? [gate] : []),
					execution,
				});
			}
			if (url.endsWith("/events")) return json(200, { events: [] });
			if (url.includes("/events/stream"))
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "text/event-stream" },
				});
			throw new Error(`unexpected request ${url} ${init?.method}`);
		}),
	);
	const user = userEvent.setup();
	render(
		wrap(
			<RunWorkspace
				token={TOKEN}
				runId={RUN_ID}
				onDisconnect={() => {}}
				onSelectRun={() => {}}
			/>,
		),
	);
	expect(await screen.findByText("Interrupted during phase two")).toBeVisible();
	expect(screen.getByText("feature/test")).toBeVisible();
	await user.click(screen.getByRole("button", { name: "Activity view" }));
	await user.click(screen.getByRole("button", { name: "View execution" }));
	expect(screen.getByText("Interrupted during phase two")).toBeVisible();
	await user.click(screen.getByRole("button", { name: "Resume" }));
	expect(await screen.findByText(/Still blocked/)).toBeVisible();
	expect(await screen.findByText(/Could not refresh this run/)).toBeVisible();
	expect(screen.getByText("Interrupted during phase two")).toBeVisible();
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled(),
	);
	await user.click(screen.getByRole("button", { name: "Resume" }));
	await waitFor(() =>
		expect(screen.queryByRole("button", { name: "Resume" })).toBeNull(),
	);
});

it("shows unavailable result fields and disables a gate without resume permission", () => {
	const execution = {
		runId: RUN_ID,
		sourceRunId: RUN_ID,
		prId: "PR-1",
		phaseCount: 0,
		completedPhases: [],
		resultCommit: null,
		artifactIssues: [],
		status: "ended" as const,
		outcome: "reviewed",
		stage: "Completed" as const,
		phaseIndex: 0,
		scope: "final" as const,
		branch: null,
		worktree: null,
		statusDetail: null,
		escalationReason: null,
		checks: [],
		review: null,
	};
	const gate = {
		gateId: GATE_ID,
		stepId: STEP_ID,
		kind: "execution-escalation",
		allowedCommands: [],
		reason: "Needs attention",
	};
	const view = render(
		<ExecutionView
			execution={execution}
			gate={gate}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
	expect(screen.getAllByText("Unavailable")).toHaveLength(3);
	view.rerender(
		<ExecutionView
			execution={{ ...execution, status: "active" }}
			gate={gate}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
	view.rerender(
		<ExecutionView
			execution={execution}
			gate={{ ...gate, allowedCommands: ["resume"] }}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
	view.rerender(
		<ExecutionView
			execution={{
				...execution,
				branch: "branch",
				worktree: "/tree",
				resultCommit: "final123",
			}}
			gate={null}
			token={TOKEN}
			onRefresh={async () => {}}
			onSelectRun={() => {}}
		/>,
	);
	expect(screen.getByText("branch")).toBeVisible();
	expect(screen.getByText("/tree")).toBeVisible();
	expect(screen.getByText("final123")).toBeVisible();
});

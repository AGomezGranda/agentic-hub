// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import App from "./App.tsx";

const RUN_ID = "6f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
const ORIGIN = "http://127.0.0.1:7331/api/v1";
const TOKEN = "test-token";

function runReview() {
	return {
		plan: { available: false, reason: "not_available" },
		answers: {},
		review: { available: false, reason: "not_available" },
	};
}

function runSummary(runId: string) {
	return {
		runId,
		repo: "/repo",
		baseBranch: "main",
		status: "active",
		outcome: null,
		stage: "Plan",
		workItem: {
			source: "jira",
			title: "Fake run",
			key: "ABC-123",
		},
		startedAt: "2026-10-30T00:00:00.000Z",
		updatedAt: "2026-10-30T00:00:00.000Z",
		openGates: [],
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockEmptyServer(startResponse?: Response) {
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).not.toContain(TOKEN);
			expect(
				(init?.headers as Record<string, string> | undefined)?.Authorization,
			).toBe(`Bearer ${TOKEN}`);
			if (url === `${ORIGIN}/doctor`)
				return jsonResponse(200, { ok: true, checks: [] });
			if (url === `${ORIGIN}/runs/${RUN_ID}`)
				return jsonResponse(200, runSummary(RUN_ID));
			if (url === `${ORIGIN}/runs/${RUN_ID}/review`)
				return jsonResponse(200, runReview());
			if (url === `${ORIGIN}/runs/${RUN_ID}/events`)
				return jsonResponse(200, { events: [] });
			if (url.includes(`/runs/${RUN_ID}/events/stream`))
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "text/event-stream" },
				});
			if (url === `${ORIGIN}/runs` && init?.method !== "POST")
				return jsonResponse(200, { runs: [] });
			if (url === `${ORIGIN}/runs` && init?.method === "POST")
				return startResponse ?? jsonResponse(202, { runId: RUN_ID });
			throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function connect(user: ReturnType<typeof userEvent.setup>) {
	await user.type(screen.getByLabelText("Server token"), TOKEN);
	await user.click(screen.getByRole("button", { name: "Connect" }));
	await screen.findByRole("heading", { name: "Recent runs" });
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	window.history.pushState({}, "", "/");
});

it("opens run creation by default and keeps server and recent runs accessible", async () => {
	const user = userEvent.setup();
	mockEmptyServer();
	render(<App />);
	await connect(user);
	expect(screen.getByRole("heading", { name: "New run" })).toBeInTheDocument();
	expect(screen.queryByRole("link", { name: "Runs" })).toBeNull();
	expect(
		screen.getByRole("heading", { name: "Recent runs" }),
	).toBeInTheDocument();
	await user.click(screen.getByRole("link", { name: "New run" }));
	expect(window.location.pathname).toBe("/runs/new");
	expect(screen.getByRole("heading", { name: "New run" })).toBeInTheDocument();
	await user.click(screen.getByRole("link", { name: "Server status" }));
	expect(window.location.pathname).toBe("/server");
	expect(
		screen.getByRole("heading", { name: "Server status" }),
	).toBeInTheDocument();
	expect(screen.queryByRole("heading", { name: "New run" })).toBeNull();
});

it("discovers an externally created run on the next list refresh", async () => {
	let listCalls = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/doctor"))
				return jsonResponse(200, { ok: true, checks: [] });
			if (url.endsWith("/runs"))
				return jsonResponse(200, {
					runs: ++listCalls === 1 ? [] : [runSummary(RUN_ID)],
				});
			if (url.includes("/events")) return jsonResponse(200, { events: [] });
			throw new Error(`unexpected request ${url}`);
		}),
	);
	const user = userEvent.setup();
	render(<App />);
	await user.type(screen.getByLabelText("Server token"), TOKEN);
	await user.click(screen.getByRole("button", { name: "Connect" }));
	expect(
		await screen.findByRole("link", { name: /Fake run/ }, { timeout: 7_000 }),
	).toBeInTheDocument();
}, 8_000);

it("starts a Jira run with optional repository overrides and opens its URL", async () => {
	const user = userEvent.setup();
	const fetchMock = mockEmptyServer();
	render(<App />);
	await connect(user);
	await screen.findByText("No runs yet");
	await user.click(screen.getByRole("link", { name: "New run" }));

	await user.type(screen.getByLabelText("Jira key"), "ABC-123");
	await user.type(
		screen.getByLabelText("Repository override (optional)"),
		"/repo",
	);
	await user.type(
		screen.getByLabelText("Base branch override (optional)"),
		"develop",
	);
	await user.click(screen.getByRole("button", { name: "Start run" }));

	await waitFor(() => {
		expect(fetchMock).toHaveBeenCalledWith(
			`${ORIGIN}/runs`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					workItemRequest: { source: "jira", key: "ABC-123" },
					repo: "/repo",
					baseBranch: "develop",
				}),
			}),
		);
	});
	expect(window.location.pathname).toBe(`/runs/${RUN_ID}`);
});

it("starts a prompt run without sending blank optional overrides", async () => {
	const user = userEvent.setup();
	const fetchMock = mockEmptyServer();
	render(<App />);
	await connect(user);
	await user.click(screen.getByRole("link", { name: "New run" }));
	await user.click(screen.getByRole("button", { name: "Prompt" }));
	await user.type(screen.getByLabelText("Prompt"), "Build a small feature");
	await user.click(screen.getByRole("button", { name: "Start run" }));

	await waitFor(() => {
		expect(fetchMock).toHaveBeenCalledWith(
			`${ORIGIN}/runs`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					workItemRequest: { source: "prompt", text: "Build a small feature" },
				}),
			}),
		);
	});
});

it("requires a work-item input before starting", async () => {
	const user = userEvent.setup();
	const fetchMock = mockEmptyServer();
	render(<App />);
	await connect(user);
	await user.click(screen.getByRole("link", { name: "New run" }));
	await user.click(screen.getByRole("button", { name: "Start run" }));

	expect(fetchMock).not.toHaveBeenCalledWith(
		`${ORIGIN}/runs`,
		expect.objectContaining({ method: "POST" }),
	);
	expect(screen.getByLabelText("Jira key")).toBeInvalid();
});

it("reports an invalid token distinctly", async () => {
	const invalid = vi.fn(async () =>
		jsonResponse(401, {
			code: "unauthorized",
			message: "invalid bearer token",
		}),
	);
	vi.stubGlobal("fetch", invalid);
	render(<App />);
	const user = userEvent.setup();
	await connect(user);
	expect(await screen.findByRole("alert")).toHaveTextContent(/invalid token/i);
});

it("reports a network failure as an unavailable server", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		}),
	);
	render(<App />);
	const user = userEvent.setup();
	await user.type(screen.getByLabelText("Server token"), TOKEN);
	await user.click(screen.getByRole("button", { name: "Connect" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(/cannot connect/i);
});

it("shows server validation errors without losing an empty run list", async () => {
	const user = userEvent.setup();
	const fetchMock = mockEmptyServer(
		jsonResponse(400, {
			code: "invalid_request",
			message: "repo must be absolute",
		}),
	);
	render(<App />);
	await connect(user);
	await user.click(screen.getByRole("link", { name: "New run" }));
	await user.type(screen.getByLabelText("Jira key"), "ABC-123");
	await user.type(
		screen.getByLabelText("Repository override (optional)"),
		"relative",
	);
	await user.click(screen.getByRole("button", { name: "Start run" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"repo must be absolute",
	);
	expect(fetchMock).toHaveBeenCalledWith(
		`${ORIGIN}/runs`,
		expect.objectContaining({
			method: "POST",
			body: JSON.stringify({
				workItemRequest: { source: "jira", key: "ABC-123" },
				repo: "relative",
			}),
		}),
	);
	expect(screen.getByText("No runs yet")).toBeInTheDocument();
});

it("shows server startup errors from a rejected start request", async () => {
	const user = userEvent.setup();
	mockEmptyServer(
		jsonResponse(503, {
			code: "starting",
			message: "server is still starting",
		}),
	);
	render(<App />);
	await connect(user);
	await user.click(screen.getByRole("link", { name: "New run" }));
	await user.type(screen.getByLabelText("Jira key"), "ABC-123");
	await user.click(screen.getByRole("button", { name: "Start run" }));

	expect(await screen.findByRole("alert")).toHaveTextContent(
		"server is still starting",
	);
});

it("opens a directly addressed run, switches runs, and follows browser back", async () => {
	const RUN_B = "7f1f1b1e-2b4c-4f7a-9d3e-2f4a5b6c7d8e";
	window.history.pushState({}, "", `/runs/${RUN_ID}`);
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			expect(url).not.toContain(TOKEN);
			expect(
				(init?.headers as Record<string, string> | undefined)?.Authorization,
			).toBe(`Bearer ${TOKEN}`);
			if (url === `${ORIGIN}/doctor`)
				return jsonResponse(200, { ok: true, checks: [] });
			if (url === `${ORIGIN}/runs`)
				return jsonResponse(200, {
					runs: [
						runSummary(RUN_ID),
						{
							...runSummary(RUN_B),
							workItem: {
								source: "jira",
								title: "Second fake run",
								key: "ABC-456",
							},
						},
					],
				});
			if (url === `${ORIGIN}/runs/${RUN_ID}`)
				return jsonResponse(200, runSummary(RUN_ID));
			if (
				url === `${ORIGIN}/runs/${RUN_ID}/review` ||
				url === `${ORIGIN}/runs/${RUN_B}/review`
			)
				return jsonResponse(200, runReview());
			if (url === `${ORIGIN}/runs/${RUN_B}`)
				return jsonResponse(200, {
					...runSummary(RUN_B),
					workItem: {
						source: "jira",
						title: "Second fake run",
						key: "ABC-456",
					},
				});
			if (url.endsWith("/events")) return jsonResponse(200, { events: [] });
			if (url.includes("/events/stream"))
				return new Response(new ReadableStream({ start() {} }), {
					headers: { "Content-Type": "text/event-stream" },
				});
			throw new Error(`unexpected request ${url}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const user = userEvent.setup();
	render(<App />);
	await connect(user);
	expect(
		await screen.findByRole("heading", { name: "Fake run" }),
	).toBeInTheDocument();
	expect(await screen.findByText("Live")).toBeInTheDocument();

	await user.selectOptions(
		screen.getByRole("combobox", { name: "Select run" }),
		RUN_B,
	);
	expect(window.location.pathname).toBe(`/runs/${RUN_B}`);
	expect(
		await screen.findByRole("heading", { name: "Second fake run" }),
	).toBeInTheDocument();

	window.history.back();
	await waitFor(() => expect(window.location.pathname).toBe(`/runs/${RUN_ID}`));
	expect(
		await screen.findByRole("heading", { name: "Fake run" }),
	).toBeInTheDocument();
});

it("rejects malformed run IDs without requesting a run", async () => {
	window.history.pushState({}, "", "/runs/not-a-run-id");
	const fetchMock = mockEmptyServer();
	const user = userEvent.setup();
	render(<App />);
	await user.type(screen.getByLabelText("Server token"), TOKEN);
	await user.click(screen.getByRole("button", { name: "Connect" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"This run URL is invalid",
	);
	expect(
		fetchMock.mock.calls.some(([url]) => String(url).includes("not-a-run-id")),
	).toBe(false);
});

it("returns home from a run and forgets the token on disconnect", async () => {
	window.history.pushState({}, "", `/runs/${RUN_ID}`);
	mockEmptyServer();
	const user = userEvent.setup();
	render(<App />);
	await connect(user);
	await screen.findByRole("heading", { name: "Fake run" });
	await user.click(screen.getByRole("link", { name: /Payo/ }));
	expect(window.location.pathname).toBe("/");
	expect(screen.getByRole("heading", { name: "New run" })).toBeInTheDocument();
	await user.click(screen.getByRole("link", { name: "Server status" }));
	await user.click(screen.getByRole("button", { name: "Change token" }));
	expect(screen.getByLabelText("Server token")).toHaveValue("");
	expect(screen.queryByRole("heading", { name: "Recent runs" })).toBeNull();
});

it("opens only the selected run's swarm and stops its stream on return", async () => {
	let streamSignal: AbortSignal | null | undefined;
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/doctor"))
				return jsonResponse(200, { ok: true, checks: [] });
			if (url.endsWith("/runs"))
				return jsonResponse(200, { runs: [runSummary(RUN_ID)] });
			if (url.endsWith(`/runs/${RUN_ID}`))
				return jsonResponse(200, runSummary(RUN_ID));
			if (url.endsWith("/review")) return jsonResponse(200, runReview());
			if (url.endsWith("/events")) return jsonResponse(200, { events: [] });
			if (url.includes("/events/stream")) {
				streamSignal = init?.signal;
				return new Response(new ReadableStream({ start() {} }));
			}
			throw new Error(`unexpected request ${url}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	const user = userEvent.setup();
	render(<App />);
	await connect(user);
	await screen.findByRole("link", { name: /Fake run/ });
	expect(
		fetchMock.mock.calls.some(([url]) => String(url).includes("/events")),
	).toBe(false);
	await user.click(screen.getByRole("link", { name: /Fake run/ }));
	expect(
		await screen.findByRole("heading", { name: "Fake run" }),
	).toBeInTheDocument();
	await screen.findByText("Live");
	expect(screen.getByRole("heading", { name: "Swarm" })).toBeInTheDocument();
	await user.click(screen.getByRole("link", { name: /Payo/ }));
	expect(streamSignal?.aborted).toBe(true);
	expect(screen.getByRole("heading", { name: "New run" })).toBeInTheDocument();
});

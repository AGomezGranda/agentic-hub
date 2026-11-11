// @vitest-environment jsdom
import type { ConfigSettingsSnapshot } from "@payo/contracts";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PayoApiError } from "@web/shared/api/client.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getConfigSettings, saveConfigSettings } from "./api.ts";
import { SettingsPage } from "./SettingsPage.tsx";

vi.mock("./api.ts", () => ({
	getConfigSettings: vi.fn(),
	saveConfigSettings: vi.fn(),
}));

const loaded: ConfigSettingsSnapshot = {
	configFile: "/home/me/.config/payo/config.toml",
	revision: "rev-1",
	document: {
		server: {
			port: 7331,
			web_origins: ["http://127.0.0.1:5173", "http://localhost:3000"],
		},
		paths: { data_dir: "/data", repo: "/repo", base_branch: "main" },
		execution: {
			max_concurrent_agents: 4,
			checks: [
				{
					name: "unit",
					command: "pnpm",
					args: ["test"],
					timeout_ms: 120000,
				},
			],
		},
		tools: { pi: "pi", acli: "acli", git: "git" },
		model: { provider: "anthropic", id: "claude" },
		roles: {
			planner: {
				timeout_ms: 180000,
				model: { provider: "openai", id: "o3" },
			},
			implementer: { timeout_ms: 240000 },
		},
	},
	environmentOverrides: [],
};

function renderPage() {
	const onDirtyChange = vi.fn();
	render(<SettingsPage token="token" onDirtyChange={onDirtyChange} />);
	return { onDirtyChange };
}

async function renderLoaded() {
	const result = renderPage();
	await screen.findByLabelText("Server port");
	return result;
}

beforeEach(() => {
	vi.mocked(getConfigSettings).mockResolvedValue(loaded);
	vi.mocked(saveConfigSettings).mockResolvedValue(loaded);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	sessionStorage.clear();
});

it("renders and edits fields from every supported section", async () => {
	const user = userEvent.setup();
	const { onDirtyChange } = await renderLoaded();

	expect(
		screen.getByText("/home/me/.config/payo/config.toml"),
	).toBeInTheDocument();
	for (const label of [
		"Server port",
		"Allowed web origins",
		"Data directory",
		"Repository",
		"Base branch",
		"Max concurrent agents",
		"Pi executable",
		"ACLI executable",
		"Git executable",
		"Global provider",
		"Global model ID",
		"Planner provider",
		"Planner model ID",
		"Planner timeout (ms)",
		"Reviewer provider",
		"Verifier provider",
		"Reviser provider",
	])
		expect(screen.getByLabelText(label)).toBeInTheDocument();

	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "7444");
	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");
	await user.type(screen.getByLabelText("Reviser model ID"), "claude");
	expect(screen.getByLabelText("Server port")).toHaveValue(7444);
	expect(screen.getByLabelText("Base branch")).toHaveValue("develop");
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
});

it("preserves omitted keys and role inheritance", async () => {
	const user = userEvent.setup();
	vi.mocked(getConfigSettings).mockResolvedValue({
		...loaded,
		revision: "rev-empty",
		document: { model: { provider: "anthropic", id: "claude" } },
	});
	await renderLoaded();

	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");
	await user.click(screen.getByRole("button", { name: "Save settings" }));

	await waitFor(() =>
		expect(saveConfigSettings).toHaveBeenCalledWith("token", {
			revision: "rev-empty",
			document: {
				model: { provider: "anthropic", id: "claude" },
				paths: { base_branch: "develop" },
			},
		}),
	);
});

it("associates validation errors with controls and announces the failure", async () => {
	const user = userEvent.setup();
	await renderLoaded();

	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "0");
	await user.clear(screen.getByLabelText("Data directory"));
	await user.type(screen.getByLabelText("Data directory"), "relative");
	await user.clear(screen.getByLabelText("Global model ID"));

	await user.click(screen.getByRole("button", { name: "Save settings" }));

	expect(saveConfigSettings).not.toHaveBeenCalled();
	expect(screen.getByLabelText("Server port")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	expect(screen.getByLabelText("Data directory")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	const modelId = screen.getByLabelText("Global model ID");
	expect(modelId).toHaveAttribute("aria-invalid", "true");
	expect(modelId.getAttribute("aria-describedby")).toContain(
		"settings-model-id-error",
	);
	expect(
		screen.getByText(/Complete the provider\/model pair/),
	).toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent(
		/Fix the highlighted settings/,
	);
});

it("does not rewrite the file when nothing changed", async () => {
	await renderLoaded();

	expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
	expect(saveConfigSettings).not.toHaveBeenCalled();
});

it("sends the complete valid document and expected revision", async () => {
	const user = userEvent.setup();
	await renderLoaded();

	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "7444");
	await user.clear(screen.getByLabelText("Planner provider"));
	await user.clear(screen.getByLabelText("Planner model ID"));

	await user.click(screen.getByRole("button", { name: "Save settings" }));

	await waitFor(() =>
		expect(saveConfigSettings).toHaveBeenCalledWith("token", {
			revision: "rev-1",
			document: {
				...loaded.document,
				server: {
					port: 7444,
					web_origins: ["http://127.0.0.1:5173", "http://localhost:3000"],
				},
				roles: {
					planner: { timeout_ms: 180000 },
					implementer: { timeout_ms: 240000 },
				},
			},
		}),
	);
});

it("round-trips execution checks and the implementer role it does not expose", async () => {
	const user = userEvent.setup();
	await renderLoaded();
	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");

	await user.click(screen.getByRole("button", { name: "Save settings" }));

	await waitFor(() =>
		expect(saveConfigSettings).toHaveBeenCalledWith("token", {
			revision: "rev-1",
			document: {
				...loaded.document,
				paths: { data_dir: "/data", repo: "/repo", base_branch: "develop" },
			},
		}),
	);
});

it("shows saved and restart messaging", async () => {
	const user = userEvent.setup();
	vi.mocked(saveConfigSettings).mockResolvedValue({
		...loaded,
		revision: "rev-2",
	});
	await renderLoaded();
	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");

	await user.click(screen.getByRole("button", { name: "Save settings" }));

	expect(await screen.findByRole("status")).toHaveTextContent(
		/Saved\. Restart Payo/,
	);
});

it("keeps edits made while a save is in flight", async () => {
	const user = userEvent.setup();
	let resolveSave: ((snapshot: ConfigSettingsSnapshot) => void) | undefined;
	vi.mocked(saveConfigSettings).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveSave = resolve;
			}),
	);
	await renderLoaded();
	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");
	await user.click(screen.getByRole("button", { name: "Save settings" }));

	await user.clear(screen.getByLabelText("Global model ID"));
	await user.type(screen.getByLabelText("Global model ID"), "claude-2");
	resolveSave?.({ ...loaded, revision: "rev-2" });

	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled(),
	);
	expect(screen.getByLabelText("Global model ID")).toHaveValue("claude-2");
	expect(screen.getByRole("status")).toHaveTextContent(
		/Newer edits remain unsaved/,
	);
});

it("keeps the draft on a server error and on a stale revision", async () => {
	const user = userEvent.setup();
	await renderLoaded();
	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "7444");

	vi.mocked(saveConfigSettings).mockRejectedValueOnce(
		new PayoApiError(500, "internal", "internal server error"),
	);
	await user.click(screen.getByRole("button", { name: "Save settings" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"internal server error",
	);
	expect(screen.getByLabelText("Server port")).toHaveValue(7444);

	vi.mocked(saveConfigSettings).mockRejectedValueOnce(
		new PayoApiError(409, "conflict", "config file changed"),
	);
	await user.click(screen.getByRole("button", { name: "Save settings" }));
	expect(await screen.findByRole("alert")).toHaveTextContent(
		/changed since it was loaded/,
	);
	expect(screen.getByLabelText("Server port")).toHaveValue(7444);
	expect(
		screen.getByRole("button", { name: "Reload latest" }),
	).toBeInTheDocument();

	await user.clear(screen.getByLabelText("Base branch"));
	await user.type(screen.getByLabelText("Base branch"), "develop");
	expect(
		screen.getByRole("button", { name: "Reload latest" }),
	).toBeInTheDocument();
});

it("reloads the latest snapshot after a conflict", async () => {
	const user = userEvent.setup();
	await renderLoaded();
	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "7444");
	vi.mocked(saveConfigSettings).mockRejectedValueOnce(
		new PayoApiError(409, "conflict", "config file changed"),
	);
	await user.click(screen.getByRole("button", { name: "Save settings" }));
	await screen.findByRole("button", { name: "Reload latest" });

	vi.mocked(getConfigSettings).mockResolvedValue({
		...loaded,
		revision: "rev-2",
		document: { server: { port: 7555 } },
	});
	await user.click(screen.getByRole("button", { name: "Reload latest" }));

	await waitFor(() =>
		expect(screen.getByLabelText("Server port")).toHaveValue(7555),
	);
	expect(screen.queryByRole("alert")).toBeNull();
});

it("shows active environment override names without values", async () => {
	vi.mocked(getConfigSettings).mockResolvedValue({
		...loaded,
		environmentOverrides: ["PAYO_MODEL", "PAYO_PORT"],
	});
	await renderLoaded();

	expect(screen.getByText("PAYO_MODEL")).toBeInTheDocument();
	expect(screen.getByText("PAYO_PORT")).toBeInTheDocument();
	expect(screen.getByText(/override saved TOML values/)).toBeInTheDocument();
});

it("warns when the current page origin would be excluded", async () => {
	const user = userEvent.setup();
	vi.mocked(getConfigSettings).mockResolvedValue({
		...loaded,
		document: { server: { web_origins: ["http://127.0.0.1:5173"] } },
	});
	await renderLoaded();

	expect(
		screen.getByText(
			new RegExp(
				`This page's origin \\(${window.location.origin}\\) is not in the allowed web origins`,
			),
		),
	).toBeInTheDocument();

	await user.type(
		screen.getByLabelText("Allowed web origins"),
		`\n${window.location.origin}`,
	);
	expect(screen.queryByText(/is not in the allowed web origins/)).toBeNull();
});

it("restores the loaded document when changes are discarded", async () => {
	const user = userEvent.setup();
	const { onDirtyChange } = await renderLoaded();
	await user.clear(screen.getByLabelText("Server port"));
	await user.type(screen.getByLabelText("Server port"), "7444");
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

	await user.click(screen.getByRole("button", { name: "Discard changes" }));

	expect(screen.getByLabelText("Server port")).toHaveValue(7331);
	await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
});

it("edits and round-trips publication fields and multiline body while preserving hidden settings", async () => {
	const user = userEvent.setup();
	vi.mocked(saveConfigSettings).mockImplementation(async (_token, input) => ({
		...loaded,
		revision: "rev-2",
		document: input.document,
	}));
	await renderLoaded();
	const values = {
		"GitHub CLI executable": "/opt/gh",
		"Publication remote": "upstream",
		"Ticketed branch template": "{ticketId}/fix-{slug}",
		"Ticketed commit template": "[{ticketId}] Fix {description}",
		"Ticketed PR title template": "[{ticketId}] Add {description}",
		"PR body template": "## Summary\n{summary}\n\n## Checks\n{checks}",
	};
	for (const [label, value] of Object.entries(values))
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	await user.click(screen.getByRole("button", { name: "Save settings" }));
	await screen.findByText("Saved. Restart Payo to apply these settings.");
	const document = {
		...loaded.document,
		tools: { ...loaded.document.tools, gh: "/opt/gh" },
		publication: {
			remote: "upstream",
			branch_template: values["Ticketed branch template"],
			commit_template: values["Ticketed commit template"],
			pr_title_template: values["Ticketed PR title template"],
			pr_body_template: values["PR body template"],
		},
	};
	expect(saveConfigSettings).toHaveBeenCalledWith("token", {
		revision: loaded.revision,
		document,
	});
	for (const [label, value] of Object.entries(values))
		expect(screen.getByLabelText(label)).toHaveValue(value);
});

it("preserves publication settings on unrelated saves and displays server policy errors", async () => {
	const user = userEvent.setup();
	const publication = {
		remote: "upstream",
		branch_template: "{ticketId}/{slug}",
		commit_template: "[{ticketId}] {description}",
		pr_title_template: "[{ticketId}] {description}",
		pr_body_template: "Line one\n{summary}\n",
	};
	const document = {
		...loaded.document,
		publication,
		tools: { gh: "/opt/gh" },
	};
	vi.mocked(getConfigSettings).mockResolvedValue({ ...loaded, document });
	vi.mocked(saveConfigSettings).mockRejectedValue(
		new PayoApiError(
			400,
			"invalid_request",
			"publication.commit_template: must retain the exact ticket prefix",
		),
	);
	await renderLoaded();
	fireEvent.change(screen.getByLabelText("Base branch"), {
		target: { value: "develop" },
	});
	await user.click(screen.getByRole("button", { name: "Save settings" }));
	expect(saveConfigSettings).toHaveBeenCalledWith("token", {
		revision: loaded.revision,
		document: {
			...document,
			paths: { ...document.paths, base_branch: "develop" },
		},
	});
	expect(await screen.findByRole("alert")).toHaveTextContent(
		"publication.commit_template: must retain the exact ticket prefix",
	);
});

it("preserves an explicitly empty PR body template on an unrelated save", async () => {
	const document = {
		...loaded.document,
		publication: { pr_body_template: "" },
	};
	vi.mocked(getConfigSettings).mockResolvedValue({ ...loaded, document });
	await renderLoaded();
	fireEvent.change(screen.getByLabelText("Base branch"), {
		target: { value: "develop" },
	});
	await userEvent
		.setup()
		.click(screen.getByRole("button", { name: "Save settings" }));
	expect(saveConfigSettings).toHaveBeenCalledWith("token", {
		revision: loaded.revision,
		document: {
			...document,
			paths: { ...document.paths, base_branch: "develop" },
		},
	});
});

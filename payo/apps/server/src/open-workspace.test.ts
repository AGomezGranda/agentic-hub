import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { openWorkspace } from "./open-workspace.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	vi.resetAllMocks();
	if (platform) Object.defineProperty(process, "platform", platform);
});
function directory(os: string) {
	Object.defineProperty(process, "platform", { value: os });
	vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
		ReturnType<typeof stat>
	>);
	vi.mocked(execFile).mockImplementation(((
		_command: string,
		_args: string[],
		_options: unknown,
		callback: (error: Error | null) => void,
	) => {
		callback(null);
	}) as typeof execFile);
}
it.each(["terminal", "vscode"] as const)(
	"opens %s on macOS with the directory as a separate argument",
	async (target) => {
		directory("darwin");
		const path = "/tmp/repo with 'quotes';$(echo injected)";
		await openWorkspace(path, target);
		expect(execFile).toHaveBeenCalledWith(
			"open",
			["-a", target === "terminal" ? "Terminal" : "Visual Studio Code", path],
			{ cwd: path, timeout: 10_000 },
			expect.any(Function),
		);
	},
);
it("opens VS Code on Linux", async () => {
	directory("linux");
	await openWorkspace("/tmp/repo", "vscode");
	expect(execFile).toHaveBeenCalledWith(
		"code",
		["--new-window", "/tmp/repo"],
		expect.any(Object),
		expect.any(Function),
	);
});
it("detaches a Linux terminal without waiting for the terminal to close", async () => {
	directory("linux");
	const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
	vi.mocked(spawn).mockReturnValue(
		child as unknown as ReturnType<typeof spawn>,
	);
	const opening = openWorkspace("/tmp/repo", "terminal");
	await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
	child.emit("spawn");
	await opening;
	expect(child.unref).toHaveBeenCalled();
	expect(spawn).toHaveBeenCalledWith(
		"x-terminal-emulator",
		[
			"-e",
			"sh",
			"-c",
			'cd -- "$1" && exec "$2"',
			"sh",
			"/tmp/repo",
			process.env.SHELL ?? "/bin/sh",
		],
		{ cwd: "/tmp/repo", detached: true, stdio: "ignore" },
	);
});
it("rejects missing directories and unsupported platforms without launching", async () => {
	directory("freebsd");
	await expect(openWorkspace("/tmp/repo", "terminal")).rejects.toMatchObject({
		status: 501,
	});
	vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
	await expect(openWorkspace("/missing", "vscode")).rejects.toMatchObject({
		status: 409,
	});
	await expect(openWorkspace("relative", "vscode")).rejects.toMatchObject({
		status: 409,
	});
	expect(execFile).not.toHaveBeenCalled();
	expect(spawn).not.toHaveBeenCalled();
});
it("reports launcher failures", async () => {
	directory("darwin");
	vi.mocked(execFile).mockImplementation(((
		_command: string,
		_args: string[],
		_options: unknown,
		callback: (error: Error) => void,
	) => {
		callback(new Error("missing app"));
	}) as typeof execFile);
	await expect(openWorkspace("/tmp/repo", "vscode")).rejects.toMatchObject({
		status: 503,
		code: "launch_failed",
	});
});

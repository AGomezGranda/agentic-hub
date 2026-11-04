import { execFile } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { normalizePickedPath, pickDirectory } from "./directory-picker.ts";
import { FolderDialogUnavailable } from "./errors.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

type DialogAnswer =
	| { stdout: string }
	| { code: string | number | null; killed?: boolean; signal?: NodeJS.Signals };

/** Each dialog command answers with stdout, or fails with an exit code, spawn error code, or timeout kill. */
function dialogs(answers: Record<string, DialogAnswer>): void {
	execFileMock.mockImplementation(((
		command: string,
		_args: readonly string[],
		_options: unknown,
		callback: (error: Error | null, stdout: string) => void,
	) => {
		const answer = answers[command];
		if (!answer) throw new Error(`unexpected dialog command ${command}`);
		if ("stdout" in answer) callback(null, answer.stdout);
		else callback(Object.assign(new Error(`${command} failed`), answer), "");
	}) as unknown as typeof execFile);
}

function onPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform });
}

function commandsRun(): unknown[] {
	return execFileMock.mock.calls.map(([command]) => command);
}

afterEach(() => {
	execFileMock.mockReset();
	if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
});

it("normalizes dialog output to a path without a trailing separator", () => {
	expect(normalizePickedPath("/Users/me/repo/\n")).toBe("/Users/me/repo");
	expect(normalizePickedPath("/\n")).toBe("/");
	expect(normalizePickedPath("C:\\\n")).toBe("C:\\");
	expect(normalizePickedPath("  \n")).toBeNull();
});

it("falls through from a missing dialog command to the next candidate", async () => {
	onPlatform("linux");
	dialogs({
		zenity: { code: "ENOENT" },
		kdialog: { stdout: "/home/me/repo/\n" },
	});
	await expect(pickDirectory()).resolves.toBe("/home/me/repo");
	expect(commandsRun()).toEqual(["zenity", "kdialog"]);
});

it("resolves null when the user cancels the dialog without trying the next candidate", async () => {
	onPlatform("linux");
	dialogs({ zenity: { code: 1 } });
	await expect(pickDirectory()).resolves.toBeNull();
	expect(commandsRun()).toEqual(["zenity"]);
});

it("resolves null when the dialog is killed at its timeout", async () => {
	onPlatform("linux");
	dialogs({ zenity: { code: null, killed: true, signal: "SIGTERM" } });
	await expect(pickDirectory()).resolves.toBeNull();
	expect(commandsRun()).toEqual(["zenity"]);
});

it("rejects dialog errors other than a missing command or cancel", async () => {
	onPlatform("linux");
	dialogs({ zenity: { code: "EACCES" } });
	await expect(pickDirectory()).rejects.toThrow("zenity failed");
	expect(commandsRun()).toEqual(["zenity"]);
});

it("throws FolderDialogUnavailable when no dialog command is installed", async () => {
	onPlatform("linux");
	dialogs({ zenity: { code: "ENOENT" }, kdialog: { code: "ENOENT" } });
	const error = await pickDirectory().catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(FolderDialogUnavailable);
	expect(error).toMatchObject({
		message:
			"no folder dialog is available on this machine; type the path instead",
	});
});

it("opens the macOS folder dialog with osascript", async () => {
	onPlatform("darwin");
	dialogs({ osascript: { stdout: "/Users/me/repo\n" } });
	await expect(pickDirectory()).resolves.toBe("/Users/me/repo");
	expect(commandsRun()).toEqual(["osascript"]);
});

it("opens the Windows folder dialog with PowerShell", async () => {
	onPlatform("win32");
	dialogs({ powershell: { stdout: "C:\\Repos\\payo\\\n" } });
	await expect(pickDirectory()).resolves.toBe("C:\\Repos\\payo");
	expect(commandsRun()).toEqual(["powershell"]);
});

it("throws FolderDialogUnavailable on a platform with no dialog command", async () => {
	onPlatform("freebsd");
	dialogs({});
	const error = await pickDirectory().catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(FolderDialogUnavailable);
	expect(commandsRun()).toEqual([]);
});

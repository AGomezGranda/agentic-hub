import { execFile } from "node:child_process";
import { FolderDialogUnavailable } from "./errors.ts";

/** Opens the OS folder dialog on the server's machine; resolves null if cancelled. */
export type DirectoryPicker = () => Promise<string | null>;

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000;

// shortcut: Linux needs zenity or kdialog installed, Windows uses PowerShell; add more when asked.
const COMMANDS: Record<string, [string, string[]][]> = {
	darwin: [
		[
			"osascript",
			["-e", 'POSIX path of (choose folder with prompt "Select repository")'],
		],
	],
	linux: [
		[
			"zenity",
			["--file-selection", "--directory", "--title=Select repository"],
		],
		["kdialog", ["--getexistingdirectory", "."]],
	],
	win32: [
		[
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
			],
		],
	],
};

export function normalizePickedPath(stdout: string): string | null {
	const path = stdout.trim();
	if (!path) return null;
	if (/^([A-Za-z]:)?[\\/]$/.test(path)) return path;
	return path.replace(/[\\/]+$/, "");
}

function run(
	command: string,
	args: string[],
): Promise<{ stdout: string } | "missing" | "cancelled"> {
	return new Promise((resolve, reject) => {
		execFile(command, args, { timeout: DIALOG_TIMEOUT_MS }, (error, stdout) => {
			if (!error) return resolve({ stdout });
			const { code, killed } = error;
			if (code === "ENOENT") return resolve("missing");
			// Cancel exits 1 (zenity, kdialog, osascript -128).
			if (typeof code === "number" && code === 1) return resolve("cancelled");
			// A dialog left open past DIALOG_TIMEOUT_MS is killed by execFile.
			if (killed) return resolve("cancelled");
			reject(error);
		});
	});
}

export const pickDirectory: DirectoryPicker = async () => {
	const candidates = COMMANDS[process.platform] ?? [];
	for (const [command, args] of candidates) {
		const result = await run(command, args);
		if (result === "missing") continue;
		if (result === "cancelled") return null;
		return normalizePickedPath(result.stdout);
	}
	throw new FolderDialogUnavailable(
		"no folder dialog is available on this machine; type the path instead",
	);
};

import { basename } from "node:path";
import type { ExtensionAPI, SourceInfo, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, type Color, foregroundAnsi, rgbColor, truncateToWidth } from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";
const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const fg = (c: Color) => foregroundAnsi(c, "truecolor");
const bg = (c: Color) => backgroundAnsi(c, "truecolor");

// Pixel map of Pi's built-in logo (dist/modes/interactive/components/pi-logo.js). SCALE enlarges it.
const PIXELS = ["CCC.", "B.C.", "BB.Y", "B..Y"];
const PALETTE: Record<string, Color | undefined> = { C: CORAL, B: BLUE, Y: YELLOW };
const SCALE = 2;

function logoLines(): string[] {
	const grid: string[] = [];
	for (const row of PIXELS) {
		const wide = [...row].map((p) => p.repeat(SCALE)).join("");
		for (let i = 0; i < SCALE; i++) grid.push(wide);
	}
	// Each cell holds two pixels: ▀ takes the top one's color, the cell background the bottom one's.
	const lines: string[] = [];
	for (let y = 0; y < grid.length; y += 2) {
		let line = "";
		for (let x = 0; x < grid[y].length; x++) {
			const top = PALETTE[grid[y][x]];
			const bottom = PALETTE[grid[y + 1][x]];
			if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${RESET}`;
			else if (top) line += `${fg(top)}▀${RESET}`;
			else if (bottom) line += `${fg(bottom)}▄${RESET}`;
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}
const LOGO = logoLines();

function resourceLines(pi: ExtensionAPI, theme: Theme): string[] {
	const commands = pi.getCommands();
	// Package source is a spec such as "npm:@scope/name@1.2.3" or "git:github.com/owner/name".
	const extensionName = (info: SourceInfo) =>
		info.origin === "package"
			? (info.source.replace(/@[^/@]*$/, "").split(/[/:]/).pop() ?? info.source)
			: basename(info.path).replace(/\.(ts|js)$/, "");
	const extensions = new Set(
		[...commands.filter((c) => c.source === "extension"), ...pi.getAllTools()]
			.map((item) => item.sourceInfo)
			.filter((info) => !info.path.startsWith("builtin:"))
			.map(extensionName),
	);
	const sections: [string, string[]][] = [
		["Skills", commands.filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, ""))],
		["Prompts", commands.filter((c) => c.source === "prompt").map((c) => `/${c.name}`)],
		["Extensions", [...extensions]],
	];
	return sections
		.filter(([, items]) => items.length > 0)
		.flatMap(([name, items]) => [
			theme.fg("mdHeading", `[${name}]`),
			theme.fg("dim", `  ${items.sort().join(", ")}`),
		]);
}

export default function (pi: ExtensionAPI) {
	let showResources = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const info = [
					`${theme.bold("Pi")} ${theme.fg("dim", `v${VERSION}`)}`,
					`${theme.fg("accent", ctx.model?.id ?? "no model")} ${theme.fg("dim", `· ${basename(ctx.cwd)}`)}`,
					"",
					theme.fg("dim", "/ for commands · ! for bash · Esc to interrupt"),
				];
				return LOGO.map((logo, i) => truncateToWidth(`${logo}  ${info[i]}`, width));
			},
			invalidate() {},
		}));
	});

	pi.registerCommand("resources", {
		description: "Show or hide the loaded skills, prompts and extensions",
		handler: async (_args, ctx) => {
			showResources = !showResources;
			ctx.ui.setWidget("resources", showResources ? resourceLines(pi, ctx.ui.theme) : undefined);
		},
	});
}

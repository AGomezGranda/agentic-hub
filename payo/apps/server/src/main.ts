import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readPayoConfigDocument, writePayoConfigDocument } from "@payo/config";
import { ensureServerToken } from "./auth.ts";
import { type Composition, createComposition } from "./composition.ts";
import {
	assertRealModeModels,
	loadConfig,
	type ServerConfig,
} from "./config.ts";
import { pickDirectory } from "./directory-picker.ts";
import { runDoctor, startupBlockingFailures } from "./doctor.ts";
import { createHandler } from "./http.ts";
import { openWorkspace } from "./open-workspace.ts";
import { createConfigSettingsService } from "./settings.ts";

async function main(): Promise<void> {
	if (process.argv.includes("--check")) {
		process.exitCode = await preflight();
		return;
	}
	let config: ServerConfig;
	try {
		config = loadConfig();
	} catch (error) {
		fail(error);
		return;
	}
	if (!config.devFakes) {
		try {
			assertRealModeModels(config);
		} catch (error) {
			fail(error);
			return;
		}
		const failures = startupBlockingFailures(await runDoctor(config));
		if (failures.length > 0) {
			for (const check of failures)
				console.error(`payo doctor: FAIL ${check.name}: ${check.detail}`);
			process.exitCode = 1;
			return;
		}
	}

	const token = await ensureServerToken(config.dataDir);
	const configSettings = createConfigSettingsService({
		readConfig: readPayoConfigDocument,
		writeConfig: writePayoConfigDocument,
		configFile: config.configFile,
		env: process.env,
		cwd: process.cwd(),
		devFakes: config.devFakes,
	});
	let services: Composition | null = null;
	let port = config.port;
	const server = createServer(
		createHandler({
			token,
			webOrigins: config.webOrigins,
			getPort: () => port,
			getServices: () => services,
			configSettings,
			pickDirectory,
			openWorkspace,
		}),
	);

	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(config.port, "127.0.0.1", () => {
				server.off("error", reject);
				port = (server.address() as AddressInfo).port;
				console.log(`payo server listening on http://127.0.0.1:${port}`);
				resolve();
			});
		});
	} catch (error) {
		fail(error);
		return;
	}

	try {
		services = await createComposition({ config });
		console.log("payo server ready");
	} catch (error) {
		await shutdown(server, services);
		fail(error);
		return;
	}

	let shuttingDown = false;
	const stop = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`payo server stopping (${signal})`);
		await shutdown(server, services);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
}

/** Prints config, model and doctor checks without listening; port, token and composition stay serve-only. */
async function preflight(): Promise<number> {
	let config: ServerConfig;
	try {
		config = loadConfig();
	} catch (error) {
		console.error(`payo check: FAIL config: ${errorMessage(error)}`);
		return 1;
	}
	if (config.devFakes) {
		console.log("payo check: dev fakes selected; real-mode checks skipped");
		return 0;
	}
	try {
		assertRealModeModels(config);
	} catch (error) {
		console.error(`payo check: FAIL models: ${errorMessage(error)}`);
		return 1;
	}
	const report = await runDoctor(config);
	const blocking = new Set(startupBlockingFailures(report));
	for (const check of report.checks) {
		const label = check.ok ? "ok" : blocking.has(check) ? "FAIL" : "warn";
		console.log(`${label.padEnd(4)} ${check.name}: ${check.detail}`);
	}
	return blocking.size === 0 ? 0 : 1;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function shutdown(
	server: Server,
	services: Composition | null,
): Promise<void> {
	const closed = new Promise<void>((resolve) => server.close(() => resolve()));
	await services?.shutdown();
	server.closeAllConnections();
	await closed;
}

function fail(error: unknown): void {
	console.error(`payo serve: ${errorMessage(error)}`);
	process.exitCode = 1;
}

await main();

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ensureServerToken } from "./auth.ts";
import { type Composition, createComposition } from "./composition.ts";
import {
	assertRealModeModels,
	loadConfig,
	type ServerConfig,
} from "./config.ts";
import { runDoctor, startupBlockingFailures } from "./doctor.ts";
import { createHandler } from "./http.ts";
import { createConfigSettingsService } from "./settings.ts";

async function main(): Promise<void> {
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
	const message = error instanceof Error ? error.message : String(error);
	console.error(`payo serve: ${message}`);
	process.exitCode = 1;
}

await main();

import {
	activeEnvironmentOverrides,
	type readPayoConfigDocument,
	resolvePayoConfigDocument,
	type writePayoConfigDocument,
} from "@payo/config";
import {
	ConfigSettingsSnapshot,
	SaveConfigSettingsRequest,
} from "@payo/contracts";
import { validatePublicationPolicy } from "@payo/factory";
import { assertRealModeRoleModels } from "./config.ts";

export interface ConfigSettingsService {
	snapshot(): Promise<ConfigSettingsSnapshot>;
	save(request: SaveConfigSettingsRequest): Promise<ConfigSettingsSnapshot>;
}

export interface ConfigSettingsOptions {
	/** The startup-resolved path; requests never select a file. */
	configFile: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	devFakes: boolean;
	readConfig: typeof readPayoConfigDocument;
	writeConfig: typeof writePayoConfigDocument;
}

export function createConfigSettingsService(
	options: ConfigSettingsOptions,
): ConfigSettingsService {
	const { configFile, env, cwd, devFakes, readConfig, writeConfig } = options;

	function withOverrides(read: {
		configFile: string;
		revision: string;
		document: object;
	}): ConfigSettingsSnapshot {
		return ConfigSettingsSnapshot.parse({
			...read,
			environmentOverrides: activeEnvironmentOverrides(env),
		});
	}

	return {
		async snapshot() {
			return withOverrides(readConfig(configFile));
		},

		async save(request) {
			const input = SaveConfigSettingsRequest.parse(request);
			const candidate = resolvePayoConfigDocument(input.document, env, cwd);
			assertRealModeRoleModels(candidate.roles, devFakes);
			validatePublicationPolicy(candidate.publication);
			const written = await writeConfig(
				configFile,
				input.document,
				input.revision,
			);
			return withOverrides(written);
		},
	};
}

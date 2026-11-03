import {
	ConfigSettingsSnapshot,
	type SaveConfigSettingsRequest,
} from "@payo/contracts";
import { getJson } from "@web/shared/api/client.ts";

export async function getConfigSettings(
	token: string,
	signal?: AbortSignal,
): Promise<ConfigSettingsSnapshot> {
	return getJson(
		"/settings/config",
		token,
		"GET",
		(data) => ConfigSettingsSnapshot.parse(data),
		undefined,
		signal,
	);
}

export async function saveConfigSettings(
	token: string,
	request: SaveConfigSettingsRequest,
	signal?: AbortSignal,
): Promise<ConfigSettingsSnapshot> {
	return getJson(
		"/settings/config",
		token,
		"PUT",
		(data) => ConfigSettingsSnapshot.parse(data),
		request,
		signal,
	);
}

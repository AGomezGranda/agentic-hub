import { PickDirectoryResponse } from "@payo/contracts";
import { getJson } from "./client.ts";

/** Opens the native folder dialog on the machine running the server. */
export async function pickDirectory(token: string): Promise<string | null> {
	return getJson(
		"/system/pick-directory",
		token,
		"POST",
		(data) => PickDirectoryResponse.parse(data).path,
	);
}

import { PayoApiError } from "@web/shared/api/client.ts";

export function connectionMessage(error: unknown): string {
	if (error instanceof PayoApiError && error.status === 401)
		return "Invalid token. Check the value from `payo token` and connect again.";
	if (error instanceof PayoApiError)
		return `Payo server error (${error.status}): ${error.message}`;
	if (error instanceof TypeError)
		return "Cannot connect to Payo at 127.0.0.1:7331. Check that the local server is running.";
	return "Could not read the server response. Check that the web app and Payo server are compatible.";
}

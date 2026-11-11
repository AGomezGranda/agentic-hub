import { ApiError as ApiErrorSchema } from "@payo/contracts";

export const DEFAULT_SERVER_PORT = 7331;

const SERVER_PORT_KEY = "payo.server-port";

export function getServerPort(): number {
	const stored = sessionStorage.getItem(SERVER_PORT_KEY);
	if (stored === null) return DEFAULT_SERVER_PORT;
	const port = Number(stored);
	return isServerPort(port) ? port : DEFAULT_SERVER_PORT;
}

export function setServerPort(port: number): void {
	if (!isServerPort(port))
		throw new Error("Server port must be a whole number between 1 and 65535.");
	sessionStorage.setItem(SERVER_PORT_KEY, String(port));
}

export function getApiBaseUrl(): string {
	return `http://127.0.0.1:${getServerPort()}/api/v1`;
}

function isServerPort(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export class PayoApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PayoApiError";
	}
}

export function bearerAuthorization(token: string): string {
	if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token))
		throw new PayoApiError(
			401,
			"invalid_token",
			"Invalid token. Paste only the token printed by `payo token`, without quotes or extra text.",
		);
	return `Bearer ${token}`;
}

export async function getJson<T>(
	path: string,
	token: string,
	method: "GET" | "POST" | "PUT",
	parse: (data: unknown) => T,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(`${getApiBaseUrl()}${path}`, {
		method,
		headers: {
			Accept: "application/json",
			Authorization: bearerAuthorization(token),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if (!response.ok) {
		const failure = ApiErrorSchema.safeParse(data);
		throw new PayoApiError(
			response.status,
			failure.success ? failure.data.code : "request_failed",
			failure.success ? failure.data.message : "The server returned an error.",
		);
	}
	return parse(data);
}

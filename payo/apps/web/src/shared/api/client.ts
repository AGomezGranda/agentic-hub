import { ApiError as ApiErrorSchema } from "@payo/contracts";

export const API_BASE_URL = "http://127.0.0.1:7331/api/v1";

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

export async function getJson<T>(
	path: string,
	token: string,
	method: "GET" | "POST",
	parse: (data: unknown) => T,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(`${API_BASE_URL}${path}`, {
		method,
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
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

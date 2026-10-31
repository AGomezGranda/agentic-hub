import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TOKEN_FILE = "server-token";

export function tokenPath(dataDir: string): string {
	return join(dataDir, TOKEN_FILE);
}

async function ownerOnly(path: string, mode: number): Promise<void> {
	if (process.platform !== "win32") await chmod(path, mode);
}

/** Creates the data directory owner-only and corrects the mode on an existing one. */
export async function ensureDataDir(dataDir: string): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	await ownerOnly(dataDir, 0o700);
}

/** Returns the persisted 256-bit token, creating it owner-only on first use. */
export async function ensureServerToken(dataDir: string): Promise<string> {
	await ensureDataDir(dataDir);
	const path = tokenPath(dataDir);
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (existing) {
			await ownerOnly(path, 0o600);
			return existing;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const token = randomBytes(32).toString("hex");
	try {
		await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = (await readFile(path, "utf8")).trim();
		if (!existing) throw new Error("token file exists but is empty");
		await ownerOnly(path, 0o600);
		return existing;
	}
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** Compares equal-length digests, so a wrong token does not leak matching bytes by timing. */
export function tokensEqual(provided: string, expected: string): boolean {
	return timingSafeEqual(digest(provided), digest(expected));
}

export function bearerToken(header: string | undefined): string | null {
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token || null;
}

export function isAuthorized(
	authorization: string | undefined,
	expected: string,
): boolean {
	const provided = bearerToken(authorization);
	return provided !== null && tokensEqual(provided, expected);
}

export function loopbackHosts(port: number): Set<string> {
	return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function isHostAllowed(host: string | undefined, port: number): boolean {
	return host !== undefined && loopbackHosts(port).has(host);
}

export function ownOrigin(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/** No Origin is a CLI request; an Origin must match ours or an exact configured origin. */
export function isOriginAllowed(
	origin: string | undefined,
	port: number,
	allowlist: readonly string[],
): boolean {
	if (origin === undefined) return true;
	if (origin === "*") return false;
	return origin === ownOrigin(port) || allowlist.includes(origin);
}

export function corsHeaders(
	origin: string | undefined,
	port: number,
	allowlist: readonly string[],
): Record<string, string> {
	if (origin === undefined || !isOriginAllowed(origin, port, allowlist))
		return {};
	return {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Headers":
			"authorization, content-type, last-event-id",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		Vary: "Origin",
	};
}

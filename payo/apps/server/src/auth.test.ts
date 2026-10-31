import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bearerToken,
	corsHeaders,
	ensureServerToken,
	isAuthorized,
	isHostAllowed,
	isOriginAllowed,
	tokenPath,
	tokensEqual,
} from "./auth.ts";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "payo-auth-"));
}

describe("server token", () => {
	it("creates a 256-bit owner-only token and reloads it", async () => {
		const dir = await tempDir();
		const first = await ensureServerToken(dir);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(await ensureServerToken(dir)).toBe(first);
		expect((await readFile(tokenPath(dir), "utf8")).trim()).toBe(first);
		if (process.platform !== "win32") {
			expect((await stat(dir)).mode & 0o077).toBe(0);
			expect((await stat(tokenPath(dir))).mode & 0o077).toBe(0);
		}
	});

	it("corrects an existing token file's permissions", async () => {
		if (process.platform === "win32") return;
		const dir = await tempDir();
		const token = await ensureServerToken(dir);
		await writeFile(tokenPath(dir), `${token}\n`);
		await import("node:fs/promises").then(({ chmod }) =>
			chmod(tokenPath(dir), 0o644),
		);
		await ensureServerToken(dir);
		expect((await stat(tokenPath(dir))).mode & 0o077).toBe(0);
	});

	it("accepts only a matching bearer token", () => {
		expect(bearerToken("Bearer abc")).toBe("abc");
		expect(bearerToken("Basic abc")).toBeNull();
		expect(bearerToken(undefined)).toBeNull();
		expect(tokensEqual("secret", "secret")).toBe(true);
		expect(tokensEqual("secret", "secreT")).toBe(false);
		expect(isAuthorized("Bearer secret", "secret")).toBe(true);
		expect(isAuthorized("Bearer wrong", "secret")).toBe(false);
		expect(isAuthorized(undefined, "secret")).toBe(false);
	});
});

describe("loopback origin checks", () => {
	const port = 7331;

	it("accepts only the bound loopback hosts", () => {
		expect(isHostAllowed("127.0.0.1:7331", port)).toBe(true);
		expect(isHostAllowed("localhost:7331", port)).toBe(true);
		expect(isHostAllowed("[::1]:7331", port)).toBe(true);
		expect(isHostAllowed("evil.example:7331", port)).toBe(false);
		expect(isHostAllowed("127.0.0.1:7332", port)).toBe(false);
		expect(isHostAllowed(undefined, port)).toBe(false);
	});

	it("treats no Origin as a CLI request and allowlists exact origins", () => {
		expect(isOriginAllowed(undefined, port, [])).toBe(true);
		expect(isOriginAllowed("http://127.0.0.1:7331", port, [])).toBe(true);
		expect(
			isOriginAllowed("http://localhost:3000", port, ["http://localhost:3000"]),
		).toBe(true);
		expect(
			isOriginAllowed("http://localhost:3001", port, ["http://localhost:3000"]),
		).toBe(false);
		expect(isOriginAllowed("*", port, ["*"])).toBe(false);
	});

	it("emits exact CORS headers, never a wildcard", () => {
		expect(corsHeaders(undefined, port, [])).toEqual({});
		expect(corsHeaders("http://localhost:3000", port, [])).toEqual({});
		const headers = corsHeaders("http://localhost:3000", port, [
			"http://localhost:3000",
		]);
		expect(headers["Access-Control-Allow-Origin"]).toBe(
			"http://localhost:3000",
		);
		expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
		expect(headers.Vary).toBe("Origin");
	});
});

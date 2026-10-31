import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type RunStore, StaleSeqError } from "@payo/kernel";
import { body, runStoreContract } from "@payo/kernel/testing";
import { describe, expect, it } from "vitest";
import { createSqliteRunStore } from "./index.ts";

const meta = { kind: "diff", mediaType: "text/x-diff" };
const bytes = (text: string) => new TextEncoder().encode(text);

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "payo-store-"));
}

// Each case gets its own data dir, removed afterwards.
runStoreContract("sqlite", async () => {
	const dataDir = tempDir();
	return {
		open: () => createSqliteRunStore({ dataDir }),
		dispose: async () => rmSync(dataDir, { recursive: true, force: true }),
	};
});

describe("createSqliteRunStore", () => {
	it("names the expected hash when an artifact is tampered with on disk", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			const ref = await store.putArtifact(bytes("hello"), meta);
			writeFileSync(join(dataDir, "artifacts", ref.sha256), "tampered");

			await expect(store.readArtifact(ref.sha256)).rejects.toThrow(
				new RegExp(`integrity.*${ref.sha256}`),
			);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("throws on read naming the run and seq when a row is malformed", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append("r1", [{ type: "run.ended", outcome: "approved" }], 0);
			const raw = new DatabaseSync(join(dataDir, "payo.db"));
			raw.exec("UPDATE events SET body = '{not json' WHERE run_id = 'r1'");
			raw.close();

			await expect(store.read("r1")).rejects.toThrow(/r1 seq 1/);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("refuses to open a file with an unknown schema version and does not migrate it", async () => {
		const dataDir = tempDir();
		try {
			const raw = new DatabaseSync(join(dataDir, "payo.db"));
			raw.exec("PRAGMA user_version = 2");
			raw.close();

			await expect(createSqliteRunStore({ dataDir })).rejects.toThrow(
				/schema version 2/,
			);
			const check = new DatabaseSync(join(dataDir, "payo.db"));
			expect(check.prepare("PRAGMA user_version").get()).toEqual({
				user_version: 2,
			});
			expect(check.prepare("PRAGMA journal_mode").get()).toEqual({
				journal_mode: "delete",
			});
			check.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("creates only payo.db (with its WAL files) and artifacts/ under the data dir", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append("r1", [{ type: "run.ended", outcome: "x" }], 0);
			const ref = await store.putArtifact(bytes("hello"), meta);
			const artifacts = readdirSync(join(dataDir, "artifacts"));
			await store.close();

			const allowed = new Set([
				"payo.db",
				"payo.db-wal",
				"payo.db-shm",
				"artifacts",
			]);
			const entries = readdirSync(dataDir);
			expect(entries).toContain("payo.db");
			expect(entries).toContain("artifacts");
			expect(entries.filter((name) => !allowed.has(name))).toEqual([]);
			expect(artifacts).toEqual([ref.sha256]);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("creates the data dir owner-only when the store creates it", async () => {
		const root = tempDir();
		const dataDir = join(root, "fresh");
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append("r1", [{ type: "run.ended", outcome: "x" }], 0);
			await store.putArtifact(bytes("hello"), meta);
			expect(existsSync(join(dataDir, "payo.db"))).toBe(true);
			expect(existsSync(join(dataDir, "payo.db-wal"))).toBe(true);

			for (const entry of readdirSync(dataDir, { recursive: true })) {
				expect(statSync(join(dataDir, String(entry))).mode & 0o077).toBe(0);
			}
			expect(statSync(dataDir).mode & 0o077).toBe(0);
			expect(statSync(join(dataDir, "artifacts")).mode & 0o077).toBe(0);
			await store.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid metadata and writes no artifact file", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await expect(
				store.putArtifact(bytes("x"), { kind: "", mediaType: "text/x-diff" }),
			).rejects.toThrow();
			expect(readdirSync(join(dataDir, "artifacts"))).toEqual([]);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("names a missing artifact as not found", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await expect(store.readArtifact("a".repeat(64))).rejects.toThrow(
				/not found/,
			);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("rethrows a read error that is not a missing file", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			mkdirSync(join(dataDir, "artifacts", "b".repeat(64)));
			await expect(store.readArtifact("b".repeat(64))).rejects.toThrow(
				/EISDIR/,
			);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("keeps two runs isolated in one store", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append(
				"r1",
				[body.runCreated("r1"), body.stepStarted("s1")],
				0,
			);
			await store.append("r2", [body.runCreated("r2")], 0);

			expect((await store.read("r1")).map((e) => e.seq)).toEqual([1, 2]);
			expect((await store.read("r2")).map((e) => e.seq)).toEqual([1]);
			expect(await store.listRunIds()).toEqual(["r1", "r2"]);

			await store.append("r2", [body.stepStarted("s2")], 1);
			expect((await store.read("r2")).map((e) => e.seq)).toEqual([1, 2]);
			expect(await store.listRunIds()).toEqual(["r1", "r2"]);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("rolls back a partly written batch so the next append can start", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append("r1", [body.runCreated("r1")], 0);
			const raw = new DatabaseSync(join(dataDir, "payo.db"));
			raw.exec(
				"CREATE TRIGGER fail_seq3 BEFORE INSERT ON events WHEN NEW.seq = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END",
			);
			raw.close();

			await expect(
				store.append("r1", [body.stepStarted("s1"), body.stepStarted("s2")], 1),
			).rejects.toThrow(/boom/);
			expect((await store.read("r1")).map((e) => e.seq)).toEqual([1]);

			const drop = new DatabaseSync(join(dataDir, "payo.db"));
			drop.exec("DROP TRIGGER fail_seq3");
			drop.close();
			await store.append("r1", [body.stepStarted("s2")], 1);

			expect((await store.read("r1")).map((e) => e.seq)).toEqual([1, 2]);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("accepts the correct seq after a stale append is rejected", async () => {
		const dataDir = tempDir();
		try {
			const store = await createSqliteRunStore({ dataDir });
			await store.append("r1", [body.runCreated("r1")], 0);

			await expect(
				store.append("r1", [body.stepStarted("s1")], 0),
			).rejects.toBeInstanceOf(StaleSeqError);
			await store.append("r1", [body.stepStarted("s2")], 1);

			expect((await store.read("r1")).map((e) => e.seq)).toEqual([1, 2]);
			await store.close();
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("waits for a writer in another process, then reports StaleSeqError", async () => {
		const dataDir = tempDir();
		let store: RunStore | undefined;
		try {
			store = await createSqliteRunStore({ dataDir });
			const writer = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(join(dataDir, "payo.db"))});
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO events (run_id, seq, at, body) VALUES ('r1', 1, 'x', '{}')");
console.log("locked");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
db.exec("COMMIT");
db.close();
`;
			const child = spawn(process.execPath, ["-e", writer], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			const exited = once(child, "exit");
			try {
				await Promise.race([
					once(child.stdout, "data"),
					exited.then(([code]) => {
						throw new Error(`writer exited before locking (code ${code})`);
					}),
				]);

				await expect(
					store.append("r1", [body.runCreated("r1")], 0),
				).rejects.toMatchObject({ expected: 0, actual: 1 });
			} finally {
				await exited;
			}
		} finally {
			await store?.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});

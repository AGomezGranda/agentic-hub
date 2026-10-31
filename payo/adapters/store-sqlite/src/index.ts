import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type ArtifactRef,
	ArtifactRef as ArtifactRefSchema,
	type RunEvent,
	RunEventBody,
} from "@payo/contracts";
import {
	assertSha256,
	type RunStore,
	StaleSeqError,
	sha256Hex,
} from "@payo/kernel";

const SCHEMA_VERSION = 1;

function unsupportedSchemaVersion(version: number): Error {
	return new Error(
		`unsupported payo.db schema version ${version} (expected ${SCHEMA_VERSION})`,
	);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	at TEXT NOT NULL,
	body TEXT NOT NULL,
	PRIMARY KEY (run_id, seq)
)`;

/** Opens or creates the store under `dataDir`. Artifacts live in `<dataDir>/artifacts/`. */
export async function createSqliteRunStore(options: {
	dataDir: string;
}): Promise<RunStore> {
	const artifactsDir = join(options.dataDir, "artifacts");
	mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
	mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		chmodSync(options.dataDir, 0o700);
		chmodSync(artifactsDir, 0o700);
	}
	const dbPath = join(options.dataDir, "payo.db");
	// Create the db owner-only before SQLite opens it, and correct an existing file's mode.
	closeSync(openSync(dbPath, "a", 0o600));
	if (process.platform !== "win32") chmodSync(dbPath, 0o600);
	// Wait for a writer in another process; without this a contended write fails at once with SQLITE_BUSY, not StaleSeqError.
	const db = new DatabaseSync(dbPath, {
		timeout: 5000,
	});
	try {
		// Refuse an unknown version before WAL is set, so a refused file keeps its journal mode.
		const before = (
			db.prepare("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		if (before !== 0 && before !== SCHEMA_VERSION) {
			throw unsupportedSchemaVersion(before);
		}
		db.exec("PRAGMA journal_mode = WAL");
		// Schema creation and the version check share one transaction, so a crash cannot leave a half-made file.
		db.exec("BEGIN IMMEDIATE");
		const version = (
			db.prepare("PRAGMA user_version").get() as { user_version: number }
		).user_version;
		if (version === 0) {
			db.exec(SCHEMA);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		} else if (version !== SCHEMA_VERSION) {
			throw unsupportedSchemaVersion(version);
		}
		db.exec("COMMIT");
	} catch (error) {
		db.close();
		throw error;
	}

	const artifactPath = (sha256: string) => join(artifactsDir, sha256);

	return {
		async append(runId, events, expectedSeq) {
			if (events.length === 0) return;
			// Parse everything before the transaction opens: a bad row writes nothing.
			const bodies = events.map((body) => RunEventBody.parse(body));
			db.exec("BEGIN IMMEDIATE");
			try {
				const actual = (
					db
						.prepare(
							"SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?",
						)
						.get(runId) as { seq: number }
				).seq;
				if (actual !== expectedSeq)
					throw new StaleSeqError(expectedSeq, actual);
				const insert = db.prepare(
					"INSERT INTO events (run_id, seq, at, body) VALUES (?, ?, ?, ?)",
				);
				bodies.forEach((body, i) => {
					insert.run(
						runId,
						expectedSeq + i + 1,
						new Date().toISOString(),
						JSON.stringify(body),
					);
				});
				db.exec("COMMIT");
			} catch (error) {
				// A failed write may already have rolled back (e.g. SQLITE_FULL); a second ROLLBACK would mask the original error.
				if (db.isTransaction) db.exec("ROLLBACK");
				throw error;
			}
		},

		async listRunIds() {
			const rows = db
				.prepare("SELECT DISTINCT run_id FROM events ORDER BY run_id")
				.all() as { run_id: string }[];
			return rows.map((row) => row.run_id);
		},

		async read(runId, fromSeq = 1) {
			const rows = db
				.prepare(
					"SELECT seq, at, body FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq",
				)
				.all(runId, fromSeq) as { seq: number; at: string; body: string }[];
			return rows.map((row): RunEvent => {
				try {
					return {
						...RunEventBody.parse(JSON.parse(row.body)),
						seq: row.seq,
						at: row.at,
					};
				} catch (cause) {
					throw new Error(`corrupt event ${runId} seq ${row.seq}`, { cause });
				}
			});
		},

		async putArtifact(content, meta): Promise<ArtifactRef> {
			const sha256 = sha256Hex(content);
			// Parse metadata before any file is written: invalid metadata leaves no artifact.
			const ref = ArtifactRefSchema.parse({
				sha256,
				size: content.byteLength,
				kind: meta.kind,
				mediaType: meta.mediaType,
			});
			const final = artifactPath(sha256);
			if (!existsSync(final)) {
				const tmp = `${final}.tmp-${randomBytes(8).toString("hex")}`;
				const fd = openSync(tmp, "wx", 0o600);
				try {
					try {
						writeFileSync(fd, content);
						fsyncSync(fd);
					} finally {
						closeSync(fd);
					}
					renameSync(tmp, final);
				} catch (error) {
					rmSync(tmp, { force: true });
					throw error;
				}
				const dirFd = openSync(artifactsDir, "r");
				try {
					fsyncSync(dirFd);
				} finally {
					closeSync(dirFd);
				}
			}
			return ref;
		},

		async readArtifact(sha256) {
			assertSha256(sha256);
			let bytes: Buffer;
			try {
				bytes = readFileSync(artifactPath(sha256));
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
				throw new Error(`artifact ${sha256} not found`, { cause });
			}
			const actual = sha256Hex(bytes);
			if (actual !== sha256) {
				throw new Error(
					`artifact integrity check failed: expected ${sha256}, content hashes to ${actual}`,
				);
			}
			return bytes;
		},

		async close() {
			db.close();
		},
	};
}

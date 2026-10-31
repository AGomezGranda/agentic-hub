import { createHash } from "node:crypto";
import {
	type ArtifactRef,
	ArtifactRef as ArtifactRefSchema,
	type RunEvent,
	RunEventBody,
	Sha256,
} from "@payo/contracts";

export interface RunStore {
	/** Appends bodies after `expectedSeq`; the store assigns `seq` and `at`. An empty batch is a no-op. */
	append(
		runId: string,
		events: RunEventBody[],
		expectedSeq: number,
	): Promise<void>;
	/** Events with `seq >= fromSeq`, in seq order. */
	read(runId: string, fromSeq?: number): Promise<RunEvent[]>;
	/** Every run with at least one event, in deterministic ascending ID order. */
	listRunIds(): Promise<string[]>;
	putArtifact(
		content: Uint8Array,
		meta: { kind: string; mediaType: string },
	): Promise<ArtifactRef>;
	readArtifact(sha256: string): Promise<Uint8Array>;
	close(): Promise<void>;
}

export class StaleSeqError extends Error {
	readonly expected: number;
	readonly actual: number;

	constructor(expected: number, actual: number) {
		super(`expected seq ${expected} but the log is at ${actual}`);
		this.name = "StaleSeqError";
		this.expected = expected;
		this.actual = actual;
	}
}

export function sha256Hex(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Rejects anything that is not a lowercase sha256, before it can name a file. */
export function assertSha256(name: string): void {
	if (!Sha256.safeParse(name).success) {
		throw new Error(`not a sha256 artifact name: ${JSON.stringify(name)}`);
	}
}

export interface MemoryBacking {
	events: Map<string, RunEvent[]>;
	artifacts: Map<string, Uint8Array>;
}

export function createMemoryRunStore(
	backing: MemoryBacking = { events: new Map(), artifacts: new Map() },
): RunStore {
	return {
		async append(runId, events, expectedSeq) {
			if (events.length === 0) return;
			const parsed = events.map((body) => RunEventBody.parse(body));
			// Yield like real I/O, so concurrent appends interleave and the contract race is real.
			await Promise.resolve();
			const log = backing.events.get(runId) ?? [];
			const actual = log.at(-1)?.seq ?? 0;
			if (actual !== expectedSeq) throw new StaleSeqError(expectedSeq, actual);
			const at = new Date().toISOString();
			// JSON round-trip copies the caller's data, so stored rows are independent of the caller's objects.
			const rows = parsed.map(
				(body, i) =>
					JSON.parse(
						JSON.stringify({ ...body, seq: expectedSeq + i + 1, at }),
					) as RunEvent,
			);
			backing.events.set(runId, [...log, ...rows]);
		},

		async read(runId, fromSeq = 1) {
			return (backing.events.get(runId) ?? [])
				.filter((event) => event.seq >= fromSeq)
				.map((event) => structuredClone(event));
		},

		async listRunIds() {
			return [...backing.events.keys()].sort();
		},

		async putArtifact(content, meta) {
			// Validate before storing, so rejected metadata leaves no readable bytes behind.
			const ref = ArtifactRefSchema.parse({
				sha256: sha256Hex(content),
				size: content.byteLength,
				kind: meta.kind,
				mediaType: meta.mediaType,
			});
			if (!backing.artifacts.has(ref.sha256))
				backing.artifacts.set(ref.sha256, new Uint8Array(content));
			return ref;
		},

		async readArtifact(sha256) {
			assertSha256(sha256);
			const bytes = backing.artifacts.get(sha256);
			if (!bytes) throw new Error(`artifact ${sha256} not found`);
			return new Uint8Array(bytes);
		},

		async close() {},
	};
}
